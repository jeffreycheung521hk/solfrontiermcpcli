// Describe top-level instructions of a decoded transaction for policy and display.
//
// Only top-level instructions are decoded; cross-program invocations are not
// (SPEC L4) -- policy relies on simulated balance deltas for net effect. For
// the programs we know, a recognised instruction whose data or account list is
// too short throws: the runtime would reject it anyway, and describing it as
// something harmless would be a lie told to the approver. An unrecognised tag
// of a known program, or any instruction of an unknown program, is reported as
// kind 'unknown' with no amounts, and transaction policy decides what that means.
import { encode as encodeKey } from './base58.mjs';

export const PROGRAM_IDS = {
  system: '11111111111111111111111111111111',
  'spl-token': 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'spl-token-2022': 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  ata: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  'compute-budget': 'ComputeBudget111111111111111111111111111111',
  memo: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
};
const MEMO_V1 = 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo';

const PROGRAM_BY_ID = new Map(Object.entries(PROGRAM_IDS).map(([name, id]) => [id, name]));
PROGRAM_BY_ID.set(MEMO_V1, 'memo');

const SPL_NAMES = {
  0: 'initializeMint', 1: 'initializeAccount', 2: 'initializeMultisig', 3: 'transfer', 4: 'approve',
  5: 'revoke', 6: 'setAuthority', 7: 'mintTo', 8: 'burn', 9: 'closeAccount', 10: 'freezeAccount',
  11: 'thawAccount', 12: 'transferChecked', 13: 'approveChecked', 14: 'mintToChecked', 15: 'burnChecked',
  16: 'initializeAccount2', 17: 'syncNative', 18: 'initializeAccount3', 19: 'initializeMultisig2',
  20: 'initializeMint2', 21: 'getAccountDataSize', 22: 'initializeImmutableOwner',
  23: 'amountToUiAmount', 24: 'uiAmountToAmount',
};
const SYSTEM_NAMES = {
  0: 'createAccount', 1: 'assign', 2: 'transfer', 3: 'createAccountWithSeed', 4: 'advanceNonceAccount',
  5: 'withdrawNonceAccount', 6: 'initializeNonceAccount', 7: 'authorizeNonceAccount', 8: 'allocate',
  9: 'allocateWithSeed', 10: 'assignWithSeed', 11: 'transferWithSeed', 12: 'upgradeNonceAccount',
};
const AUTHORITY_TYPES = ['mintTokens', 'freezeAccount', 'accountOwner', 'closeAccount'];

const u32 = (d, off) => new DataView(d.buffer, d.byteOffset, d.byteLength).getUint32(off, true);
const u64 = (d, off) => new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(off, true);

function need(ix, dataLen, accounts, what) {
  if (ix.data.length < dataLen) throw new Error(`instruction ${ix.index}: ${what} data too short`);
  if (ix.accounts.length < accounts) throw new Error(`instruction ${ix.index}: ${what} needs ${accounts} accounts`);
}

function describeSystem(ix) {
  if (ix.data.length < 4) return { kind: 'unknown' };
  const tag = u32(ix.data, 0);
  const a = ix.accounts;
  switch (tag) {
    case 0:
      need(ix, 52, 2, 'createAccount');
      return { kind: 'createAccount', lamports: u64(ix.data, 4), source: a[0], destination: a[1] };
    case 2:
      need(ix, 12, 2, 'transfer');
      return { kind: 'transfer', lamports: u64(ix.data, 4), source: a[0], destination: a[1] };
    case 11:
      // transferWithSeed moves lamports too: [from, base, to].
      need(ix, 12, 3, 'transferWithSeed');
      return { kind: 'transferWithSeed', lamports: u64(ix.data, 4), source: a[0], destination: a[2], authority: a[1] };
    case 5:
      // withdrawNonceAccount: [nonce, to, recentBlockhashes, rent, authority]
      need(ix, 12, 5, 'withdrawNonceAccount');
      return { kind: 'withdrawNonceAccount', lamports: u64(ix.data, 4), source: a[0], destination: a[1], authority: a[4] };
    default:
      return { kind: SYSTEM_NAMES[tag] ?? 'unknown' };
  }
}

function describeToken(ix) {
  if (ix.data.length < 1) return { kind: 'unknown' };
  const tag = ix.data[0];
  const a = ix.accounts;
  switch (tag) {
    case 3:
      need(ix, 9, 3, 'transfer');
      return { kind: 'transfer', amount: u64(ix.data, 1), source: a[0], destination: a[1], authority: a[2] };
    case 12:
      need(ix, 10, 4, 'transferChecked');
      return {
        kind: 'transferChecked', amount: u64(ix.data, 1), decimals: ix.data[9],
        source: a[0], mint: a[1], destination: a[2], authority: a[3],
      };
    case 4:
      need(ix, 9, 3, 'approve');
      return { kind: 'approve', amount: u64(ix.data, 1), source: a[0], delegate: a[1], authority: a[2] };
    case 13:
      need(ix, 10, 4, 'approveChecked');
      return {
        kind: 'approveChecked', amount: u64(ix.data, 1), decimals: ix.data[9],
        source: a[0], mint: a[1], delegate: a[2], authority: a[3],
      };
    case 5:
      need(ix, 1, 2, 'revoke');
      return { kind: 'revoke', source: a[0], authority: a[1] };
    case 6: {
      need(ix, 3, 2, 'setAuthority');
      const hasNew = ix.data[2];
      if (hasNew !== 0 && hasNew !== 1) throw new Error(`instruction ${ix.index}: setAuthority option tag invalid`);
      if (hasNew === 1 && ix.data.length < 35) throw new Error(`instruction ${ix.index}: setAuthority data too short`);
      return {
        kind: 'setAuthority', source: a[0], authority: a[1],
        authorityType: AUTHORITY_TYPES[ix.data[1]] ?? `type-${ix.data[1]}`,
        newAuthority: hasNew === 1 ? encodeKey(ix.data.slice(3, 35)) : null,
      };
    }
    case 9:
      need(ix, 1, 3, 'closeAccount');
      return { kind: 'closeAccount', source: a[0], destination: a[1], authority: a[2] };
    case 17:
      need(ix, 1, 1, 'syncNative');
      return { kind: 'syncNative', source: a[0] };
    case 7:
      need(ix, 9, 3, 'mintTo');
      return { kind: 'mintTo', amount: u64(ix.data, 1), mint: a[0], destination: a[1], authority: a[2] };
    case 8:
      need(ix, 9, 3, 'burn');
      return { kind: 'burn', amount: u64(ix.data, 1), source: a[0], mint: a[1], authority: a[2] };
    case 15:
      need(ix, 10, 3, 'burnChecked');
      return { kind: 'burnChecked', amount: u64(ix.data, 1), decimals: ix.data[9], source: a[0], mint: a[1], authority: a[2] };
    default:
      return { kind: SPL_NAMES[tag] ?? 'unknown' };
  }
}

function describeAta(ix) {
  let kind;
  if (ix.data.length === 0 || (ix.data.length === 1 && ix.data[0] === 0)) kind = 'create';
  else if (ix.data.length === 1 && ix.data[0] === 1) kind = 'createIdempotent';
  else if (ix.data.length === 1 && ix.data[0] === 2) return { kind: 'recoverNested' };
  else return { kind: 'unknown' };
  // [payer, associatedAccount, walletOwner, mint, systemProgram, tokenProgram]
  need(ix, 0, 4, kind);
  const a = ix.accounts;
  return { kind, source: a[0], destination: a[1], authority: a[2], mint: a[3] };
}

function describeComputeBudget(ix) {
  const tag = ix.data[0];
  switch (tag) {
    case 1:
      need(ix, 5, 0, 'requestHeapFrame');
      return { kind: 'requestHeapFrame', bytes: u32(ix.data, 1) };
    case 2:
      need(ix, 5, 0, 'setComputeUnitLimit');
      return { kind: 'setComputeUnitLimit', units: u32(ix.data, 1) };
    case 3:
      need(ix, 9, 0, 'setComputeUnitPrice');
      return { kind: 'setComputeUnitPrice', microLamports: u64(ix.data, 1) };
    case 4:
      need(ix, 5, 0, 'setLoadedAccountsDataSizeLimit');
      return { kind: 'setLoadedAccountsDataSizeLimit', bytes: u32(ix.data, 1) };
    default:
      return { kind: 'unknown' };
  }
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });

function describeMemo(ix) {
  let text;
  try {
    text = UTF8.decode(ix.data);
  } catch {
    throw new Error(`instruction ${ix.index}: memo is not valid UTF-8`);
  }
  return { kind: 'memo', text };
}

const DESCRIBERS = {
  system: describeSystem,
  'spl-token': describeToken,
  'spl-token-2022': describeToken,
  ata: describeAta,
  'compute-budget': describeComputeBudget,
  memo: describeMemo,
};

/**
 * Describe each top-level instruction. Amounts are BigInt (raw units).
 * @param {ReturnType<import('./tx.mjs').decodeTransaction>} decoded
 * @param {{ keys: string[] }} resolved  from resolveAccountKeys
 * @returns {Array<{ index: number, programId: string, program: string, kind: string,
 *   lamports?: bigint, amount?: bigint, decimals?: number, mint?: string, source?: string,
 *   destination?: string, authority?: string, delegate?: string, text?: string }>}
 */
export function describeInstructions(decoded, resolved) {
  return decoded.instructions.map((raw, index) => {
    const key = (i) => {
      const k = resolved.keys[i];
      if (k === undefined) throw new Error(`instruction ${index}: account index ${i} not resolved`);
      return k;
    };
    const programId = key(raw.programIdIndex);
    const program = PROGRAM_BY_ID.get(programId) ?? 'unknown';
    const ix = { index, data: raw.data, accounts: raw.accountIndexes.map(key) };
    const fields = program === 'unknown' ? { kind: 'unknown' } : DESCRIBERS[program](ix);
    return { index, programId, program, ...fields };
  });
}
