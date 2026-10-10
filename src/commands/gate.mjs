// sfcli gate run <config.json> — SolFrontier Gate.
//
// Order is the point (same rule as src/index.mjs): load and validate the
// config, check the environment, load the petty-cash key, verify the audit
// chain — and only then spawn anything. Every one of those failures is an
// exit 2 with nothing started.
//
// stdout belongs to the MCP protocol for the whole life of this command
// (I10). Every human-readable line goes to stderr through `log`, redacted.
//
// Every tools/call and intercepted RPC send follows the shared pipeline:
// policy -> review -> exact-message approval -> effect, logging each decision.
import process from 'node:process';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { UsageError } from '../cli/exit-codes.mjs';
import { redactSensitive } from '../mcp/session.mjs';
import { loadGateConfig, resolveUpstream, loadPettyCash, createRedactor } from '../gate/config.mjs';
import { AuditLog } from '../gate/audit-log.mjs';
import { startDownstreams } from '../gate/downstreams.mjs';
import { createHostServer, LIST_TOOLS_WAIT_MS } from '../gate/host-server.mjs';
import { compileToolPolicy, refusal, listedTool, policySummary } from '../gate/tool-policy.mjs';
import { compileTxPolicy } from '../gate/tx-policy.mjs';
import { createPipeline, summarizeResult } from '../gate/pipeline.mjs';
import { HoldQueue } from '../gate/holds.mjs';
import { startApprovalServer } from '../gate/approval-server.mjs';
import { startRpcCheckpoint } from '../gate/rpc-checkpoint.mjs';
import { SolanaRpc } from '../solana/rpc.mjs';

export { summarizeResult };

export const spec = {
  name: 'gate',
  summary: 'run SolFrontier Gate: a stdio MCP server guarding your Solana MCP servers',
  usage: 'gate run <config.json>',
  options: {},
  notes: [
    'stdout carries MCP JSON-RPC only; logs go to stderr.',
    'The config names environment variables; it never holds an RPC URL or a key.',
    'See examples/sfgate.devnet.example.json.',
  ],
};

export const GATE_STATUS_TOOL = {
  name: 'gate__status',
  description:
    'SolFrontier Gate status (read-only): cluster, petty-cash wallet public key, pending holds, downstream health, policy summary.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

/** Kept for callers of the T1 name; `refusal()` in tool-policy.mjs is the implementation. */
export const gateRefusal = refusal;

/**
 * The gate handlers: list = policy-visible downstream tools + gate__status;
 * call = pipeline policy/review/approval (SPEC §5.9, I1, I6).
 * Exported for callers of the original T1 interface. `policy` defaults to the
 * config's own compiled tool policy.
 */
export function createDefaultHandlers({ config, downstreams, audit, pettyCash, policy = compileToolPolicy(config),
  pipeline = createPipeline({ config, getDownstreams: () => downstreams, audit, pettyCash, policy,
    holds: new HoldQueue({ approver: config.approver }) }), approvalUrl = null }) {
  async function waitReady() {
    let timer;
    await Promise.race([
      downstreams.ready,
      new Promise((resolve) => {
        timer = setTimeout(resolve, LIST_TOOLS_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
  }

  function status() {
    return {
      gate: 'solfrontier-gate',
      cluster: config.cluster,
      wallet: pettyCash?.publicKey ?? null,
      pendingHolds: pipeline.pendingHolds(),
      approvalUrl,
      downstreams: downstreams.status(),
      policy: policySummary(policy),
    };
  }

  return {
    async listTools() {
      await waitReady();
      const offered = downstreams.list();
      const tools = [];
      for (const { server, tool, ...descriptor } of offered) {
        const listed = listedTool(policy, { server, tool, descriptor });
        if (listed) tools.push(listed);
      }
      const hidden = offered.length - tools.length;
      tools.push(GATE_STATUS_TOOL);
      audit.append('tool_list', { count: tools.length, tools: tools.map((t) => t.name), hidden });
      return tools;
    },

    async callTool({ name, args, requestId, signal }) {
      const callId = randomBytes(6).toString('hex');
      if (name === GATE_STATUS_TOOL.name) {
        audit.append('tool_call', { callId, requestId, tool: name, decision: 'pass', rule: 'gate' });
        const body = status();
        return { content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: body, isError: false };
      }
      return pipeline.onToolCall({ name, args, requestId, signal });
    },
  };
}

export async function run({ positionals = [], env = process.env, verbose = false }) {
  const [, sub, configPath, ...extra] = positionals;
  if (sub !== 'run' || !configPath || extra.length) {
    throw new UsageError(`usage: sfcli ${spec.usage}`);
  }

  // Everything below up to startDownstreams can fail with exit 2, and none of
  // it starts a process.
  const config = loadGateConfig(configPath, env);
  // Policy mistakes are config mistakes: exit 2 here, not a surprise at call time.
  const policy = compileToolPolicy(config);
  const upstream = resolveUpstream(config, env);
  const pettyCash = loadPettyCash(config, env);
  // Tool-only configurations have no intercepted transaction path and retain
  // their original no-wallet behavior. A configured money path is validated
  // before opening the audit log or any listener.
  const needsCheckpoint = Object.values(config.servers).some((s) => s.rpcVar);
  const needsApprovals = needsCheckpoint || Boolean(pettyCash && policy.rules.some((r) => r.txArg));
  const txPolicy = (needsApprovals && pettyCash) || Object.keys(config.tx).length
    ? compileTxPolicy(config.tx, config.lists) : null;
  const ownRedact = createRedactor([upstream.url, upstream.wsUrl, pettyCash?.secretKey]);
  const redact = (text) => ownRedact(redactSensitive(text, env));
  const log = (line) => process.stderr.write(`${redact(line)}\n`);

  const audit = AuditLog.open(config.audit.path, { redact });
  audit.append('gate_start', {
    pid: process.pid,
    cluster: config.cluster,
    servers: Object.keys(config.servers),
    wallet: pettyCash?.publicKey ?? null,
    approver: config.approver,
    // The policy in force, so the log says what every later decision was judged by.
    policy: policySummary(policy),
  });
  log(`[gate] cluster ${config.cluster}; audit log ${config.audit.path}; starting ${Object.keys(config.servers).length} downstream(s)`);

  const holds = new HoldQueue({ approver: config.approver });
  let approval;
  let checkpoint;
  let downstreams;
  let pipeline;
  let host;
  let reason = 'stdin closed';
  try {
    if (needsApprovals) {
      try {
        approval = await startApprovalServer({ holds, approver: config.approver,
          ...config.approval, cluster: config.cluster, logger: log });
      } catch (err) {
        throw new UsageError(`approval server cannot listen on 127.0.0.1:${config.approval.port}: ${err?.code ?? 'startup failed'}`);
      }
    }
    pipeline = createPipeline({ config, getDownstreams: () => downstreams, audit, pettyCash, policy,
      txPolicy, rpc: new SolanaRpc({ url: upstream.url }), holds, approvalUrl: approval?.url ?? null, log, redact });
    if (needsApprovals) {
      try {
        checkpoint = await startRpcCheckpoint({ upstreamUrl: upstream.url, upstreamWsUrl: upstream.wsUrl,
          port: config.rpcCheckpoint.port, onSend: pipeline.onRpcSend, logger: log });
      } catch (err) {
        throw new UsageError(`rpc checkpoint cannot listen on 127.0.0.1:${err?.port ?? config.rpcCheckpoint.port}: ${err?.code ?? 'startup failed'}`);
      }
    }
    downstreams = startDownstreams(config, { checkpointUrl: checkpoint?.url ?? null, pettyCash, audit, verbose, redact, log });
    const handlers = createDefaultHandlers({ config, downstreams, audit, pettyCash, policy, pipeline, approvalUrl: approval?.url ?? null });
    const version = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
    host = createHostServer({ input: process.stdin, output: process.stdout, handlers, version, redact, log });
    await host.closed;
  } catch (err) {
    reason = 'startup failed';
    throw err;
  } finally {
    host?.close();
    // Cancel holds before waiting for downstream calls to end. Their requests
    // may still be waiting at the checkpoint after MCP cancellation.
    holds.close();
    await downstreams?.close();
    await checkpoint?.close();
    await pipeline?.close();
    await approval?.close();
    audit.append('gate_stop', { reason });
    log('[gate] stopped');
  }
  return 0;
}
