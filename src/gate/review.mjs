// reviewTransaction: the one path every transaction takes before a human is
// asked anything (SPEC §5.5).
//
//   1. decode + resolve lookup tables      → tx_decode_failed
//   2. static rules (no RPC)               → program / delegation / legacy transfer
//   3. simulate                            → rpc_unavailable, simulation_failed
//   4. simulation rules                    → destinations, outflow caps, unlisted mints
//   5. verdict                             → deny | hold | allow
//
// Each stage stops the review if its rule set produced a deny-level finding,
// after collecting every finding of that set. So a transaction that fails to
// decode is never simulated, and a statically denied one never reaches
// simulateTransaction: nothing the cluster says can rescue it, and nothing is
// learned by asking.
//
// Every failure resolves to verdict "deny" (I7). The returned Review is
// JSON-safe (SPEC §5.3): BigInt stays inside this module and tx-policy.mjs.
import { decodeTransaction, messageSha256, resolveAccountKeys } from '../solana/tx.mjs';
import { fetchLookupTables } from '../solana/alt.mjs';
import { describeInstructions } from '../solana/instructions.mjs';
import { simulateWithDeltas } from '../solana/simulate.mjs';
import { decodePublicKey } from '../solana/base58.mjs';
import {
  assetChanges, compileTxPolicy, destinationFindings, finding, flowFindings, formatUnits,
  isCompiledTxPolicy, staticFindings, watchAddresses,
} from './tx-policy.mjs';

const SYMBOLS = new Map([['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'USDC']]);
const MINUS = '−';
const ELLIPSIS = '…';
const MAX_DETAIL = 200;

// Error text that ends up in a Review (and so in the audit log and on the
// approval page): one line, bounded. RPC errors arrive already scrubbed of the
// upstream URL by SolanaRpc (I4); Gate's redactor runs again at the boundary.
function detail(err) {
  const text = String(err?.message ?? err).replace(/\s+/g, ' ').trim();
  return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}${ELLIPSIS}` : text;
}

// The cluster's `err` is JSON already; this only guards against a caller's
// rpc object handing back something JSON.stringify would throw on.
function jsonSafe(value) {
  try {
    return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) ?? 'null');
  } catch {
    return String(value);
  }
}

/** An Ix with every BigInt (lamports, amount, microLamports) as a raw-unit decimal string. */
function jsonIx(ix) {
  return Object.fromEntries(Object.entries(ix).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v]));
}

const shortProgram = (id) => `${id.slice(0, 4)}${ELLIPSIS}`;
// Mints get both ends: a ground "USDC…" prefix must not read as USDC.
const symbol = (asset) => (asset === 'SOL' ? 'SOL' : SYMBOLS.get(asset) ?? `${asset.slice(0, 4)}${ELLIPSIS}${asset.slice(-4)}`);

/**
 * One line for the notification and the approval message, e.g.
 * "−0.001005 SOL, +0.17 USDC · JUP6… · 4 ix". Amounts are exact, signed from
 * the wallet's point of view; `note` stands in when there are none.
 */
function summaryLine({ assets = [], instructions = [], note }) {
  const amounts = assets.filter((a) => a.net !== 0n).map((a) => {
    const raw = a.net < 0n ? -a.net : a.net;
    const sign = a.net < 0n ? MINUS : '+';
    return a.decimals === null
      ? `${sign}${raw} raw ${symbol(a.asset)}`
      : `${sign}${formatUnits(raw, a.decimals)} ${symbol(a.asset)}`;
  });
  const parts = [amounts.length > 0 ? amounts.join(', ') : note];
  const unknown = instructions.find((ix) => ix.program === 'unknown');
  if (unknown) parts.push(shortProgram(unknown.programId));
  parts.push(`${instructions.length} ix`);
  return parts.join(' · ');
}

/**
 * Review a transaction against transaction policy (SPEC §5.5).
 *
 * Throws only on caller mistakes (a wallet that is not an address, `signed`
 * not a boolean, an invalid policy); everything about the transaction itself
 * -- including RPC trouble -- comes back as a Review with verdict "deny".
 *
 * @param {object} input
 * @param {Uint8Array} input.bytes  the serialized transaction
 * @param {string} input.wallet  base58 address whose balances are judged (the petty-cash key)
 * @param {{ call(method: string, params: any[]): Promise<any> }} input.rpc
 * @param {object} input.txPolicy  compileTxPolicy() output, or the raw `tx` config section
 * @param {Record<string, string[]>} [input.lists]  config.lists, used when txPolicy is raw
 * @param {string} [input.cluster]  accepted for the pipeline's convenience; review does not depend on it
 * @param {boolean} input.signed  true for a signed send (simulate with sigVerify)
 * @returns {Promise<object>} Review
 */
export async function reviewTransaction({ bytes, wallet, rpc, txPolicy, lists = {}, signed }) {
  decodePublicKey(wallet);
  if (typeof signed !== 'boolean') throw new TypeError('reviewTransaction: signed must be a boolean');
  const policy = isCompiledTxPolicy(txPolicy) ? txPolicy : compileTxPolicy(txPolicy, lists);

  const review = {
    messageSha256: null,
    version: null,
    feePayer: null,
    programs: [],
    instructions: [],
    sim: null,
    outflow: {},
    inflow: {},
    verdict: 'deny',
    violations: [],
    warnings: [],
    summaryLine: '',
  };

  // 1. Decode, resolve lookup tables, describe. Any failure: deny.
  let instructions;
  try {
    if (!(bytes instanceof Uint8Array)) throw new TypeError('transaction bytes must be a Uint8Array');
    const decoded = decodeTransaction(bytes);
    review.messageSha256 = messageSha256(decoded);
    review.version = decoded.version;
    review.feePayer = decoded.staticAccountKeys[0];
    const tables = decoded.addressTableLookups.length > 0
      ? await fetchLookupTables(rpc, decoded.addressTableLookups.map((l) => l.accountKey))
      : new Map();
    instructions = describeInstructions(decoded, resolveAccountKeys(decoded, tables));
  } catch (err) {
    review.violations.push(finding('tx_decode_failed', 'transaction', detail(err),
      'a well-formed legacy or v0 transaction', `transaction could not be decoded: ${detail(err)}`));
    const size = bytes instanceof Uint8Array ? `${bytes.length} bytes` : 'no bytes';
    review.summaryLine = `undecodable transaction (${size})`;
    return review;
  }
  review.programs = [...new Set(instructions.map((ix) => ix.programId))];
  review.instructions = instructions.map(jsonIx);

  // 2. Static rules.
  const statics = staticFindings(policy, instructions);
  review.warnings.push(...statics.warnings);
  if (statics.violations.length > 0) {
    review.violations.push(...statics.violations);
    review.summaryLine = summaryLine({ instructions, note: 'not simulated' });
    return review;
  }

  // 3. Simulate. A throw is the RPC (or its answer) failing us; `err` is the
  // cluster saying the transaction fails.
  let sim;
  try {
    sim = await simulateWithDeltas(rpc, {
      txBase64: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64'),
      wallet,
      sigVerify: signed,
      watch: watchAddresses(instructions, wallet),
    });
  } catch (err) {
    review.violations.push(finding('rpc_unavailable', 'sim', detail(err), 'a simulation result',
      `simulation could not be run: ${detail(err)}`));
    review.summaryLine = summaryLine({ instructions, note: 'not simulated' });
    return review;
  }
  review.sim = { ok: sim.ok, err: jsonSafe(sim.err), logs: sim.logs, unitsConsumed: sim.unitsConsumed };
  if (!sim.ok) {
    const err = JSON.stringify(review.sim.err);
    review.violations.push(finding('simulation_failed', 'sim.err', err.length > MAX_DETAIL ? `${err.slice(0, MAX_DETAIL)}${ELLIPSIS}` : err,
      'null', `the cluster rejects this transaction in simulation: ${err.slice(0, MAX_DETAIL)}`));
    review.summaryLine = summaryLine({ instructions, note: 'simulation failed' });
    return review;
  }

  // 4. Simulation rules: destinations, then outflow.
  const assets = assetChanges(sim);
  const dest = destinationFindings(policy, { instructions, wallet, accounts: sim.accounts });
  const flow = flowFindings(policy, assets);
  review.outflow = flow.outflow;
  review.inflow = flow.inflow;
  review.violations.push(...dest.violations, ...flow.violations);
  review.warnings.push(...flow.warnings);
  review.summaryLine = summaryLine({ assets, instructions, note: 'no balance change' });
  if (review.violations.length > 0) return review;

  // 5. Verdict. "never" exists for tests only (I2).
  review.verdict = policy.approval === 'never' ? 'allow' : 'hold';
  return review;
}
