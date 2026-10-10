// Address lookup tables: the v0 feature that lets a transaction name accounts
// by (table, index) instead of by key. Gate must resolve them before it can
// say which accounts a transaction touches, so a table that is missing,
// malformed or not owned by the lookup-table program is an error, never an
// empty list (I7).
import { encode as b58encode, decodePublicKey } from './base58.mjs';

export const ALT_PROGRAM_ID = 'AddressLookupTab1e1111111111111111111111111';
const META_SIZE = 56; // u32 state tag, deactivation slot, last extended slot + index, authority option, padding
const MAX_PER_CALL = 100; // getMultipleAccounts limit

/**
 * Parse lookup-table account data into its addresses.
 * @param {Uint8Array} data
 * @returns {string[]}
 */
export function parseLookupTable(data) {
  if (!(data instanceof Uint8Array)) throw new TypeError('parseLookupTable expects a Uint8Array');
  if (data.length < META_SIZE) throw new Error('lookup table data too short');
  if ((data.length - META_SIZE) % 32 !== 0) throw new Error('lookup table data is not a whole number of addresses');
  const tag = data[0] | (data[1] << 8) | (data[2] << 16) | (data[3] << 24);
  if (tag !== 1) throw new Error('account is not an initialized lookup table');
  const out = [];
  for (let off = META_SIZE; off < data.length; off += 32) out.push(b58encode(data.slice(off, off + 32)));
  return out;
}

/**
 * Fetch and parse lookup tables. `rpc` is anything with `call(method, params)`.
 * @param {{ call(method: string, params: any[]): Promise<any> }} rpc
 * @param {string[]} keys
 * @returns {Promise<Map<string, string[]>>}
 */
export async function fetchLookupTables(rpc, keys) {
  const unique = [...new Set(keys)];
  for (const k of unique) decodePublicKey(k);
  const tables = new Map();
  for (let i = 0; i < unique.length; i += MAX_PER_CALL) {
    const chunk = unique.slice(i, i + MAX_PER_CALL);
    const result = await rpc.call('getMultipleAccounts', [chunk, { encoding: 'base64', commitment: 'confirmed' }]);
    const value = result?.value;
    if (!Array.isArray(value) || value.length !== chunk.length) throw new Error('getMultipleAccounts returned a malformed result');
    chunk.forEach((key, j) => {
      const acc = value[j];
      if (acc === null || acc === undefined) throw new Error(`address lookup table ${key} does not exist`);
      if (acc.owner !== ALT_PROGRAM_ID) throw new Error(`account ${key} is not owned by the address lookup table program`);
      tables.set(key, parseLookupTable(accountData(acc, key)));
    });
  }
  return tables;
}

/** The bytes of an RPC account object fetched with encoding base64. */
export function accountData(acc, key = 'account') {
  const d = acc?.data;
  if (!Array.isArray(d) || d[1] !== 'base64' || typeof d[0] !== 'string') {
    throw new Error(`${key}: account data is not base64-encoded`);
  }
  return new Uint8Array(Buffer.from(d[0], 'base64'));
}
