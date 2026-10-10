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
// Every tools/call is decided by the tool policy (T2) before anything reaches
// a downstream: decide -> audit tool_call -> refusal | forward. Review (T4),
// checkpoint (T5) and holds (T6) plug in with I1; until then a call that
// carries a transaction is refused (approval_unavailable), never forwarded.
import process from 'node:process';
import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { UsageError } from '../cli/exit-codes.mjs';
import { redactSensitive } from '../mcp/session.mjs';
import { loadGateConfig, resolveUpstream, loadPettyCash, createRedactor } from '../gate/config.mjs';
import { AuditLog, scrubArgs } from '../gate/audit-log.mjs';
import { startDownstreams, splitToolName } from '../gate/downstreams.mjs';
import { createHostServer, LIST_TOOLS_WAIT_MS } from '../gate/host-server.mjs';
import { compileToolPolicy, decideTool, refusal, listedTool, policySummary } from '../gate/tool-policy.mjs';

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

// A Solana transaction signature: 64 bytes in base58 (86-88 characters).
const SIGNATURE_RE = /(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{86,88}(?![1-9A-HJ-NP-Za-km-z])/;

/** sha256 + isError + an extracted signature, if the result text carries one. */
export function summarizeResult(result) {
  const json = JSON.stringify(result ?? null);
  const text = (Array.isArray(result?.content) ? result.content : []).map((c) => (typeof c?.text === 'string' ? c.text : '')).join('\n');
  const structured = result?.structuredContent ? JSON.stringify(result.structuredContent) : '';
  const signature = (`${text}\n${structured}`.match(SIGNATURE_RE) ?? [null])[0];
  return {
    resultSha256: createHash('sha256').update(json).digest('hex'),
    isError: result?.isError === true,
    ...(signature ? { signature } : {}),
  };
}

/** Kept for callers of the T1 name; `refusal()` in tool-policy.mjs is the implementation. */
export const gateRefusal = refusal;

/**
 * The gate handlers: list = policy-visible downstream tools + gate__status;
 * call = decide -> audit tool_call -> refusal | forward (SPEC §5.3, I1, I6).
 * Exported so tests (and I1) can build on them. `policy` defaults to the
 * config's own compiled tool policy.
 */
export function createDefaultHandlers({ config, downstreams, audit, pettyCash, policy = compileToolPolicy(config), log = () => {} }) {
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
      pendingHolds: [],
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
      const parts = splitToolName(name);
      // Policy first: a refusal needs no downstream, so it never waits on one.
      const decision = decideTool(policy, { server: parts?.server ?? null, tool: parts?.tool ?? name, args });
      const record = { callId, requestId, tool: name, server: parts?.server ?? null, mode: decision.mode, rule: decision.rule };
      // I6: every decision is on disk before its effect, refusals included.
      const refuse = (code, { violations = [], hint, ...extra } = {}) => {
        audit.append('tool_call', { ...record, decision: 'deny', code, violations, ...extra, args: scrubArgs(args) });
        return refusal({ code, tool: name, rule: decision.rule, violations, hint });
      };

      if (decision.violations.length) {
        return refuse(decision.code, { violations: decision.violations, hint: decision.hint });
      }
      if (decision.txArg) {
        // I1 replaces this branch with review + hold. Until then nobody can
        // approve the transaction, so it is refused, never forwarded (I2, I7).
        return refuse('approval_unavailable', {
          txArg: decision.txArg.name,
          hint:
            `${name} carries a transaction in "${decision.txArg.name}" that needs a human approval, and this Gate ` +
            'build cannot take approvals yet. Do not retry; tell the user.',
        });
      }
      await waitReady();
      if (!parts || !downstreams.list().some((t) => t.name === name)) {
        return refuse('unknown_tool', { hint: `${name} is not offered by any running downstream. Call tools/list for the tools you may use.` });
      }
      audit.append('tool_call', { ...record, decision: decision.mode, args: scrubArgs(args) });
      let result;
      try {
        const server = config.servers[parts.server];
        result = await downstreams.call(parts.server, parts.tool, args, { signal, timeoutMs: server.timeoutMs });
      } catch (err) {
        if (signal?.aborted) {
          audit.append('tool_result', { callId, cancelled: true, isError: true });
          throw err;
        }
        const message = err?.message ?? String(err);
        audit.append('tool_result', { callId, isError: true, error: message });
        log(`[gate] ${name} failed: ${message}`);
        return refusal({ code: 'downstream_error', tool: name, rule: decision.rule, hint: 'the downstream server failed; see gate__status' });
      }
      audit.append('tool_result', { callId, ...summarizeResult(result) });
      return result;
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

  // checkpointUrl stays null until I1 wires T5: every downstream RPC call
  // goes to the discard-port placeholder and fails closed.
  const downstreams = startDownstreams(config, { checkpointUrl: null, pettyCash, audit, verbose, redact, log });
  const handlers = createDefaultHandlers({ config, downstreams, audit, pettyCash, policy, log });
  const version = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
  const host = createHostServer({ input: process.stdin, output: process.stdout, handlers, version, redact, log });

  await host.closed;
  await downstreams.close();
  audit.append('gate_stop', { reason: 'stdin closed' });
  log('[gate] stopped');
  return 0;
}
