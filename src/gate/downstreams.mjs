// Downstream MCP servers: spawn, initialize, list, call (SPEC §5.1, I5).
//
// Each downstream is an McpSession whose environment is built here and
// nowhere else:
//
//   sanitizedChildEnv()  minus  /^SFGATE_/ and every variable the config names
//                        plus   the server's literal `env`, then rpcVar and walletVar
//
// Injections come last so a downstream's RPC URL is always Gate's checkpoint
// (or the discard-port placeholder), never something inherited.
//
// One downstream failing to start must not take the others down: it is
// recorded (`downstream_failed`), reported by status(), and its tools are
// simply absent.
import process from 'node:process';
import { McpSession } from '../mcp/session.mjs';
import { TransportError, TimeoutError } from '../cli/exit-codes.mjs';
import { GATE_DEFAULTS, walletValue } from './config.mjs';

export const STARTUP_TIMEOUT_MS = 20000;
const HOST_TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** The host-visible name for a downstream tool (SPEC §5.2). */
export const namespacedTool = (server, tool) => `${server}__${tool}`;

/**
 * Split a host-visible name back into server and tool. Server names cannot
 * contain `_`, so the first `__` is the separator.
 * @returns {{ server: string, tool: string } | null}
 */
export function splitToolName(name) {
  const i = String(name).indexOf('__');
  if (i <= 0) return null;
  return { server: name.slice(0, i), tool: name.slice(i + 2) };
}

/** Exact env injections for one server. Exported for tests. */
export function downstreamEnv(name, server, { checkpointUrl, pettyCash }) {
  const extraEnv = { ...server.env };
  if (server.rpcVar) {
    extraEnv[server.rpcVar] = checkpointUrl ? `${String(checkpointUrl).replace(/\/+$/, '')}/s/${name}` : GATE_DEFAULTS.placeholderRpcUrl;
  }
  if (server.walletVar) {
    // The config loader already refuses walletVar without pettyCash; this is
    // the second lock on the same door.
    if (!pettyCash) throw new TransportError(`downstream ${name} wants a wallet but no petty-cash key is loaded`);
    extraEnv[server.walletVar] = walletValue(pettyCash, server.walletFormat);
  }
  return extraEnv;
}

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new TimeoutError(`${what} did not start within ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Start every configured downstream. Returns at once; `ready` settles when
 * every server is either ready or failed (each bounded by startupTimeoutMs).
 * @param {object} config frozen gate config
 * @param {{ checkpointUrl?: string|null, pettyCash?: object|null, audit?: { append: Function },
 *           verbose?: boolean, redact?: (t: string) => string, log?: (line: string) => void,
 *           startupTimeoutMs?: number }} options
 */
export function startDownstreams(config, options = {}) {
  const {
    checkpointUrl = null,
    pettyCash = null,
    audit = null,
    verbose = false,
    redact = (t) => t,
    log = (line) => process.stderr.write(`${line}\n`),
    startupTimeoutMs = STARTUP_TIMEOUT_MS,
  } = options;
  const stripEnv = [/^SFGATE_/i, ...config.envNames];
  const entries = new Map();

  for (const [name, server] of Object.entries(config.servers)) {
    const entry = { name, state: 'starting', tools: [], error: null, session: null, skipped: [] };
    entries.set(name, entry);
    entry.promise = (async () => {
      try {
        entry.session = new McpSession({
          // Hosts launch Gate with a minimal PATH; `node` must mean this node.
          serverBin: server.command === 'node' ? process.execPath : server.command,
          serverArgs: server.args,
          appendDb: false,
          extraEnv: downstreamEnv(name, server, { checkpointUrl, pettyCash }),
          stripEnv,
          cwd: server.cwd,
          timeoutMs: server.timeoutMs,
          verbose,
          redact,
        });
        await withTimeout(
          (async () => {
            entry.session.start();
            await entry.session.initialize({ name: 'solfrontier-gate', version: '1.0.0' });
            return entry.session.listTools();
          })().then((tools) => {
            entry.rawTools = tools;
          }),
          startupTimeoutMs,
          `downstream ${name}`,
        );
        for (const tool of entry.rawTools ?? []) {
          const hostName = namespacedTool(name, tool?.name);
          if (typeof tool?.name !== 'string' || !HOST_TOOL_NAME_RE.test(hostName)) {
            entry.skipped.push(String(tool?.name).slice(0, 80));
            continue;
          }
          entry.tools.push({ ...tool, server: name, tool: tool.name, name: hostName });
        }
        if (entry.skipped.length) {
          log(redact(`[gate] ${name}: skipped ${entry.skipped.length} tool(s) whose names are not host-safe: ${entry.skipped.join(', ')}`));
        }
        entry.state = 'ready';
        audit?.append('downstream_ready', { server: name, tools: entry.tools.map((t) => t.tool), skipped: entry.skipped });
      } catch (err) {
        entry.state = 'failed';
        entry.error = redact(err?.message ?? String(err));
        // The stderr tail goes to the human (stderr) only: it is the server's
        // free text, so it never enters the audit log.
        audit?.append('downstream_failed', { server: name, error: entry.error });
        log(`[gate] downstream ${name} failed: ${entry.error}`);
        const tail = entry.session?.stderrTail || err?.details?.stderrTail;
        if (tail) for (const line of String(tail).split('\n').slice(-8)) log(redact(`[gate]   ${name}| ${line}`));
        await entry.session?.close().catch(() => {});
      }
    })();
  }

  const ready = Promise.all([...entries.values()].map((e) => e.promise)).then(() => undefined);

  function stateOf(entry) {
    if (entry.state === 'ready' && entry.session?.exitInfo) return 'exited';
    return entry.state;
  }

  return {
    ready,

    /** Every tool of every ready downstream, with host-visible names. */
    list() {
      const out = [];
      for (const entry of entries.values()) if (stateOf(entry) === 'ready') out.push(...entry.tools);
      return out;
    },

    /** Forward a call verbatim; returns the raw MCP result. */
    async call(server, tool, args, opts = {}) {
      const entry = entries.get(server);
      if (!entry || stateOf(entry) !== 'ready') {
        throw new TransportError(`downstream ${server} is not available (${entry ? stateOf(entry) : 'not configured'})`);
      }
      if (!entry.tools.some((t) => t.tool === tool)) {
        throw new TransportError(`downstream ${server} did not list a tool named ${tool}`);
      }
      return entry.session.callToolRaw(tool, args, opts);
    },

    status() {
      return [...entries.values()].map((e) => ({
        server: e.name,
        state: stateOf(e),
        tools: e.tools.length,
        ...(e.error ? { error: e.error } : {}),
      }));
    },

    async close() {
      await Promise.allSettled([...entries.values()].map((e) => e.promise));
      await Promise.allSettled([...entries.values()].map((e) => e.session?.close()));
    },
  };
}
