// Test-only encoders: build Solana transactions and account data at runtime.
//
// Deliberately an independent implementation of the wire format (no imports
// from src/solana/tx.mjs), so a decoder bug cannot be mirrored by its own
// encoder and pass. Keys are generated per run; nothing here touches a network.
import { generateKeyPairSync, randomBytes, sign as edSign } from 'node:crypto';

import { encode as b58, decode as unb58 } from '../src/solana/base58.mjs';

export const SYSTEM = '11111111111111111111111111111111';
export const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
export const MEMO = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
export const ALT_PROGRAM = 'AddressLookupTab1e1111111111111111111111111';

/** A fresh Ed25519 keypair: { address (base58), privateKey (KeyObject) }. */
export function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const x = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  return { address: b58(new Uint8Array(x)), privateKey };
}

/** A random 32-byte address (no private key). */
export const randomAddress = () => b58(new Uint8Array(randomBytes(32)));

export function shortvec(n) {
  const out = [];
  let v = n;
  for (;;) {
    let byte = v & 0x7f;
    v >>= 7;
    if (v === 0) {
      out.push(byte);
      return out;
    }
    byte |= 0x80;
    out.push(byte);
  }
}

export const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return [...b];
};
export const u64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return [...b];
};

/**
 * Serialize a message from explicit parts.
 * @param {{ version?: 'legacy'|0, header: number[], keys: string[], blockhash?: string,
 *           instructions: { p: number, a: number[], d: number[]|Uint8Array }[],
 *           lookups?: { key: string, w: number[], r: number[] }[] }} m
 */
export function message(m) {
  const out = [];
  if (m.version === 0) out.push(0x80);
  out.push(...m.header);
  out.push(...shortvec(m.keys.length));
  for (const k of m.keys) out.push(...unb58(k));
  out.push(...unb58(m.blockhash ?? randomAddress()));
  out.push(...shortvec(m.instructions.length));
  for (const ix of m.instructions) {
    out.push(ix.p, ...shortvec(ix.a.length), ...ix.a, ...shortvec(ix.d.length), ...ix.d);
  }
  if (m.version === 0) {
    const lookups = m.lookups ?? [];
    out.push(...shortvec(lookups.length));
    for (const l of lookups) {
      out.push(...unb58(l.key), ...shortvec(l.w.length), ...l.w, ...shortvec(l.r.length), ...l.r);
    }
  }
  return Uint8Array.from(out);
}

/**
 * Wrap message bytes into a transaction. `signers[i]` signs slot i; `null`
 * leaves the slot all-zero (not present).
 */
export function transaction(messageBytes, signers) {
  const out = [...shortvec(signers.length)];
  for (const s of signers) {
    out.push(...(s ? edSign(null, messageBytes, s.privateKey) : new Uint8Array(64)));
  }
  out.push(...messageBytes);
  return Uint8Array.from(out);
}

// --- instruction data -------------------------------------------------------

export const data = {
  systemTransfer: (lamports) => [...u32(2), ...u64(lamports)],
  systemCreateAccount: (lamports, space, owner) => [...u32(0), ...u64(lamports), ...u64(space), ...unb58(owner)],
  splTransfer: (amount) => [3, ...u64(amount)],
  splTransferChecked: (amount, decimals) => [12, ...u64(amount), decimals],
  splApprove: (amount) => [4, ...u64(amount)],
  splApproveChecked: (amount, decimals) => [13, ...u64(amount), decimals],
  splSetAuthority: (type, newAuthority) => (newAuthority
    ? [6, type, 1, ...unb58(newAuthority)]
    : [6, type, 0]),
  splCloseAccount: () => [9],
  splSyncNative: () => [17],
  ataCreate: () => [],
  ataCreateIdempotent: () => [1],
  computeUnitLimit: (units) => [2, ...u32(units)],
  computeUnitPrice: (microLamports) => [3, ...u64(microLamports)],
  memo: (text) => [...Buffer.from(text, 'utf8')],
};

// --- account data -----------------------------------------------------------

/** SPL token account (165 bytes): mint, owner, amount; state = initialized. */
export function tokenAccountData({ mint, owner, amount }) {
  const b = new Uint8Array(165);
  b.set(unb58(mint), 0);
  b.set(unb58(owner), 32);
  b.set(u64(amount), 64);
  b[108] = 1;
  return b;
}

/** SPL mint (82 bytes) with `decimals` at byte 44, initialized. */
export function mintData({ decimals, supply = 0n }) {
  const b = new Uint8Array(82);
  b.set(u64(supply), 36);
  b[44] = decimals;
  b[45] = 1;
  return b;
}

/** Address lookup table account: 56-byte meta (type 1 = LookupTable), then keys. */
export function lookupTableData(addresses) {
  const b = new Uint8Array(56 + 32 * addresses.length);
  b.set(u32(1), 0);
  b.set(u64(0xffffffffffffffffn), 4); // deactivation slot: never
  addresses.forEach((a, i) => b.set(unb58(a), 56 + 32 * i));
  return b;
}

/** An RPC base64 account object, as getMultipleAccounts / simulateTransaction return it. */
export function rpcAccount({ lamports = 0, owner = SYSTEM, data: bytes = new Uint8Array(0) }) {
  return {
    lamports,
    owner,
    data: [Buffer.from(bytes).toString('base64'), 'base64'],
    executable: false,
    rentEpoch: 0,
    space: bytes.length,
  };
}
