// The loopback RPC checkpoint: the only Solana RPC endpoint a downstream sees.
//
// Every downstream receives `http://127.0.0.1:<port>/s/<server>` as its RPC
// URL (SPEC §5.1, §5.7). Reads go upstream untouched. `sendTransaction` is the
// one method that moves money, so it stops here: it is decoded and handed to
// `onSend` (the pipeline: review, hold, human approval), and it goes upstream
// only if `onSend` resolves to exactly `{ forward: true }`. Every other
// outcome (a refusal, a throw, a malformed answer, an undecodable
// transaction, a shut-down checkpoint) is a refusal (I2, I7).
//
// Design notes for the parts that are easy to get subtly wrong:
//
//  * What goes upstream is JSON.stringify of the request Gate parsed, never
//    the client's raw bytes. Raw forwarding would open a parser differential:
//    `{"method":"sendTransaction",…,"method":"getBalance"}` reads as a harmless
//    getBalance to JSON.parse (last key wins) but as a send to any upstream
//    parser where the first key wins. Re-serialising means the upstream reads
//    exactly the request that was checked. For the canonical JSON every
//    client library emits, the bytes are identical anyway.
//  * The upstream URL may embed an API key (I4). It never appears in a
//    response, a log line or a thrown error: upstream failures map to one
//    fixed message, and every output passes through a redactor built from the
//    URL itself.
//  * Loopback only (I11): both listeners bind 127.0.0.1 and refuse a foreign
//    `Host` (DNS rebinding) or `Origin` (a web page posting to localhost).
//  * WebSocket subscriptions get a raw byte tunnel on port + 1, because
//    web3.js derives its ws URL that way and needs it for confirmTransaction.
//    PubSub cannot send a transaction, so the tunnel parses no frames: it
//    rewrites the request line and Host, then pipes bytes both ways.
import { createServer } from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { redactSensitive } from '../mcp/session.mjs';
import { decode } from '../solana/base58.mjs';

/** JSON-RPC error codes this checkpoint emits (SPEC §5.7). */
export const RPC_SEND_REFUSED = -32099;
export const RPC_METHOD_DENIED = -32098;
export const RPC_UPSTREAM_FAILED = -32097;

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_TX_CHARS = 4096;
const TUNNEL_CONNECT_TIMEOUT_MS = 15000;
const SERVER_PATH = /^\/s\/([a-z0-9-]{1,16})$/;
const PREFIX = 'SolFrontier Gate: ';
const UPSTREAM_FAILED_MESSAGE = `${PREFIX}upstream RPC unavailable`;

/**
 * Start the checkpoint: JSON-RPC proxy on `127.0.0.1:port`, WebSocket tunnel
 * on `127.0.0.1:port + 1`. Rejects (with `code`, e.g. EADDRINUSE, and `port`)
 * if either cannot bind; nothing is left listening in that case.
 *
 * @param {object}   opts
 * @param {string}   opts.upstreamUrl    real http(s) RPC URL; may carry an API key, never echoed
 * @param {string}   [opts.upstreamWsUrl] real ws(s) URL; default derived https→wss, http→ws
 * @param {number}   opts.port           HTTP port; the tunnel takes port + 1
 * @param {(bytes: Uint8Array, meta: object) => Promise<object>} opts.onSend
 *        decides each sendTransaction. `meta` = `{ encoding, params, requestId,
 *        server, signal }`: `server` is the `/s/<server>` name or null for
 *        `/`; `signal` aborts when the client hangs up or the checkpoint
 *        closes, so a hold nobody waits for can be cancelled (I7). Resolve
 *        `{ forward: true }` to send, or `{ forward: false, message, data }`
 *        to refuse with -32099. The checkpoint forwards iff the answer is
 *        exactly `{ forward: true }`, even if the client has gone by then:
 *        the caller decides (and logs, I6), so check `signal.aborted` last.
 * @param {string[]} [opts.deniedMethods] refused with -32098
 * @param {number}   [opts.upstreamTimeoutMs] per upstream request
 * @param {(line: string) => void} [opts.logger] diagnostics (already redacted); never stdout
 * @returns {Promise<{ url: string, wsUrl: string, close: () => Promise<void> }>}
 */
export async function startRpcCheckpoint({
  upstreamUrl,
  upstreamWsUrl,
  port,
  onSend,
  deniedMethods = ['sendBundle'],
  upstreamTimeoutMs = 30000,
  logger = () => {},
} = {}) {
  if (typeof onSend !== 'function') throw new TypeError('rpc checkpoint: onSend must be a function');
  // No value is echoed in these messages: a caller that swapped two arguments
  // would otherwise print its upstream URL.
  if (!Number.isInteger(port) || port < 1 || port > 65534) {
    throw new RangeError('rpc checkpoint: port must be an integer in 1..65534 (the WebSocket tunnel takes port + 1)');
  }
  if (!Array.isArray(deniedMethods) || deniedMethods.some((m) => typeof m !== 'string')) {
    throw new TypeError('rpc checkpoint: deniedMethods must be an array of method names');
  }
  const upstream = parseUrl(upstreamUrl, ['http:', 'https:'], 'upstreamUrl');
  // 'http://…' → 'ws://…', 'https://…' → 'wss://…'. An empty string (an
  // unset optional env var) means "not given".
  const upstreamWs = parseUrl(upstreamWsUrl || `ws${upstream.href.slice(4)}`, ['ws:', 'wss:'], 'upstreamWsUrl');
  // fetch() refuses a URL with credentials in it, so userinfo travels as a
  // Basic Authorization header instead, on both connections.
  const upstreamTarget = withoutUserinfo(upstream);
  const upstreamAuth = basicAuth(upstream);
  const upstreamWsAuth = basicAuth(upstreamWs);
  const denied = new Set(deniedMethods);
  const wsPort = port + 1;

  const scrubUpstream = buildRedactor([upstreamUrl, upstream.href, upstreamWsUrl, upstreamWs.href]);
  const scrubOut = (text) => redactSensitive(scrubUpstream(text));
  const log = (line) => {
    try { logger(scrubOut(line)); } catch { /* a broken logger must not break the proxy */ }
  };

  let closed = false;
  const lifetime = new AbortController();

  const http = createServer((req, res) => {
    handleHttp(req, res).catch((err) => {
      log(`rpc checkpoint: request failed: ${err?.message ?? err}`);
      res.destroy();
    });
  });

  async function handleHttp(req, res) {
    if (!hostAllowed(req, port) || !originAllowed(req, port)) return sendText(res, 403, 'forbidden');
    const pathname = req.url.split('?')[0];
    if (req.method === 'GET' && pathname === '/health') return sendText(res, 200, 'ok');
    let server = null;
    if (pathname !== '/') {
      const match = SERVER_PATH.exec(pathname);
      if (!match) return sendText(res, 404, 'not found');
      server = match[1];
    }
    if (req.method !== 'POST') return sendText(res, 405, 'method not allowed', { allow: 'POST' });

    const body = await readBody(req);
    if (body === null) {
      return sendJson(res, 413, generated(rpcError(null, -32600, `${PREFIX}request body exceeds 2 MB`)));
    }
    let payload;
    try {
      payload = JSON.parse(body.toString('utf8'));
    } catch {
      return sendJson(res, 200, generated(rpcError(null, -32700, `${PREFIX}parse error`)));
    }

    // Aborts when the client hangs up or the checkpoint closes; handed to
    // onSend so a hold nobody is waiting for can be cancelled (I7).
    const abort = new AbortController();
    const onLifetimeAbort = () => abort.abort();
    if (lifetime.signal.aborted) abort.abort();
    else lifetime.signal.addEventListener('abort', onLifetimeAbort, { once: true });
    res.on('close', () => {
      lifetime.signal.removeEventListener('abort', onLifetimeAbort);
      if (!res.writableFinished) abort.abort();
    });
    const ctx = { server, signal: abort.signal };

    const text = Array.isArray(payload) ? await answerBatch(payload, ctx) : await answerCall(payload, ctx);
    return sendJson(res, 200, text);
  }

  function classify(call) {
    if (!isPlainObject(call) || typeof call.method !== 'string') return 'invalid';
    if (call.method === 'sendTransaction') return 'send';
    // I1: no write method but sendTransaction. Beyond the configured list,
    // anything spelled like a send (`SendTransaction`, `sendRawTransaction`,
    // a provider's `sendBundle` variant) is refused rather than trusted to be
    // a read. No standard read method starts with "send".
    if (denied.has(call.method) || /^\s*send/i.test(call.method)) return 'denied';
    return 'read';
  }

  /** One JSON-RPC call → the JSON text of its response. */
  async function answerCall(call, ctx) {
    const id = idOf(call);
    switch (classify(call)) {
      case 'invalid':
        return generated(rpcError(id, -32600, `${PREFIX}invalid request`));
      case 'denied':
        return generated(rpcError(id, RPC_METHOD_DENIED, `${PREFIX}method ${JSON.stringify(call.method)} is not allowed`));
      case 'send':
        return answerSend(call, ctx);
      default: {
        const up = await postUpstream(JSON.stringify(jsonRpcMembers(call)));
        return up.ok ? up.text : upstreamFailure(id, up);
      }
    }
  }

  async function answerBatch(calls, ctx) {
    if (calls.length === 0) return generated(rpcError(null, -32600, `${PREFIX}empty batch`));
    // A batch of plain reads goes up as one request and comes back verbatim.
    if (calls.every((c) => classify(c) === 'read')) {
      const up = await postUpstream(JSON.stringify(calls.map(jsonRpcMembers)));
      if (up.ok) return up.text;
      return `[${calls.map((c) => upstreamFailure(idOf(c), up)).join(',')}]`;
    }
    // Otherwise one call at a time, in order: sends must be sequential, and a
    // read is not worth a second code path.
    const parts = [];
    for (const call of calls) parts.push(await answerCall(call, ctx));
    return `[${parts.join(',')}]`;
  }

  async function answerSend(call, ctx) {
    const id = idOf(call);
    const decoded = decodeSendParams(call.params);
    if (decoded.error) {
      return generated(rpcError(id, -32602, `${PREFIX}${decoded.error}`, { code: 'tx_decode_failed' }));
    }
    if (closed || ctx.signal.aborted) return generated(refusal(id, 'request cancelled', { code: 'cancelled' }));
    // Serialised before onSend runs, so what goes upstream is fixed by what
    // was decoded, whatever onSend does with the objects it is handed.
    const forwardBody = JSON.stringify(jsonRpcMembers(call));
    let verdict;
    try {
      verdict = await onSend(decoded.bytes, {
        encoding: decoded.encoding,
        params: structuredClone(call.params),
        requestId: id,
        server: ctx.server,
        signal: ctx.signal,
      });
    } catch (err) {
      log(`rpc checkpoint: onSend threw (${err?.message ?? err}); send refused`);
      return generated(refusal(id, 'transaction refused (checkpoint error)', { code: 'checkpoint_error' }));
    }
    // Exactly `true`: a truthy string, a 1 or a missing answer is a refusal.
    if (verdict?.forward !== true) {
      const message = typeof verdict?.message === 'string' && verdict.message ? verdict.message : 'transaction refused';
      return generated(refusal(id, message, verdict?.data));
    }
    // A hold can outlive the checkpoint; nothing goes up after close().
    if (closed) return generated(refusal(id, 'checkpoint closed', { code: 'cancelled' }));
    const up = await postUpstream(forwardBody);
    return up.ok ? up.text : upstreamFailure(id, up);
  }

  function upstreamFailure(id, up) {
    log(`rpc checkpoint: upstream ${up.reason}${up.status ? ` (HTTP ${up.status})` : ''}`);
    const data = { code: 'rpc_unavailable', reason: up.reason };
    if (up.status) data.status = up.status;
    return generated(rpcError(id, RPC_UPSTREAM_FAILED, UPSTREAM_FAILED_MESSAGE, data));
  }

  /**
   * POST a JSON text upstream. Resolves `{ ok: true, text }` with the body
   * as received (redacted only if it echoes the URL) or `{ ok: false, reason }`.
   * Never throws, never reports the error itself: an undici error can carry
   * the address it failed to reach.
   */
  async function postUpstream(bodyText) {
    if (closed) return { ok: false, reason: 'closed' };
    const abort = new AbortController();
    const onLifetimeAbort = () => abort.abort();
    lifetime.signal.addEventListener('abort', onLifetimeAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; abort.abort(); }, upstreamTimeoutMs);
    try {
      let response;
      try {
        const headers = { 'content-type': 'application/json' };
        if (upstreamAuth) headers.authorization = upstreamAuth;
        response = await fetch(upstreamTarget, {
          method: 'POST',
          headers,
          body: bodyText,
          // A redirect is a failure, not an instruction: following it would
          // post a transaction to a host nobody configured.
          redirect: 'manual',
          signal: abort.signal,
        });
      } catch {
        return { ok: false, reason: timedOut ? 'timeout' : 'network' };
      }
      if (response.status < 200 || response.status > 299) {
        response.body?.cancel().catch(() => {});
        return { ok: false, reason: 'http', status: response.status };
      }
      let text;
      try {
        text = await response.text();
      } catch {
        return { ok: false, reason: timedOut ? 'timeout' : 'network' };
      }
      try {
        JSON.parse(text);
      } catch {
        return { ok: false, reason: 'non_json' };
      }
      return { ok: true, text: scrubUpstream(text) };
    } finally {
      clearTimeout(timer);
      lifetime.signal.removeEventListener('abort', onLifetimeAbort);
    }
  }

  /** Serialise a response Gate itself wrote, then redact it (I4). */
  function generated(obj) {
    let text;
    try {
      text = JSON.stringify(obj);
    } catch {
      // `data` from a caller may hold a BigInt or a cycle; drop it, keep the refusal.
      const { data, ...error } = obj.error;
      text = JSON.stringify({ ...obj, error });
    }
    return scrubOut(text);
  }

  // --- WebSocket tunnel ---------------------------------------------------

  // Upgraded sockets leave the HTTP server's bookkeeping, so close() needs
  // its own list to free the port.
  const tunnelSockets = new Set();
  const track = (socket) => {
    tunnelSockets.add(socket);
    socket.once('close', () => tunnelSockets.delete(socket));
  };

  const tunnel = createServer((req, res) => sendText(res, 426, 'upgrade required', { upgrade: 'websocket' }));
  tunnel.on('upgrade', (req, client, head) => {
    track(client);
    client.on('error', () => {});
    if (closed) return refuseUpgrade(client, 503, 'Service Unavailable');
    if (!hostAllowed(req, wsPort) || !originAllowed(req, wsPort)) return refuseUpgrade(client, 403, 'Forbidden');
    const pathname = req.url.split('?')[0];
    if (pathname !== '/' && !SERVER_PATH.test(pathname)) return refuseUpgrade(client, 404, 'Not Found');
    if (req.method !== 'GET' || String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket') {
      return refuseUpgrade(client, 400, 'Bad Request');
    }
    openTunnel(req, client, head);
  });

  function openTunnel(req, client, head) {
    const secure = upstreamWs.protocol === 'wss:';
    const host = upstreamWs.hostname.replace(/^\[(.*)\]$/, '$1');
    const upstreamPort = Number(upstreamWs.port) || (secure ? 443 : 80);
    const upstreamSocket = secure
      ? tls.connect({ host, port: upstreamPort, servername: net.isIP(host) ? undefined : host })
      : net.connect({ host, port: upstreamPort });
    track(upstreamSocket);
    let connected = false;
    const teardown = () => {
      client.destroy();
      upstreamSocket.destroy();
    };
    upstreamSocket.setTimeout(TUNNEL_CONNECT_TIMEOUT_MS, () => {
      log('rpc checkpoint: tunnel upstream connect timed out');
      upstreamSocket.destroy();
    });
    upstreamSocket.once(secure ? 'secureConnect' : 'connect', () => {
      connected = true;
      upstreamSocket.setTimeout(0);
      upstreamSocket.write(upgradeRequest(req));
      if (head?.length) upstreamSocket.write(head);
      upstreamSocket.pipe(client);
      client.pipe(upstreamSocket);
    });
    // The error itself is not logged: it can name the host it failed to reach.
    upstreamSocket.on('error', (err) => log(`rpc checkpoint: tunnel upstream failed (${err?.code ?? 'error'})`));
    upstreamSocket.on('close', () => {
      if (connected) teardown();
      else refuseUpgrade(client, 502, 'Bad Gateway');
    });
    client.on('close', teardown);
  }

  /** The client's upgrade request, re-addressed to the upstream's path and Host. */
  function upgradeRequest(req) {
    const lines = [`GET ${upstreamWs.pathname}${upstreamWs.search} HTTP/1.1`, `Host: ${upstreamWs.host}`];
    if (upstreamWsAuth) lines.push(`Authorization: ${upstreamWsAuth}`);
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      // Host is rewritten; an Origin, if any, was ours and means nothing
      // upstream; upstream credentials are Gate's to supply, not the client's.
      if (/^(host|origin|authorization)$/i.test(req.rawHeaders[i])) continue;
      lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    }
    return `${lines.join('\r\n')}\r\n\r\n`;
  }

  // --- lifecycle -------------------------------------------------------------

  try {
    await listen(http, port);
  } catch (err) {
    throw bindError(err, port);
  }
  try {
    await listen(tunnel, wsPort);
  } catch (err) {
    await closeServer(http);
    throw bindError(err, wsPort);
  }

  let closing = null;
  return {
    url: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${wsPort}`,
    /** Stop both listeners, drop every connection and tunnel; nothing is forwarded after this. */
    close() {
      if (closing) return closing;
      closed = true;
      lifetime.abort();
      for (const socket of tunnelSockets) socket.destroy();
      closing = Promise.all([closeServer(http), closeServer(tunnel)]).then(() => {});
      return closing;
    },
  };
}

// ---------------------------------------------------------------------------
// helpers (pure, or close to it)

function parseUrl(value, protocols, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    // Not `err.message`/`cause`: Node's ERR_INVALID_URL carries the input.
    throw new TypeError(`rpc checkpoint: ${label} is not a valid URL`);
  }
  if (!protocols.includes(url.protocol)) {
    throw new TypeError(`rpc checkpoint: ${label} must use ${protocols.join(' or ')}`);
  }
  return url;
}

function withoutUserinfo(url) {
  const copy = new URL(url.href);
  copy.username = '';
  copy.password = '';
  return copy.href;
}

function basicAuth(url) {
  if (!url.username && !url.password) return null;
  let pair;
  try {
    pair = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
  } catch {
    throw new TypeError('rpc checkpoint: upstream URL credentials are not valid percent-encoding');
  }
  return `Basic ${Buffer.from(pair, 'utf8').toString('base64')}`;
}

/**
 * Text → text with every fragment of the given URLs that could carry a
 * credential replaced. Covers the whole URL in its spellings, and the parts
 * providers put keys in: query string and its values, path, userinfo.
 */
export function buildRedactor(urls) {
  const fragments = new Set();
  for (const raw of urls) {
    if (typeof raw !== 'string' || !raw) continue;
    fragments.add(raw);
    let url;
    try { url = new URL(raw); } catch { continue; }
    fragments.add(url.href);
    fragments.add(url.href.replace(/\/$/, ''));
    fragments.add(`${url.host}${url.pathname}${url.search}`);
    if (url.search.length > 1) fragments.add(url.search.slice(1));
    for (const value of url.searchParams.values()) fragments.add(value);
    if (url.pathname.length > 1) fragments.add(url.pathname);
    for (const segment of url.pathname.split('/')) fragments.add(segment);
    fragments.add(url.username);
    fragments.add(url.password);
  }
  // Longest first, so a whole URL is replaced before its parts. Short
  // fragments are skipped: redacting "v2" or "rpc" would mangle honest text.
  const list = [...fragments].filter((f) => f.length >= 8).sort((a, b) => b.length - a.length);
  return (text) => {
    let out = String(text ?? '');
    for (const f of list) if (out.includes(f)) out = out.split(f).join('<upstream-redacted>');
    return out;
  };
}

function hostAllowed(req, port) {
  // Exactly one Host header naming this listener. Anything else is a request
  // that reached 127.0.0.1 under someone else's name (DNS rebinding).
  let count = 0;
  for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() === 'host') count += 1;
  if (count !== 1) return false;
  const host = String(req.headers.host).toLowerCase();
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

function originAllowed(req, port) {
  const origin = req.headers.origin;
  if (origin === undefined) return true; // non-browser clients send none
  const o = String(origin).toLowerCase();
  return o === `http://127.0.0.1:${port}` || o === `http://localhost:${port}`;
}

/** The request body, or null if it exceeds the limit (the rest is drained). */
async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size <= MAX_BODY_BYTES) chunks.push(chunk);
  }
  return size > MAX_BODY_BYTES ? null : Buffer.concat(chunks);
}

/**
 * sendTransaction params → `{ bytes, encoding }` or `{ error }`.
 *
 * Strict on purpose: the bytes onSend reviews must be exactly the bytes the
 * upstream decodes from the same string. Node's base64 decoder skips junk
 * characters and accepts URL-safe and unpadded input; the upstream's does
 * not. So base64 must round-trip to itself, and anything but `base58` /
 * `base64` (including the RPC's deprecated `binary` alias) is refused rather
 * than guessed at.
 */
export function decodeSendParams(params) {
  if (!Array.isArray(params) || params.length < 1 || params.length > 2) {
    return { error: 'sendTransaction expects params [transaction, config?]' };
  }
  const [tx, config] = params;
  if (config !== undefined && config !== null && !isPlainObject(config)) {
    return { error: 'sendTransaction config must be an object' };
  }
  const encoding = config?.encoding ?? 'base58';
  if (encoding !== 'base58' && encoding !== 'base64') {
    return { error: 'sendTransaction encoding must be base58 or base64' };
  }
  if (typeof tx !== 'string' || tx.length === 0) return { error: 'transaction must be a non-empty string' };
  // Today's limit is 1232 bytes (1683 base58 / 1644 base64 characters). The
  // cap leaves room for larger transactions while keeping a 2 MB string out
  // of the quadratic base58 decoder.
  if (tx.length > MAX_TX_CHARS) return { error: 'transaction is too long' };
  let bytes;
  try {
    bytes = encoding === 'base64' ? decodeBase64Strict(tx) : decode(tx);
  } catch {
    return { error: `transaction is not valid ${encoding}` };
  }
  if (!bytes || bytes.length === 0) return { error: `transaction is not valid ${encoding}` };
  return { bytes, encoding };
}

function decodeBase64Strict(text) {
  const buf = Buffer.from(text, 'base64');
  return buf.toString('base64') === text ? Uint8Array.from(buf) : null;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// What goes upstream: the JSON-RPC members and nothing else, in the client's
// order (so a canonical request keeps its exact bytes). An extra member such
// as "METHOD" or "Params" could mean something to a lenient upstream parser
// that it did not mean to the checks here.
const JSON_RPC_MEMBERS = new Set(['jsonrpc', 'id', 'method', 'params']);

function jsonRpcMembers(call) {
  return Object.fromEntries(Object.entries(call).filter(([key]) => JSON_RPC_MEMBERS.has(key)));
}

function idOf(call) {
  return isPlainObject(call) && call.id !== undefined ? call.id : null;
}

function refusal(id, message, data) {
  return rpcError(id, RPC_SEND_REFUSED, `${PREFIX}${message}`, data);
}

function rpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

function sendJson(res, status, text) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(text);
}

function sendText(res, status, text, headers = {}) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(text);
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => { server.off('listening', onListening); reject(err); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ port, host: '127.0.0.1' });
  });
}

function refuseUpgrade(socket, status, reason) {
  if (socket.destroyed || socket.writableEnded) return;
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  // Do not wait forever for a client that never closes its side.
  socket.setTimeout(2000, () => socket.destroy());
}

function bindError(err, port) {
  // `code` stays machine-readable (callers retry on EADDRINUSE; gate run
  // exits 2 naming the port).
  const e = new Error(`rpc checkpoint cannot listen on 127.0.0.1:${port}: ${err?.code ?? 'listen failed'}`);
  e.code = err?.code;
  e.port = port;
  return e;
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
    // Keep-alive and in-flight connections would otherwise hold the port.
    server.closeAllConnections();
  });
}
