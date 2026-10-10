// Solana transaction wire format: decode, hash, resolve accounts, verify signatures.
//
// This is the first thing Gate does with bytes an agent wants signed, so it is
// strict on purpose. Anything the runtime's own sanitizer would reject -- an
// overlong shortvec, trailing bytes, an index past the key list, a duplicate
// key, a program id that lives in a lookup table -- throws here, and the
// caller refuses the transaction (I7). A permissive decoder is how a policy
// ends up judging a different transaction from the one that lands.
//
// Layout: shortvec(#signatures) ‖ 64-byte signatures ‖ message.
// Message:  [0x80|version]? header(3) ‖ shortvec keys(32) ‖ blockhash(32)
//           ‖ shortvec instructions ‖ (v0) shortvec address table lookups.
import { createHash, createPublicKey, verify } from 'node:crypto';

import { encode as b58encode, decode as base58ToBytes } from './base58.mjs';

/** A cursor over bytes that throws instead of reading past the end. */
class Reader {
  constructor(bytes) {
    this.bytes = bytes;
    this.pos = 0;
  }

  u8() {
    if (this.pos >= this.bytes.length) throw new Error('transaction truncated');
    return this.bytes[this.pos++];
  }

  take(n) {
    if (this.pos + n > this.bytes.length) throw new Error('transaction truncated');
    const out = this.bytes.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  // compact-u16: 7 bits per byte, least significant group first, at most 3
  // bytes. The canonical encoding is unique, so a zero final group after the
  // first byte (0x80 0x00) and anything above 0xffff are both rejected: two
  // encodings of one message would hash differently and break I2's
  // "exact message hash".
  shortvec() {
    let value = 0;
    for (let i = 0; i < 3; i++) {
      const byte = this.u8();
      value |= (byte & 0x7f) << (7 * i);
      if ((byte & 0x80) === 0) {
        if (i > 0 && byte === 0) throw new Error('overlong shortvec encoding');
        if (value > 0xffff) throw new Error('shortvec out of range');
        return value;
      }
    }
    throw new Error('shortvec longer than 3 bytes');
  }
}

function toBytes(input) {
  if (input instanceof Uint8Array) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new TypeError('decodeTransaction expects a Uint8Array');
}

/**
 * Decode a serialized transaction (legacy or v0). Throws on any malformation.
 * @param {Uint8Array} bytes
 */
export function decodeTransaction(bytes) {
  const r = new Reader(toBytes(bytes));

  const numSignatures = r.shortvec();
  const signatures = [];
  for (let i = 0; i < numSignatures; i++) signatures.push(r.take(64));

  const messageStart = r.pos;
  let version = 'legacy';
  const first = r.u8();
  let numRequiredSignatures;
  if (first & 0x80) {
    const v = first & 0x7f;
    if (v !== 0) throw new Error(`unsupported transaction version ${v}`);
    version = 0;
    numRequiredSignatures = r.u8();
  } else {
    numRequiredSignatures = first;
  }
  const header = {
    numRequiredSignatures,
    numReadonlySigned: r.u8(),
    numReadonlyUnsigned: r.u8(),
  };

  const numKeys = r.shortvec();
  const staticAccountKeys = [];
  for (let i = 0; i < numKeys; i++) staticAccountKeys.push(b58encode(r.take(32)));
  const recentBlockhash = b58encode(r.take(32));

  const numInstructions = r.shortvec();
  const instructions = [];
  for (let i = 0; i < numInstructions; i++) {
    const programIdIndex = r.u8();
    const numAccounts = r.shortvec();
    const accountIndexes = [];
    for (let j = 0; j < numAccounts; j++) accountIndexes.push(r.u8());
    const dataLen = r.shortvec();
    const data = r.take(dataLen);
    instructions.push({ programIdIndex, accountIndexes, data });
  }

  const addressTableLookups = [];
  if (version === 0) {
    const numLookups = r.shortvec();
    for (let i = 0; i < numLookups; i++) {
      const accountKey = b58encode(r.take(32));
      const writableIndexes = [];
      const nw = r.shortvec();
      for (let j = 0; j < nw; j++) writableIndexes.push(r.u8());
      const readonlyIndexes = [];
      const nr = r.shortvec();
      for (let j = 0; j < nr; j++) readonlyIndexes.push(r.u8());
      addressTableLookups.push({ accountKey, writableIndexes, readonlyIndexes });
    }
  }

  if (r.pos !== r.bytes.length) throw new Error(`${r.bytes.length - r.pos} trailing byte(s) after the message`);

  const decoded = {
    signatures,
    version,
    header,
    staticAccountKeys,
    recentBlockhash,
    instructions,
    addressTableLookups,
    messageBytes: r.bytes.slice(messageStart),
  };
  sanitize(decoded);
  return decoded;
}

// The runtime's structural checks, in the same spirit: whatever it would
// refuse to execute, we refuse to judge.
function sanitize(d) {
  const { header, staticAccountKeys: keys } = d;
  if (header.numRequiredSignatures < 1) throw new Error('message requires no signatures (no fee payer)');
  if (d.signatures.length !== header.numRequiredSignatures) {
    throw new Error(`message requires ${header.numRequiredSignatures} signature(s), transaction carries ${d.signatures.length}`);
  }
  // The fee payer (key 0) must be a writable signer.
  if (header.numReadonlySigned >= header.numRequiredSignatures) throw new Error('fee payer is not a writable signer');
  if (header.numRequiredSignatures + header.numReadonlyUnsigned > keys.length) {
    throw new Error('message header counts exceed the static account keys');
  }
  if (new Set(keys).size !== keys.length) throw new Error('duplicate static account key');

  let lookupCount = 0;
  const tables = new Set();
  for (const l of d.addressTableLookups) {
    if (l.writableIndexes.length + l.readonlyIndexes.length === 0) throw new Error('empty address table lookup');
    if (tables.has(l.accountKey)) throw new Error('duplicate address table lookup');
    tables.add(l.accountKey);
    lookupCount += l.writableIndexes.length + l.readonlyIndexes.length;
  }
  const total = keys.length + lookupCount;
  if (total > 256) throw new Error('more than 256 account keys');

  for (const [n, ix] of d.instructions.entries()) {
    if (ix.programIdIndex >= total) throw new Error(`instruction ${n}: program id index out of range`);
    if (ix.programIdIndex >= keys.length) throw new Error(`instruction ${n}: program id comes from an address lookup table`);
    if (ix.programIdIndex === 0) throw new Error(`instruction ${n}: the fee payer cannot be a program`);
    for (const a of ix.accountIndexes) {
      if (a >= total) throw new Error(`instruction ${n}: account index ${a} out of range`);
    }
  }
}

/**
 * SHA-256 of the exact message bytes, lowercase hex. This is what a human
 * approves (SPEC §5.6) and what `sfcli audit` re-derives from the ledger.
 * @returns {string}
 */
export function messageSha256(decoded) {
  return createHash('sha256').update(decoded.messageBytes).digest('hex');
}

/**
 * The full account key list in runtime order, with signer and writable flags.
 * v0 order: static keys, then every lookup's writable indexes (lookup order),
 * then every lookup's readonly indexes. A lookup table that is missing from
 * `tables`, or an index past its end, throws.
 *
 * Flags follow the message header only; the runtime additionally demotes some
 * keys (invoked programs, reserved ids) to read-only, which can only make a
 * key less writable than reported here -- the safe direction for policy.
 *
 * @param {ReturnType<typeof decodeTransaction>} decoded
 * @param {Map<string, string[]>} [tables]
 * @returns {{ keys: string[], writable: boolean[], signer: boolean[] }}
 */
export function resolveAccountKeys(decoded, tables = new Map()) {
  const { header, staticAccountKeys } = decoded;
  const n = staticAccountKeys.length;
  const writableSigned = header.numRequiredSignatures - header.numReadonlySigned;
  const writableUnsignedEnd = n - header.numReadonlyUnsigned;

  const keys = [...staticAccountKeys];
  const signer = keys.map((_, i) => i < header.numRequiredSignatures);
  const writable = keys.map((_, i) => (i < header.numRequiredSignatures
    ? i < writableSigned
    : i < writableUnsignedEnd));

  const lookup = (l, idx) => {
    const table = tables.get(l.accountKey);
    if (!Array.isArray(table)) throw new Error(`address lookup table ${l.accountKey} not provided`);
    if (idx >= table.length) throw new Error(`address lookup table ${l.accountKey} has no index ${idx}`);
    return table[idx];
  };
  for (const l of decoded.addressTableLookups) {
    for (const idx of l.writableIndexes) {
      keys.push(lookup(l, idx));
      writable.push(true);
      signer.push(false);
    }
  }
  for (const l of decoded.addressTableLookups) {
    for (const idx of l.readonlyIndexes) {
      keys.push(lookup(l, idx));
      writable.push(false);
      signer.push(false);
    }
  }
  return { keys, writable, signer };
}

const isAllZero = (bytes) => bytes.every((b) => b === 0);

/**
 * Check each signature against its signer key (static key i signs slot i).
 * An all-zero signature is "not present" (how unsigned transactions are
 * serialized) and counts as invalid. `complete` = every slot present and valid.
 * @returns {{ complete: boolean, valid: boolean[] }}
 */
export function verifySignatures(decoded) {
  const valid = decoded.signatures.map((sig, i) => {
    if (isAllZero(sig)) return false;
    const key = decoded.staticAccountKeys[i];
    if (key === undefined) return false;
    try {
      const pub = createPublicKey({
        key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(base58ToBytes(key)).toString('base64url') },
        format: 'jwk',
      });
      return verify(null, decoded.messageBytes, pub, sig);
    } catch {
      return false;
    }
  });
  return { complete: valid.length > 0 && valid.every(Boolean), valid };
}

