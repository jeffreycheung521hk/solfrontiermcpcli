// The stdio MCP server the host (Claude Desktop, Claude Code, Cursor) talks to.
//
// Hand-written on purpose (I8): newline-delimited JSON-RPC over two streams
// is small enough to own completely, and owning it is what lets us promise
// I10 — the output stream carries frames and nothing else.
//
// Behaviour worth knowing:
//  * Requests run concurrently. A tools/call waiting on a human approval
//    must not block a ping or another call.
//  * notifications/cancelled aborts the matching request's AbortSignal, and
//    a cancelled request gets no response at all (the MCP rule).
//  * A malformed line is answered with -32700 and the server keeps going: a
//    host bug must not take the guard down with it.
//  * Every outgoing frame passes through `redact` (I4).
import { LineFramer } from '../mcp/framing.mjs';

export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const DEFAULT_PROTOCOL_VERSION = '2025-06-18';
export const LIST_TOOLS_WAIT_MS = 20000;

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const validId = (id) => typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));
const idKey = (id) => `${typeof id}:${id}`;

/**
 * @param {{ input: import('node:stream').Readable, output: import('node:stream').Writable,
 *           handlers: { listTools: () => Promise<object[]>, callTool: (req: object) => Promise<object> },
 *           version?: string, redact?: (t: string) => string, log?: (line: string) => void }} options
 * @returns {{ closed: Promise<void>, close: () => void, inFlight: () => number }}
 */
export function createHostServer({ input, output, handlers, version = '0.0.0', redact = (t) => t, log = () => {} }) {
  const framer = new LineFramer();
  const inflight = new Map(); // idKey -> AbortController
  let ended = false;
  let resolveClosed;
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });

  function send(message) {
    if (output.destroyed || output.writableEnded) return;
    // JSON escaping changes quotes, backslashes and control characters in a
    // URL. Scrub string values and object keys while they still match the
    // in-memory secrets; a downstream can echo a URL in either position.
    const text = JSON.stringify(message, (_key, value) => {
      if (typeof value === 'string') return redact(value);
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key), item]));
      }
      return value;
    });
    output.write(`${redact(text)}\n`);
  }

  const respond = (id, result) => send({ jsonrpc: '2.0', id, result });
  const respondError = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

  async function dispatch(method, params) {
    switch (method) {
      case 'initialize': {
        const requested = params?.protocolVersion;
        return {
          protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : DEFAULT_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'solfrontier-gate', version },
        };
      }
      case 'ping':
        return {};
      case 'tools/list':
        return { tools: await handlers.listTools() };
      case 'resources/list':
        return { resources: [] };
      case 'resources/templates/list':
        return { resourceTemplates: [] };
      case 'prompts/list':
        return { prompts: [] };
      default:
        throw new RpcError(METHOD_NOT_FOUND, `method not found: ${String(method).slice(0, 64)}`);
    }
  }

  function handleRequest(message) {
    const { id, method, params } = message;
    const key = idKey(id);
    if (inflight.has(key)) {
      respondError(id, INVALID_REQUEST, 'duplicate request id still in flight');
      return;
    }
    const controller = new AbortController();
    inflight.set(key, controller);

    const run = async () => {
      if (method === 'tools/call') {
        if (!isObject(params) || typeof params.name !== 'string' || !params.name) {
          throw new RpcError(INVALID_PARAMS, 'tools/call needs params.name');
        }
        const args = params.arguments ?? {};
        if (!isObject(args)) throw new RpcError(INVALID_PARAMS, 'tools/call params.arguments must be an object');
        return handlers.callTool({ name: params.name, args, requestId: id, signal: controller.signal });
      }
      return dispatch(method, params);
    };

    run().then(
      (result) => {
        if (!controller.signal.aborted) respond(id, result);
      },
      (err) => {
        if (controller.signal.aborted) return;
        if (err instanceof RpcError) {
          respondError(id, err.code, err.message);
        } else {
          log(redact(`[gate] ${method} failed: ${err?.message ?? err}`));
          respondError(id, INTERNAL_ERROR, redact(`internal error: ${err?.message ?? err}`));
        }
      },
    ).finally(() => {
      if (inflight.get(key) === controller) inflight.delete(key);
    });
  }

  function handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      respondError(null, PARSE_ERROR, 'parse error');
      return;
    }
    // Batches were removed from MCP (2025-06-18); refusing them is simpler
    // and safer than half-supporting them.
    if (!isObject(message)) {
      respondError(null, INVALID_REQUEST, Array.isArray(message) ? 'batch requests are not supported' : 'invalid request');
      return;
    }
    const hasId = message.id !== undefined && message.id !== null;
    if (typeof message.method !== 'string') {
      // A response from the host: Gate never sends requests, so ignore.
      if (hasId && ('result' in message || 'error' in message)) return;
      respondError(hasId && validId(message.id) ? message.id : null, INVALID_REQUEST, 'invalid request');
      return;
    }
    if (!hasId) {
      if (message.method === 'notifications/cancelled') {
        const target = message.params?.requestId;
        if (validId(target)) inflight.get(idKey(target))?.abort(new Error('cancelled by host'));
      }
      // notifications/initialized and any other notification: nothing to do.
      return;
    }
    if (!validId(message.id)) {
      respondError(null, INVALID_REQUEST, 'invalid request id');
      return;
    }
    handleRequest(message);
  }

  const onData = (chunk) => {
    for (const line of framer.push(chunk)) {
      try {
        handleLine(line);
      } catch (err) {
        log(redact(`[gate] host frame failed: ${err?.message ?? err}`));
      }
    }
  };
  const finish = () => {
    if (ended) return;
    ended = true;
    input.off('data', onData);
    // Nobody is left to read a response: cancel everything still running so
    // nothing proceeds on behalf of a host that is gone (I7).
    for (const controller of inflight.values()) controller.abort(new Error('host disconnected'));
    resolveClosed();
  };

  input.on('data', onData);
  input.once('end', finish);
  input.once('close', finish);
  input.once('error', finish);

  return {
    closed,
    close: finish,
    inFlight: () => inflight.size,
  };
}
