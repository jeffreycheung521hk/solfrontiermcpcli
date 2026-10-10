// Simulate a transaction and report balance changes of the wallet's own accounts.
//
// Cross-program invocations are not decoded (SPEC L4), so net effect comes
// from here: the wallet's lamports and every token account the wallet owns,
// before (getMultipleAccounts) and after (simulateTransaction with an
// `accounts` request). Every RPC failure, malformed response or ambiguity
// throws; the caller refuses the transaction (I7). A simulation error from the
// cluster is not a throw: it is passed through as `err`, and policy denies it.
import { decodePublicKey, encode as b58encode } from './base58.mjs';
import { accountData } from './alt.mjs';

export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const MAX_WATCH = 40;

const TOKEN_PROGRAMS = new Set([TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]);
const ACCOUNT_LEN = 165;
const MINT_LEN = 82;

const u64 = (d, off) => new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(off, true);

/**
 * Classify token-program account data. Token-2022 accounts with extensions
 * are longer than 165 bytes and carry an account-type byte at 165 (1 = mint,
 * 2 = account); a legacy-sized buffer is identified by its length.
 */
function tokenAccountKind(data) {
  if (data.length === ACCOUNT_LEN) return 'account';
  if (data.length === MINT_LEN) return 'mint';
  if (data.length > ACCOUNT_LEN) {
    if (data[ACCOUNT_LEN] === 2) return 'account';
    if (data[ACCOUNT_LEN] === 1) return 'mint';
  }
  return null;
}

/** Parse one RPC account (base64) into the facts the kit needs. */
function parseAccount(acc, address) {
  if (acc === null) return { exists: false, lamports: 0n, ownerProgram: null, tokenOwner: null, mint: null, amount: null };
  if (typeof acc !== 'object') throw new Error(`${address}: malformed account in RPC response`);
  if (!Number.isSafeInteger(acc.lamports) || acc.lamports < 0) throw new Error(`${address}: malformed lamports in RPC response`);
  if (typeof acc.owner !== 'string') throw new Error(`${address}: malformed owner in RPC response`);
  const data = accountData(acc, address);
  const out = { exists: true, lamports: BigInt(acc.lamports), ownerProgram: acc.owner, tokenOwner: null, mint: null, amount: null };
  if (TOKEN_PROGRAMS.has(acc.owner) && tokenAccountKind(data) === 'account') {
    out.mint = b58encode(data.slice(0, 32));
    out.tokenOwner = b58encode(data.slice(32, 64));
    out.amount = u64(data, 64);
  }
  return out;
}

function valueArray(result, expected, method) {
  const value = result?.value;
  if (!Array.isArray(value) || value.length !== expected) throw new Error(`${method} returned a malformed result`);
  return value;
}

/** The wallet's token accounts under both token programs. */
async function walletTokenAccounts(rpc, wallet) {
  const out = [];
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    const result = await rpc.call('getTokenAccountsByOwner', [
      wallet, { programId }, { encoding: 'base64', commitment: 'confirmed' },
    ]);
    const value = result?.value;
    if (!Array.isArray(value)) throw new Error('getTokenAccountsByOwner returned a malformed result');
    for (const entry of value) {
      if (typeof entry?.pubkey !== 'string') throw new Error('getTokenAccountsByOwner returned a malformed entry');
      out.push(entry.pubkey);
    }
  }
  return out;
}

/** Decimals for each mint (null when the mint cannot be read). */
async function mintDecimals(rpc, mints) {
  const decimals = new Map();
  if (mints.length === 0) return decimals;
  const result = await rpc.call('getMultipleAccounts', [mints, { encoding: 'base64', commitment: 'confirmed' }]);
  const value = valueArray(result, mints.length, 'getMultipleAccounts');
  mints.forEach((mint, i) => {
    const acc = value[i];
    let d = null;
    if (acc && TOKEN_PROGRAMS.has(acc.owner)) {
      const data = accountData(acc, mint);
      if (tokenAccountKind(data) === 'mint' && data[45] === 1) d = data[44];
    }
    decimals.set(mint, d);
  });
  return decimals;
}

/**
 * Simulate `txBase64` and report the wallet's balance changes.
 *
 * Token rows cover every watched token account owned by the wallet before or
 * after. An account the wallet owns only afterwards (an ATA created in this
 * transaction) counts as its own from a zero balance; one it owned before but
 * not after (closed, or ownership handed away) counts down to zero, because
 * those tokens are no longer the wallet's.
 *
 * @param {{ call(method: string, params: any[]): Promise<any> }} rpc
 * @param {{ txBase64: string, wallet: string, sigVerify: boolean, watch?: string[] }} options
 */
export async function simulateWithDeltas(rpc, { txBase64, wallet, sigVerify, watch = [] }) {
  if (typeof txBase64 !== 'string' || txBase64.length === 0) throw new TypeError('txBase64 must be a non-empty string');
  if (typeof sigVerify !== 'boolean') throw new TypeError('sigVerify must be a boolean');
  decodePublicKey(wallet);
  for (const a of watch) decodePublicKey(a);

  const own = await walletTokenAccounts(rpc, wallet);
  const addresses = [...new Set([wallet, ...own, ...watch])];
  for (const a of addresses) decodePublicKey(a);
  // Truncating the watch set would hide balance changes, so a set too large to
  // simulate in one request is refused rather than trimmed.
  if (addresses.length > MAX_WATCH) {
    throw new Error(`too many accounts to watch (${addresses.length} > ${MAX_WATCH})`);
  }

  const preResult = await rpc.call('getMultipleAccounts', [addresses, { encoding: 'base64', commitment: 'confirmed' }]);
  const pre = valueArray(preResult, addresses.length, 'getMultipleAccounts').map((acc, i) => parseAccount(acc ?? null, addresses[i]));

  const simResult = await rpc.call('simulateTransaction', [txBase64, {
    encoding: 'base64',
    sigVerify,
    replaceRecentBlockhash: false,
    commitment: 'confirmed',
    accounts: { encoding: 'base64', addresses },
  }]);
  const sim = simResult?.value;
  if (!sim || typeof sim !== 'object') throw new Error('simulateTransaction returned a malformed result');
  const err = sim.err ?? null;
  const logs = Array.isArray(sim.logs) ? sim.logs.map(String) : [];
  const unitsConsumed = Number.isSafeInteger(sim.unitsConsumed) ? sim.unitsConsumed : null;

  let post;
  if (err === null) {
    if (!Array.isArray(sim.accounts) || sim.accounts.length !== addresses.length) {
      throw new Error('simulateTransaction returned no post-state for the watched accounts');
    }
    post = sim.accounts.map((acc, i) => parseAccount(acc ?? null, addresses[i]));
  } else {
    // A failed transaction changes nothing but the fee; policy denies it anyway.
    post = pre;
  }

  const rows = [];
  addresses.forEach((account, i) => {
    const a = pre[i];
    const b = post[i];
    const mine = (s) => s.mint !== null && s.tokenOwner === wallet;
    if (!mine(a) && !mine(b)) return;
    if (mine(a) && mine(b) && a.mint !== b.mint) {
      // Closed and re-opened for another mint inside one transaction: two assets.
      rows.push({ account, mint: a.mint, owner: wallet, pre: a.amount, post: 0n });
      rows.push({ account, mint: b.mint, owner: wallet, pre: 0n, post: b.amount });
      return;
    }
    rows.push({
      account,
      mint: mine(b) ? b.mint : a.mint,
      owner: wallet,
      pre: mine(a) ? a.amount : 0n,
      post: mine(b) ? b.amount : 0n,
    });
  });

  const decimals = await mintDecimals(rpc, [...new Set(rows.map((r) => r.mint))]);
  const tokens = rows.map((r) => ({ ...r, decimals: decimals.get(r.mint) ?? null }));

  const accounts = new Map(addresses.map((address, i) => {
    const s = post[i];
    return [address, { exists: s.exists, ownerProgram: s.ownerProgram, tokenOwner: s.tokenOwner, mint: s.mint }];
  }));

  return {
    ok: err === null,
    err,
    logs,
    unitsConsumed,
    lamports: { pre: pre[0].lamports, post: post[0].lamports },
    tokens,
    accounts,
  };
}
