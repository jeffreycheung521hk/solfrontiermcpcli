// Holds: a transaction waiting for a human.
//
// A hold is created once Gate has reviewed a transaction and decided a person
// must look at it. The person approves by signing the hold's approval message
// with their own wallet (SPEC §5.6, I3). The message is generated exactly once,
// here, and carries the hold id, the cluster, the reviewed message hash and the
// expiry -- so a signature is bound to one hold and cannot be replayed onto
// another, and the agent (which has no access to the approver's wallet) cannot
// produce one.
//
// Everything that can go wrong resolves toward "not approved": unknown id,
// expiry, bad signature, missing approver, unexpected method. Waiters only ever
// see `approved` when a valid approval was recorded while the hold was pending.
import { createPublicKey, randomBytes, verify } from 'node:crypto';

export const CLUSTERS = Object.freeze(['devnet', 'mainnet-beta', 'localnet']);
/** Clusters where the insecure local-button fallback may approve (I3). */
export const LOCAL_BUTTON_CLUSTERS = Object.freeze(['devnet', 'localnet']);
export const MAX_TIMEOUT_SEC = 60;
// Decided holds are kept for the page and for late `waitFor` calls, but not
// forever: a long-running gate would otherwise grow without bound.
const MAX_DECIDED_KEPT = 500;

const HOLD_ID = /^[0-9a-f]{12}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
// C0, DEL, C1 and the Unicode line/paragraph separators. Any of these inside
// the summary would let review text start a new line in the signed message --
// e.g. a forged `expires:` line in the wallet popup.
const LINE_BREAKERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

const HTTP_STATUS = Object.freeze({
  bad_request: 400,
  bad_signature: 400,
  method_not_allowed: 403,
  not_found: 404,
  already_decided: 409,
  expired: 410,
  approval_unavailable: 503,
});

/** A refusal from the hold queue. `status` is the HTTP status the approval server answers with. */
export class HoldError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'HoldError';
    this.code = code;
    this.status = HTTP_STATUS[code] ?? 500;
  }
}

// --- base58 ---------------------------------------------------------------
// Private on purpose: T3 owns src/solana/base58.mjs on a parallel branch and
// I1 swaps it in. Returns null instead of throwing so callers fail closed
// without a try/catch.
const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_INDEX = new Map([...B58_ALPHABET].map((ch, i) => [ch, i]));

function decodeBase58(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > 128) return null;
  const bytes = []; // little-endian accumulator
  for (const ch of text) {
    const digit = B58_INDEX.get(ch);
    if (digit === undefined) return null;
    let carry = digit;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let zeros = 0;
  while (zeros < text.length && text[zeros] === '1') zeros++;
  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[zeros + i] = bytes[bytes.length - 1 - i];
  return out;
}

/** True when `text` is a base58 string that decodes to a 32-byte Ed25519 public key. */
export function isBase58PublicKey(text) {
  const bytes = decodeBase58(text);
  return bytes !== null && bytes.length === 32;
}

// --- approval message -----------------------------------------------------

/** The summary as it may appear on one line of the signed message. */
export function sanitizeSummary(text) {
  return String(text ?? '').replace(LINE_BREAKERS, ' ');
}

/**
 * The exact approval message for a hold (SPEC §5.6): six lines, `\n`-joined,
 * no trailing newline. Throws on anything that would make the message
 * ambiguous; a hold that cannot be described exactly is never created.
 *
 * @param {{ id: string, cluster: string, messageSha256: string, summaryLine: string, expiresAt: string }} fields
 * @returns {string}
 */
export function buildApprovalMessage({ id, cluster, messageSha256, summaryLine, expiresAt }) {
  if (!HOLD_ID.test(String(id))) throw new TypeError('hold id must be 12 lowercase hex characters');
  if (!CLUSTERS.includes(cluster)) throw new TypeError(`unknown cluster: ${String(cluster).slice(0, 32)}`);
  if (!SHA256_HEX.test(String(messageSha256))) throw new TypeError('messageSha256 must be 64 lowercase hex characters');
  if (typeof summaryLine !== 'string') throw new TypeError('summaryLine must be a string');
  if (typeof expiresAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(expiresAt)) {
    throw new TypeError('expiresAt must be an ISO-8601 UTC timestamp');
  }
  return [
    'SolFrontier Gate approval',
    `hold: ${id}`,
    `cluster: ${cluster}`,
    `tx-message-sha256: ${messageSha256}`,
    `summary: ${sanitizeSummary(summaryLine)}`,
    `expires: ${expiresAt}`,
  ].join('\n');
}

/**
 * Is `signature` a valid Ed25519 signature by `approver` over `message`?
 * Never throws: any malformed input is simply "not approved".
 *
 * @param {{ message: string, publicKey: string, signature: Uint8Array, approver: string }} input
 * @returns {boolean}
 */
export function verifyApproval({ message, publicKey, signature, approver } = {}) {
  try {
    if (typeof message !== 'string' || typeof publicKey !== 'string' || typeof approver !== 'string') return false;
    if (publicKey !== approver) return false;
    if (!(signature instanceof Uint8Array) || signature.length !== 64) return false;
    const keyBytes = decodeBase58(approver);
    if (keyBytes === null || keyBytes.length !== 32) return false;
    const key = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(keyBytes).toString('base64url') },
      format: 'jwk',
    });
    return verify(null, Buffer.from(message, 'utf8'), key, signature);
  } catch {
    return false;
  }
}

function defaultId() {
  return randomBytes(6).toString('hex');
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function cleanReason(reason, fallback) {
  const text = typeof reason === 'string' ? sanitizeSummary(reason).trim().slice(0, 200) : '';
  return text || fallback;
}

/**
 * Pending transactions awaiting a human decision (SPEC §5.6).
 *
 * Clock, id generator and timer functions are injectable so tests can stage
 * expiry deterministically. Expiry is checked on every access and by a timer
 * per hold; whichever notices first resolves the waiters with `expired`.
 */
export class HoldQueue {
  #records = new Map(); // id -> { hold, expiresAtMs, timer, waiters, outcome }
  #approver;
  #now;
  #newId;
  #setTimer;
  #clearTimer;

  /**
   * @param {object} [options]
   * @param {string|null} [options.approver]  base58 pubkey allowed to approve; without it no wallet approval succeeds
   * @param {() => number} [options.now]      epoch milliseconds
   * @param {() => string} [options.newId]    12 lowercase hex characters
   * @param {Function} [options.setTimer]     setTimeout-compatible
   * @param {Function} [options.clearTimer]   clearTimeout-compatible
   */
  constructor({ approver = null, now = Date.now, newId = defaultId, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    if (approver !== null && !isBase58PublicKey(approver)) throw new TypeError('approver must be a base58 Ed25519 public key');
    this.#approver = approver;
    this.#now = now;
    this.#newId = newId;
    this.#setTimer = setTimer;
    this.#clearTimer = clearTimer;
  }

  /** The configured approver (base58), or null. */
  get approver() {
    return this.#approver;
  }

  /** The queue's clock, in epoch milliseconds. The approval page uses it for countdowns. */
  nowMs() {
    return this.#now();
  }

  /**
   * Create a pending hold and its approval message.
   *
   * @param {object} input
   * @param {'tool-arg'|'rpc-send'} input.kind
   * @param {string} [input.tool]
   * @param {{ messageSha256: string, summaryLine: string }} input.review
   * @param {string} input.cluster
   * @param {number} input.timeoutSec
   * @param {string[]} [input.parentIds]  host `callId`s / checkpoint `sendId` this hold belongs to
   * @returns {object} a snapshot of the hold
   */
  add({ kind, tool = null, review, cluster, timeoutSec, parentIds = [] } = {}) {
    if (kind !== 'tool-arg' && kind !== 'rpc-send') throw new TypeError('kind must be "tool-arg" or "rpc-send"');
    if (tool !== null && typeof tool !== 'string') throw new TypeError('tool must be a string');
    if (!review || typeof review !== 'object') throw new TypeError('review is required');
    if (!Number.isFinite(timeoutSec) || timeoutSec <= 0 || timeoutSec > MAX_TIMEOUT_SEC) {
      throw new TypeError(`timeoutSec must be > 0 and ≤ ${MAX_TIMEOUT_SEC}`);
    }
    if (!Array.isArray(parentIds) || !parentIds.every((p) => typeof p === 'string')) {
      throw new TypeError('parentIds must be an array of strings');
    }
    const id = this.#newId();
    if (!HOLD_ID.test(String(id))) throw new TypeError('hold id generator must return 12 lowercase hex characters');
    if (this.#records.has(id)) throw new Error(`duplicate hold id ${id}`);

    const createdAtMs = this.#now();
    const expiresAtMs = Math.floor(createdAtMs + timeoutSec * 1000);
    const expiresAt = iso(expiresAtMs);
    const approvalMessage = buildApprovalMessage({
      id,
      cluster,
      messageSha256: review.messageSha256,
      summaryLine: review.summaryLine,
      expiresAt,
    });
    const hold = {
      id,
      createdAt: iso(createdAtMs),
      expiresAt,
      status: 'pending',
      kind,
      tool,
      cluster,
      review,
      approvalMessage,
      parentIds: [...parentIds],
      decidedAt: null,
      reason: null,
      approval: null,
    };
    const record = { hold, expiresAtMs, timer: null, waiters: [], outcome: null };
    this.#records.set(id, record);
    this.#arm(record, expiresAtMs - createdAtMs);
    this.#prune();
    return snapshot(hold);
  }

  /** A snapshot of the hold, or null when the id is unknown. */
  get(id) {
    this.#sweep();
    const record = this.#records.get(id);
    return record ? snapshot(record.hold) : null;
  }

  /** Snapshots of every pending hold, oldest first. */
  listPending() {
    this.#sweep();
    return [...this.#records.values()].filter((r) => r.hold.status === 'pending').map((r) => snapshot(r.hold));
  }

  /**
   * Approve a pending hold. Throws a HoldError (and leaves the hold as it was)
   * unless the approval is valid for this hold right now.
   *
   * @param {string} id
   * @param {{ publicKey?: string, signature?: Uint8Array, method?: string }} approval
   *   method `wallet-signature` (default) or `local-button` / `insecure-local-button` (devnet/localnet only)
   */
  approve(id, { publicKey, signature, method = 'wallet-signature' } = {}) {
    const record = this.#pending(id);
    const { hold } = record;
    let approval;
    if (method === 'wallet-signature') {
      if (this.#approver === null) throw new HoldError('approval_unavailable', 'no approver is configured');
      if (!verifyApproval({ message: hold.approvalMessage, publicKey, signature, approver: this.#approver })) {
        throw new HoldError('bad_signature', 'signature does not verify against the approver for this hold');
      }
      approval = { publicKey, signature: Uint8Array.from(signature), method: 'wallet-signature' };
    } else if (method === 'local-button' || method === 'insecure-local-button') {
      if (!LOCAL_BUTTON_CLUSTERS.includes(hold.cluster)) {
        throw new HoldError('method_not_allowed', `local-button approval is not allowed on ${hold.cluster}`);
      }
      approval = { publicKey: null, signature: null, method: 'insecure-local-button' };
    } else {
      throw new HoldError('bad_request', 'unknown approval method');
    }
    hold.approval = approval;
    this.#settle(record, 'approved', { status: 'approved', approval });
    return snapshot(hold);
  }

  /** Reject a pending hold. Always allowed while pending. */
  reject(id, reason) {
    const record = this.#pending(id);
    const why = cleanReason(reason, 'rejected');
    record.hold.reason = why;
    this.#settle(record, 'rejected', { status: 'rejected', reason: why });
    return snapshot(record.hold);
  }

  /** Cancel a pending hold (e.g. the host cancelled the request it belongs to). */
  cancel(id, reason) {
    const record = this.#pending(id);
    const why = cleanReason(reason, 'cancelled');
    record.hold.reason = why;
    this.#settle(record, 'cancelled', { status: 'cancelled', reason: why });
    return snapshot(record.hold);
  }

  /**
   * Cancel every pending hold whose snapshot matches `predicate`.
   * @returns {object[]} snapshots of the holds that were cancelled
   */
  cancelWhere(predicate, reason) {
    this.#sweep();
    const cancelled = [];
    for (const record of this.#records.values()) {
      if (record.hold.status !== 'pending') continue;
      let match = false;
      try {
        match = Boolean(predicate(snapshot(record.hold)));
      } catch {
        // A predicate that throws cannot tell us the hold is unrelated, and
        // cancelling refuses money movement: cancel it.
        match = true;
      }
      if (match) cancelled.push(this.cancel(record.hold.id, reason));
    }
    return cancelled;
  }

  /**
   * Resolves once the hold is decided: `approved` (with the approval),
   * `rejected`, `expired` or `cancelled`. Rejects for an unknown id.
   */
  waitFor(id) {
    this.#sweep();
    const record = this.#records.get(id);
    if (!record) return Promise.reject(new HoldError('not_found', `no hold ${String(id).slice(0, 32)}`));
    if (record.outcome) return Promise.resolve(record.outcome);
    return new Promise((resolve) => record.waiters.push(resolve));
  }

  /** Cancel everything still pending and stop all timers. */
  close(reason = 'gate stopping') {
    for (const record of this.#records.values()) {
      if (record.hold.status === 'pending') {
        record.hold.reason = reason;
        this.#settle(record, 'cancelled', { status: 'cancelled', reason });
      }
    }
  }

  #pending(id) {
    this.#sweep();
    const record = this.#records.get(id);
    if (!record) throw new HoldError('not_found', `no hold ${String(id).slice(0, 32)}`);
    if (record.hold.status === 'expired') throw new HoldError('expired', 'hold expired');
    if (record.hold.status !== 'pending') throw new HoldError('already_decided', `hold already ${record.hold.status}`);
    return record;
  }

  #arm(record, delayMs) {
    const timer = this.#setTimer(() => this.#onTimer(record), Math.max(1, delayMs));
    timer?.unref?.();
    record.timer = timer;
  }

  #onTimer(record) {
    record.timer = null;
    if (record.hold.status !== 'pending') return;
    const remaining = record.expiresAtMs - this.#now();
    // Timers and the wall clock can disagree by a millisecond; re-arm rather
    // than expire early or never.
    if (remaining > 0) this.#arm(record, remaining);
    else this.#settle(record, 'expired', { status: 'expired' });
  }

  #sweep() {
    const now = this.#now();
    for (const record of this.#records.values()) {
      if (record.hold.status === 'pending' && now >= record.expiresAtMs) {
        this.#settle(record, 'expired', { status: 'expired' });
      }
    }
  }

  #settle(record, status, outcome) {
    record.hold.status = status;
    record.hold.decidedAt = iso(this.#now());
    record.outcome = outcome;
    if (record.timer !== null) {
      this.#clearTimer(record.timer);
      record.timer = null;
    }
    const waiters = record.waiters;
    record.waiters = [];
    for (const resolve of waiters) resolve(outcome);
  }

  #prune() {
    const decided = [...this.#records.values()].filter((r) => r.hold.status !== 'pending');
    for (const record of decided.slice(0, Math.max(0, decided.length - MAX_DECIDED_KEPT))) {
      this.#records.delete(record.hold.id);
    }
  }
}

// Callers get copies, so nobody outside the queue can flip a status.
function snapshot(hold) {
  return {
    ...hold,
    parentIds: [...hold.parentIds],
    approval: hold.approval
      ? { ...hold.approval, signature: hold.approval.signature ? Uint8Array.from(hold.approval.signature) : null }
      : null,
  };
}
