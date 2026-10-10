// Hash-chained JSONL audit log (SPEC §5.8). T1 writes, T8 verifies.
//
//   hash = sha256hex(prev + "\n" + JSON.stringify(recordWithoutHash))
//
// Design notes:
//  * appendFileSync, not a stream. "Log, then act" (I6) only means something
//    if the record is on disk before append() returns and the effect starts.
//  * The verifier re-serialises each parsed line and requires it to equal the
//    line byte for byte. A chain that verifies only under a lenient parser
//    (extra whitespace, duplicate keys, reordered fields) is not evidence.
//  * Redaction happens before hashing, and a record that would still contain
//    a known secret after redaction is refused outright: losing one record is
//    recoverable, writing a key into an append-only file is not.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { UsageError } from '../cli/exit-codes.mjs';

export const GENESIS = '0'.repeat(64);
const RESERVED = new Set(['v', 'seq', 'ts', 'prev', 'type', 'hash']);
const HEX64 = /^[0-9a-f]{64}$/;
const ARG_STRING_MAX = 200;

const sha256hex = (text) => createHash('sha256').update(text).digest('hex');

/** sha256 over prev + "\n" + the serialised record (without `hash`). */
export function recordHash(prev, recordWithoutHash) {
  return sha256hex(`${prev}\n${JSON.stringify(recordWithoutHash)}`);
}

/**
 * The argument-logging rule: strings longer than 200 characters become
 * `{ sha256, length }` — enough to match a payload later, not enough to
 * replay or read it. BigInt becomes a decimal string.
 */
export function scrubArgs(value) {
  if (typeof value === 'string') {
    return value.length > ARG_STRING_MAX ? { sha256: sha256hex(value), length: value.length } : value;
  }
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(scrubArgs);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubArgs(v);
    return out;
  }
  return value;
}

/** JSON-safe, redacted deep copy: BigInt -> string, keys and strings redacted. */
function sanitize(value, redact) {
  if (typeof value === 'string') return redact(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (value instanceof Uint8Array) return { length: value.length }; // never raw bytes
  if (Array.isArray(value)) return value.map((v) => sanitize(v, redact) ?? null);
  if (value && typeof value === 'object') {
    if (typeof value.toJSON === 'function') return sanitize(value.toJSON(), redact);
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const clean = sanitize(v, redact);
      if (clean !== undefined) out[redact(k)] = clean;
    }
    return out;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  return value;
}

/**
 * Verify a whole log. Line numbers are 1-based and equal `seq`.
 * @param {string} text
 * @returns {{ ok: boolean, count: number, firstBadLine?: number, reason?: string, lastHash: string, lastSeq: number }}
 */
export function verifyChainText(text) {
  let prev = GENESIS;
  let count = 0;
  const bad = (line, reason) => ({ ok: false, count, firstBadLine: line, reason, lastHash: prev, lastSeq: count });
  if (text === '') return { ok: true, count: 0, lastHash: prev, lastSeq: 0 };

  const lines = text.split('\n');
  const trailing = lines.pop(); // '' when the text ends with a newline
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = lines[i];
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      return bad(lineNo, 'not valid JSON');
    }
    if (!record || typeof record !== 'object' || Array.isArray(record)) return bad(lineNo, 'not a JSON object');
    if (JSON.stringify(record) !== line) return bad(lineNo, 'not in canonical form');
    const keys = Object.keys(record);
    if (keys[keys.length - 1] !== 'hash' || !HEX64.test(String(record.hash))) {
      return bad(lineNo, 'hash missing, malformed, or not the last field');
    }
    if (record.v !== 1) return bad(lineNo, 'unsupported version');
    if (record.seq !== lineNo) return bad(lineNo, `seq ${JSON.stringify(record.seq)} != line ${lineNo}`);
    if (record.prev !== prev) return bad(lineNo, 'prev does not match the previous hash');
    if (typeof record.type !== 'string' || typeof record.ts !== 'string') return bad(lineNo, 'type or ts missing');
    const { hash, ...rest } = record;
    if (recordHash(prev, rest) !== hash) return bad(lineNo, 'hash mismatch');
    prev = hash;
    count = lineNo;
  }
  if (trailing !== '') {
    // A crash mid-append, or an edit that ate the newline: the last record
    // is incomplete evidence, so the chain does not verify.
    return bad(lines.length + 1, 'last line not terminated by a newline');
  }
  return { ok: true, count, lastHash: prev, lastSeq: count };
}

export class AuditLog {
  #path;
  #seq;
  #prev;
  #redact;
  #clock;

  constructor(filePath, { seq = 0, prev = GENESIS, redact = (t) => t, clock = () => new Date() } = {}) {
    this.#path = filePath;
    this.#seq = seq;
    this.#prev = prev;
    this.#redact = redact;
    this.#clock = clock;
  }

  /**
   * Open (or create) a log, verifying any existing chain first. A broken chain
   * is a UsageError (exit 2) naming the first bad line: Gate refuses to start
   * rather than extend evidence it cannot vouch for.
   */
  static open(filePath, options = {}) {
    let state = { lastSeq: 0, lastHash: GENESIS };
    if (existsSync(filePath)) {
      const result = verifyChainText(readFileSync(filePath, 'utf8'));
      if (!result.ok) {
        throw new UsageError(
          `audit log ${filePath} does not verify: line ${result.firstBadLine}: ${result.reason}`,
          { hint: 'move the file aside (keep it: it is evidence) and start a new log' },
        );
      }
      state = result;
    } else {
      mkdirSync(path.dirname(filePath), { recursive: true });
    }
    return new AuditLog(filePath, { ...options, seq: state.lastSeq, prev: state.lastHash });
  }

  get path() {
    return this.#path;
  }

  get seq() {
    return this.#seq;
  }

  /**
   * Append one record synchronously and return it (with its hash).
   * @param {string} type
   * @param {object} payload JSON-safe fields; reserved names are refused
   */
  append(type, payload = {}) {
    if (typeof type !== 'string' || !type) throw new TypeError('audit record type must be a non-empty string');
    for (const k of Object.keys(payload)) {
      if (RESERVED.has(k)) throw new TypeError(`audit payload may not set reserved field "${k}"`);
    }
    const clean = sanitize(payload, this.#redact) ?? {};
    const seq = this.#seq + 1;
    const record = { v: 1, seq, ts: this.#clock().toISOString(), prev: this.#prev, type: this.#redact(type), ...clean };
    const hash = recordHash(this.#prev, record);
    const line = JSON.stringify({ ...record, hash });
    // Fail closed: if anything the redactor knows survived, do not write.
    if (this.#redact(line) !== line) throw new Error('audit record still contains secret material after redaction; not written');
    appendFileSync(this.#path, `${line}\n`);
    this.#seq = seq;
    this.#prev = hash;
    return { ...record, hash };
  }
}
