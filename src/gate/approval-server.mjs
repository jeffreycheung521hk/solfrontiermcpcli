// Loopback HTTP server for the approval page (SPEC §5.6, I3, I11).
//
// Only a person with the approver's wallet can approve: the server checks an
// Ed25519 signature over the hold's own approval message, and the hold queue
// checks it again. The server binds 127.0.0.1, answers only to its own Host
// and Origin (DNS rebinding and cross-site requests get 403), takes JSON only
// (a cross-site form cannot send application/json without a preflight we
// never answer), and sends the same CSP shape the SolFrontier signing page used
// with Phantom on mainnet. Any error leaves the hold pending: an approval that
// cannot be checked is not an approval (I7).
import { createServer } from 'node:http';
import { APP_JS, PAGE_HTML } from './approval-page.mjs';
import { CLUSTERS, HoldError, LOCAL_BUTTON_CLUSTERS, isBase58PublicKey, verifyApproval } from './holds.mjs';

export const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const SECURITY_HEADERS = Object.freeze({
  'content-security-policy': CSP,
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'cache-control': 'no-store',
});

const MAX_BODY_BYTES = 16 * 1024;
const HOLD_ROUTE = /^\/api\/holds\/([^/]+)(?:\/(approve|reject))?$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** JSON.stringify replacer: BigInt becomes a decimal string (defence in depth, SPEC §5.3). */
export function jsonReplacer(_key, value) {
  return typeof value === 'bigint' ? value.toString() : value;
}

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function makeLog(logger) {
  if (typeof logger === 'function') return (line) => logger(line);
  if (logger && typeof logger.info === 'function') return (line) => logger.info(line);
  return () => {};
}

/**
 * Start the approval server.
 *
 * Configuration errors throw synchronously (before anything listens); the
 * returned promise resolves once the server is listening.
 *
 * @param {object} options
 * @param {import('./holds.mjs').HoldQueue} options.holds
 * @param {string} options.approver   base58 pubkey of the human's wallet
 * @param {'wallet-signature'|'local-button'} [options.method]
 * @param {'devnet'|'mainnet-beta'|'localnet'} options.cluster
 * @param {number} [options.port]     8787 by default; 0 picks a free port
 * @param {Function|{info: Function}} [options.logger]  human-readable lines (stderr); never stdout
 * @returns {Promise<{ url: string, port: number, close: () => Promise<void> }>}
 */
export function startApprovalServer({ holds, approver, method = 'wallet-signature', cluster, port = 8787, logger } = {}) {
  if (!holds || typeof holds.approve !== 'function' || typeof holds.listPending !== 'function') {
    throw new TypeError('holds must be a HoldQueue');
  }
  if (method !== 'wallet-signature' && method !== 'local-button') {
    throw new TypeError(`unknown approval method: ${String(method).slice(0, 32)}`);
  }
  if (!CLUSTERS.includes(cluster)) throw new TypeError(`unknown cluster: ${String(cluster).slice(0, 32)}`);
  if (method === 'local-button' && !LOCAL_BUTTON_CLUSTERS.includes(cluster)) {
    throw new Error(`approval.method "local-button" is allowed only on devnet or localnet, not ${cluster} (I3)`);
  }
  if (method === 'wallet-signature' && !isBase58PublicKey(approver)) {
    throw new TypeError('approver must be a base58 Ed25519 public key');
  }
  if (approver !== undefined && approver !== null && !isBase58PublicKey(approver)) {
    throw new TypeError('approver must be a base58 Ed25519 public key');
  }
  // Two different approvers would mean the page asks one wallet and the queue
  // accepts another; refuse the configuration instead of guessing.
  if (holds.approver && approver && holds.approver !== approver) {
    throw new Error('approval server approver does not match the hold queue approver');
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('port must be an integer 0..65535');

  const log = makeLog(logger);
  const settings = { holds, approver: approver ?? null, method, cluster, log };
  const server = createServer((req, res) => {
    handle(req, res, settings, server.address().port).catch((err) => {
      log(`approval server: internal error (${err?.code ?? err?.name ?? 'error'})`);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal_error', message: 'internal error; nothing was approved' });
      else res.destroy();
    });
  });
  // Slow or idle clients must not pin the only approval path open.
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      server.on('error', (err) => log(`approval server: ${err?.code ?? 'error'}`));
      const actual = server.address().port;
      const url = `http://127.0.0.1:${actual}`;
      log(`approval page: ${url} (${method}, ${cluster})`);
      resolve({
        url,
        port: actual,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
            server.closeAllConnections?.();
          }),
      });
    });
  });
}

async function handle(req, res, settings, port) {
  const { holds, approver, method, cluster, log } = settings;

  // I11: DNS rebinding. Only our own loopback authority is acceptable.
  const host = req.headers.host;
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
    log('approval server: refused request with a foreign Host header');
    return sendJson(res, 403, { ok: false, error: 'forbidden_host', message: 'Host header not allowed' });
  }
  // I11: cross-origin requests. Browsers send Origin on POST; it must be ours.
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== `http://${host}`) {
    log('approval server: refused request with a foreign Origin header');
    return sendJson(res, 403, { ok: false, error: 'forbidden_origin', message: 'Origin not allowed' });
  }

  let pathname;
  try {
    pathname = new URL(req.url, `http://${host}`).pathname;
  } catch {
    return sendJson(res, 400, { ok: false, error: 'bad_request', message: 'bad URL' });
  }

  if (pathname === '/' || pathname === '/app.js' || pathname === '/api/holds') {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    if (pathname === '/') return sendText(res, 200, 'text/html; charset=utf-8', PAGE_HTML);
    if (pathname === '/app.js') return sendText(res, 200, 'text/javascript; charset=utf-8', APP_JS);
    return sendJson(res, 200, {
      ok: true,
      now: new Date(holds.nowMs?.() ?? Date.now()).toISOString(),
      approver,
      method,
      cluster,
      holds: holds.listPending().map(holdView),
    });
  }

  const match = HOLD_ROUTE.exec(pathname);
  if (!match) return sendJson(res, 404, { ok: false, error: 'not_found', message: 'not found' });
  const [, id, action] = match;

  if (!action) {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    const hold = holds.get(id);
    if (!hold) return sendJson(res, 404, { ok: false, error: 'not_found', message: 'no such hold' });
    return sendJson(res, 200, { ok: true, hold: holdView(hold) });
  }

  if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
  const contentType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    req.resume();
    return sendJson(res, 415, { ok: false, error: 'unsupported_media_type', message: 'send application/json' });
  }

  let body;
  try {
    body = await readJson(req);
  } catch (err) {
    if (err instanceof HttpError) return sendJson(res, err.status, { ok: false, error: err.code, message: err.message });
    throw err;
  }

  try {
    if (action === 'reject') {
      const reason = typeof body.reason === 'string' ? body.reason : undefined;
      const hold = holds.reject(id, reason ?? 'rejected in the approval page');
      log(`approval page: hold ${hold.id} rejected`);
      return sendJson(res, 200, { ok: true, hold: holdView(hold) });
    }

    if (body.method === 'local-button') {
      if (method !== 'local-button') {
        return sendJson(res, 403, { ok: false, error: 'method_not_allowed', message: 'local-button approval is disabled' });
      }
      const hold = holds.approve(id, { method: 'insecure-local-button' });
      log(`approval page: hold ${hold.id} approved (insecure-local-button)`);
      return sendJson(res, 200, { ok: true, hold: holdView(hold) });
    }

    // Decided / expired / unknown are reported as such before the signature
    // is looked at, so a late approval says 409 or 410, not "bad signature".
    const current = holds.get(id);
    if (!current) return sendJson(res, 404, { ok: false, error: 'not_found', message: 'no such hold' });
    if (current.status === 'expired') return sendJson(res, 410, { ok: false, error: 'expired', message: 'hold expired' });
    if (current.status !== 'pending') {
      return sendJson(res, 409, { ok: false, error: 'already_decided', message: `hold already ${current.status}` });
    }

    const signature = decodeSignature(body.signature);
    const publicKey = body.publicKey;
    if (signature === null || typeof publicKey !== 'string' || publicKey.length > 64) {
      return sendJson(res, 400, { ok: false, error: 'bad_request', message: 'expected { publicKey, signature (base64) }' });
    }
    if (!approver || !verifyApproval({ message: current.approvalMessage, publicKey, signature, approver })) {
      log(`approval page: hold ${current.id} approval refused (signature does not verify)`);
      return sendJson(res, 400, { ok: false, error: 'bad_signature', message: 'signature does not verify against the approver for this hold' });
    }
    const hold = holds.approve(id, { publicKey, signature, method: 'wallet-signature' });
    log(`approval page: hold ${hold.id} approved (wallet-signature)`);
    return sendJson(res, 200, { ok: true, hold: holdView(hold) });
  } catch (err) {
    if (err instanceof HoldError) return sendJson(res, err.status, { ok: false, error: err.code, message: err.message });
    throw err;
  }
}

function decodeSignature(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > 128 || !BASE64.test(text)) return null;
  return new Uint8Array(Buffer.from(text, 'base64'));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        failed = true;
        reject(new HttpError(413, 'payload_too_large', 'request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (failed) return;
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        reject(new HttpError(400, 'bad_json', 'request body is not valid JSON'));
        return;
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        reject(new HttpError(400, 'bad_request', 'request body must be a JSON object'));
        return;
      }
      resolve(body);
    });
    req.on('error', (err) => {
      if (!failed) reject(err);
    });
  });
}

/**
 * What the page sees of a hold. Approval signatures and parent ids are not
 * part of it; every review field is passed through the BigInt replacer.
 */
export function holdView(hold) {
  const review = hold.review && typeof hold.review === 'object' ? hold.review : {};
  return {
    id: hold.id,
    kind: hold.kind,
    tool: hold.tool ?? null,
    cluster: hold.cluster,
    status: hold.status,
    createdAt: hold.createdAt,
    expiresAt: hold.expiresAt,
    decidedAt: hold.decidedAt ?? null,
    reason: hold.reason ?? null,
    approvalMethod: hold.approval?.method ?? null,
    summaryLine: review.summaryLine ?? null,
    messageSha256: review.messageSha256 ?? null,
    version: review.version ?? null,
    feePayer: review.feePayer ?? null,
    programs: Array.isArray(review.programs) ? review.programs : [],
    instructions: Array.isArray(review.instructions) ? review.instructions : [],
    outflow: review.outflow ?? {},
    inflow: review.inflow ?? {},
    violations: Array.isArray(review.violations) ? review.violations : [],
    warnings: Array.isArray(review.warnings) ? review.warnings : [],
    sim: review.sim ? { ok: review.sim.ok, err: review.sim.err ?? null, unitsConsumed: review.sim.unitsConsumed ?? null } : null,
    approvalMessage: hold.approvalMessage,
  };
}

function sendJson(res, status, body) {
  let text;
  try {
    text = JSON.stringify(body, jsonReplacer);
  } catch {
    status = 500;
    text = JSON.stringify({ ok: false, error: 'internal_error', message: 'response could not be serialised' });
  }
  sendText(res, status, 'application/json; charset=utf-8', text);
}

function sendText(res, status, contentType, text) {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'content-type': contentType,
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function methodNotAllowed(res, allow) {
  res.setHeader('allow', allow);
  return sendJson(res, 405, { ok: false, error: 'method_not_allowed', message: `use ${allow}` });
}
