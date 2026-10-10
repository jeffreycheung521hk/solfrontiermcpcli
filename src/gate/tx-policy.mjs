// Transaction policy: compile the `tx` config section and evaluate its rules
// (SPEC §5.1 `tx`, §5.5).
//
// Compilation runs at load time, so a typo in an address or a cap costs an
// exit 2 before Gate guards anything, not a confusing refusal later. The rule
// functions are pure: review.mjs feeds them decoded instructions and simulated
// balance changes and decides what order they run in.
//
// Amounts never touch floating point. A cap written as the JSON number 0.05 is
// turned into the exact decimal "0.05" once, here, and every comparison after
// that is BigInt arithmetic on raw units. An approver who reads "exceeds 0.05
// by 0.450005" is reading exact numbers.
import { decodePublicKey } from '../solana/base58.mjs';
import { UsageError } from '../cli/exit-codes.mjs';

export const NATIVE_MINT = 'So11111111111111111111111111111111111111112';
export const SOL_DECIMALS = 9;

const TX_KEYS = new Set([
  'programs', 'unknownProgram', 'maxOutflow', 'unknownMintOutflow', 'destinations',
  'denyTokenDelegation', 'denyLegacyTokenTransfer', 'approval',
]);
const DENY_OR_WARN = ['deny', 'warn'];
const APPROVAL_MODES = ['always', 'never'];
const TOKEN_PROGRAMS = new Set(['spl-token', 'spl-token-2022']);

// Instructions that hand control of a token account (or mint) to someone else.
const DELEGATION_KINDS = new Set(['approve', 'approveChecked', 'setAuthority']);

// Top-level instructions whose `destination` receives value. SPEC §5.5 names
// System transfer and SPL transfer / transferChecked; the rest also move
// lamports to `destination` (T3 questions #6), so leaving them out would be a
// way around the destination rule.
const VALUE_DESTINATIONS = {
  system: new Set(['transfer', 'transferWithSeed', 'withdrawNonceAccount']),
  'spl-token': new Set(['transfer', 'transferChecked', 'closeAccount']),
  'spl-token-2022': new Set(['transfer', 'transferChecked', 'closeAccount']),
};

// Policies built by compileTxPolicy, so review can tell a compiled policy from
// a raw config object without trusting a property anyone could set.
const compiled = new WeakSet();

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A Violation (SPEC §5.3). `observed` / `bound` are strings, never BigInt. */
export function finding(code, path, observed, bound, message) {
  return { code, path, observed, bound, message };
}

// --- exact decimals ---------------------------------------------------------
// A decimal is { units, scale } meaning units / 10^scale, units ≥ 0n.

const DECIMAL_TEXT = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

function decimalFromText(text) {
  const m = DECIMAL_TEXT.exec(text);
  if (!m) return null;
  let digits = m[1] + (m[2] ?? '');
  let scale = (m[2] ?? '').length - (m[3] === undefined ? 0 : Number.parseInt(m[3], 10));
  if (scale < 0) {
    digits += '0'.repeat(-scale);
    scale = 0;
  }
  let units = BigInt(digits);
  while (scale > 0 && units % 10n === 0n) {
    units /= 10n;
    scale -= 1;
  }
  return { units, scale };
}

/**
 * Parse a cap written in UI units: a JSON number (as the example configs do)
 * or a plain decimal string. Numbers go through their shortest round-trip
 * text, which is exactly what the config author wrote for any value with up
 * to 15 significant digits; exponent forms (1e-7) are expanded exactly.
 * @returns {{ units: bigint, scale: number } | null}  null when not a valid non-negative amount
 */
export function parseUiAmount(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return null;
    return decimalFromText(String(value));
  }
  if (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value)) return decimalFromText(value);
  return null;
}

/**
 * Raw units → exact decimal string, trailing zeros trimmed (170000n, 6 → "0.17").
 * @param {bigint} raw
 * @param {number} decimals
 */
export function formatUnits(raw, decimals) {
  if (raw < 0n) return `-${formatUnits(-raw, decimals)}`;
  const s = raw.toString().padStart(decimals + 1, '0');
  const int = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, '');
  return frac ? `${int}.${frac}` : int;
}

/**
 * Compare a raw amount with `decimals` against a cap, exactly.
 * @returns {{ exceeds: boolean, excess: string }}  excess is a UI-unit decimal string
 */
export function compareToCap(raw, decimals, cap) {
  const lhs = raw * 10n ** BigInt(cap.scale);
  const rhs = cap.units * 10n ** BigInt(decimals);
  return { exceeds: lhs > rhs, excess: lhs > rhs ? formatUnits(lhs - rhs, decimals + cap.scale) : '0' };
}

// --- compile ----------------------------------------------------------------

function address(value, where) {
  if (typeof value !== 'string') throw new UsageError(`${where} must be a base58 address string`);
  try {
    decodePublicKey(value);
  } catch {
    throw new UsageError(`${where} is not a valid base58 32-byte address: ${JSON.stringify(value.slice(0, 64))}`);
  }
  return value;
}

function oneOf(value, allowed, fallback, where) {
  if (value === undefined) return fallback;
  if (!allowed.includes(value)) throw new UsageError(`${where} must be one of ${allowed.map((a) => `"${a}"`).join(' | ')}`);
  return value;
}

function bool(value, fallback, where) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new UsageError(`${where} must be true or false`);
  return value;
}

function compileDestinations(value, lists) {
  if (value === 'any') return Object.freeze({ any: true, set: new Set(), label: '"any"' });
  // No destinations configured: only the wallet's own accounts (fail closed).
  if (value === undefined) return Object.freeze({ any: false, set: new Set(), label: 'tx.destinations (none configured)' });
  if (typeof value === 'string') {
    if (!value.startsWith('@') || value.length < 2) {
      throw new UsageError('tx.destinations must be "any", "@<list name>" or an array of addresses');
    }
    const name = value.slice(1);
    const list = Object.hasOwn(lists, name) ? lists[name] : undefined;
    if (!Array.isArray(list)) throw new UsageError(`tx.destinations names list "${name}", which is not defined in lists`);
    const set = new Set(list.map((a, i) => address(a, `lists.${name}[${i}]`)));
    return Object.freeze({ any: false, set, label: value });
  }
  if (Array.isArray(value)) {
    const set = new Set(value.map((a, i) => address(a, `tx.destinations[${i}]`)));
    return Object.freeze({ any: false, set, label: 'tx.destinations' });
  }
  throw new UsageError('tx.destinations must be "any", "@<list name>" or an array of addresses');
}

function compileMaxOutflow(value) {
  if (!isPlainObject(value)) {
    throw new UsageError('tx.maxOutflow must be an object with at least "SOL" (every transaction pays a fee)');
  }
  const caps = new Map();
  for (const [key, cap] of Object.entries(value)) {
    if (key.startsWith('_')) continue;
    const where = `tx.maxOutflow["${key}"]`;
    if (key !== 'SOL') {
      address(key, `${where} (mint)`);
      // Wrapped SOL is folded into SOL (SPEC §5.5 step 4); a second cap on it
      // would never be consulted, which is worse than refusing to start.
      if (key === NATIVE_MINT) throw new UsageError(`${where}: wrapped SOL counts toward "SOL"; cap it there`);
    }
    const parsed = parseUiAmount(cap);
    if (parsed === null) throw new UsageError(`${where} must be a non-negative number or decimal string in UI units`);
    caps.set(key, Object.freeze({ ...parsed, text: formatUnits(parsed.units, parsed.scale) }));
  }
  if (!caps.has('SOL')) throw new UsageError('tx.maxOutflow.SOL is required (every transaction pays a fee)');
  return caps;
}

/**
 * Validate the `tx` config section and resolve its list references.
 * Throws UsageError (exit 2) on any mistake: an invalid address in `programs`,
 * `destinations` or the list it names, an invalid mint or amount in
 * `maxOutflow`, a missing list, an unknown key or enum value.
 * @param {object} txConfig  config.tx
 * @param {Record<string, string[]>} [lists]  config.lists
 */
export function compileTxPolicy(txConfig = {}, lists = {}) {
  if (!isPlainObject(txConfig)) throw new UsageError('tx must be an object');
  if (!isPlainObject(lists)) throw new UsageError('lists must be an object of string arrays');
  for (const k of Object.keys(txConfig)) {
    if (!k.startsWith('_') && !TX_KEYS.has(k)) throw new UsageError(`unknown key tx.${k}`);
  }
  const programs = txConfig.programs ?? [];
  if (!Array.isArray(programs)) throw new UsageError('tx.programs must be an array of program addresses');

  const policy = Object.freeze({
    programs: new Set(programs.map((p, i) => address(p, `tx.programs[${i}]`))),
    unknownProgram: oneOf(txConfig.unknownProgram, DENY_OR_WARN, 'deny', 'tx.unknownProgram'),
    maxOutflow: compileMaxOutflow(txConfig.maxOutflow),
    unknownMintOutflow: oneOf(txConfig.unknownMintOutflow, DENY_OR_WARN, 'deny', 'tx.unknownMintOutflow'),
    destinations: compileDestinations(txConfig.destinations, lists),
    denyTokenDelegation: bool(txConfig.denyTokenDelegation, true, 'tx.denyTokenDelegation'),
    denyLegacyTokenTransfer: bool(txConfig.denyLegacyTokenTransfer, true, 'tx.denyLegacyTokenTransfer'),
    approval: oneOf(txConfig.approval, APPROVAL_MODES, 'always', 'tx.approval'),
  });
  compiled.add(policy);
  return policy;
}

/** True only for objects returned by compileTxPolicy. */
export function isCompiledTxPolicy(value) {
  return value !== null && typeof value === 'object' && compiled.has(value);
}

// --- rules ------------------------------------------------------------------

/**
 * Static rules (SPEC §5.5 step 2): no RPC, decoded top-level instructions only.
 * Every finding of the set is collected; `unknownProgram: "warn"` turns
 * program findings into warnings.
 * @returns {{ violations: object[], warnings: object[] }}
 */
export function staticFindings(policy, instructions) {
  const violations = [];
  const warnings = [];

  const reported = new Set();
  for (const ix of instructions) {
    if (policy.programs.has(ix.programId) || reported.has(ix.programId)) continue;
    reported.add(ix.programId);
    const f = finding('program_not_allowed', `instructions[${ix.index}].programId`, ix.programId, 'tx.programs',
      `instruction ${ix.index} calls program ${ix.programId}, which is not in tx.programs`);
    (policy.unknownProgram === 'deny' ? violations : warnings).push(f);
  }

  // Whose account an approve / setAuthority touches cannot be known without
  // RPC (a multisig or PDA authority hides it), so with the rule on, every
  // one of them is refused.
  if (policy.denyTokenDelegation) {
    for (const ix of instructions) {
      if (!TOKEN_PROGRAMS.has(ix.program) || !DELEGATION_KINDS.has(ix.kind)) continue;
      const what = ix.kind === 'setAuthority'
        ? `changes the ${ix.authorityType} authority of ${ix.source} to ${ix.newAuthority ?? 'nobody'}`
        : `lets ${ix.delegate} spend up to ${ix.amount} raw units from ${ix.source}`;
      violations.push(finding('token_delegation_denied', `instructions[${ix.index}]`, `${ix.program} ${ix.kind}`,
        'tx.denyTokenDelegation', `instruction ${ix.index} (${ix.program} ${ix.kind}) ${what}; tx.denyTokenDelegation forbids it`));
    }
  }

  if (policy.denyLegacyTokenTransfer) {
    for (const ix of instructions) {
      if (!TOKEN_PROGRAMS.has(ix.program) || ix.kind !== 'transfer') continue;
      violations.push(finding('legacy_token_transfer_denied', `instructions[${ix.index}]`, `${ix.program} transfer`,
        'tx.denyLegacyTokenTransfer',
        `instruction ${ix.index} is an SPL Token Transfer (tag 3), which names no mint; use transferChecked`));
    }
  }

  return { violations, warnings };
}

/**
 * Addresses simulation must watch so the simulation rules can see them:
 * every value destination, plus accounts the transaction may create or fund
 * for the wallet (ATA create, syncNative) so their post-state is known.
 * @returns {string[]}
 */
export function watchAddresses(instructions, wallet) {
  const out = new Set();
  for (const ix of instructions) {
    if (VALUE_DESTINATIONS[ix.program]?.has(ix.kind) && ix.destination) out.add(ix.destination);
    if (ix.program === 'ata' && (ix.kind === 'create' || ix.kind === 'createIdempotent')) out.add(ix.destination);
    if (TOKEN_PROGRAMS.has(ix.program) && ix.kind === 'syncNative') out.add(ix.source);
  }
  out.delete(wallet);
  return [...out];
}

/**
 * Destination rule (SPEC §5.5 step 4). A destination is allowed if it is the
 * wallet, a token account the wallet owns in the post-simulation state (an
 * ATA created in this transaction included), in the destinations list, or
 * the list is "any".
 * @param {object} policy
 * @param {{ instructions: object[], wallet: string, accounts: Map<string, { tokenOwner: string|null }> }} input
 * @returns {{ violations: object[] }}
 */
export function destinationFindings(policy, { instructions, wallet, accounts }) {
  const violations = [];
  if (policy.destinations.any) return { violations };
  for (const ix of instructions) {
    if (!VALUE_DESTINATIONS[ix.program]?.has(ix.kind)) continue;
    const dest = ix.destination;
    if (dest === wallet) continue;
    if (accounts.get(dest)?.tokenOwner === wallet) continue;
    if (policy.destinations.set.has(dest)) continue;
    violations.push(finding('destination_not_allowed', `instructions[${ix.index}].destination`, String(dest),
      policy.destinations.label,
      `instruction ${ix.index} (${ix.program} ${ix.kind}) sends to ${dest}, which is not the wallet, `
      + `not a token account the wallet owns after simulation, and not in ${policy.destinations.label}`));
  }
  return { violations };
}

/**
 * Net balance change per asset from simulateWithDeltas output, BigInt raw
 * units. SOL = wallet lamports delta + wrapped SOL token delta (one lamport
 * per raw unit), so fees and rent count. SOL first, then mints in the order
 * simulation reported them.
 * @returns {{ asset: string, net: bigint, decimals: number|null }[]}
 */
export function assetChanges({ lamports, tokens }) {
  let sol = lamports.post - lamports.pre;
  const mints = new Map();
  for (const t of tokens) {
    const delta = t.post - t.pre;
    if (t.mint === NATIVE_MINT) {
      sol += delta;
      continue;
    }
    const row = mints.get(t.mint) ?? { asset: t.mint, net: 0n, decimals: t.decimals };
    row.net += delta;
    if (row.decimals !== t.decimals) row.decimals = null;
    mints.set(t.mint, row);
  }
  return [{ asset: 'SOL', net: sol, decimals: SOL_DECIMALS }, ...mints.values()];
}

const capPath = (asset) => (asset === 'SOL' ? 'tx.maxOutflow.SOL' : `tx.maxOutflow["${asset}"]`);

/**
 * Outflow rules (SPEC §5.5 step 4) and the outflow / inflow maps: UI-unit
 * decimal strings keyed by "SOL" or the mint address, positive = leaving
 * (outflow) or arriving (inflow). A mint whose decimals are unknown is shown
 * in raw units with a warning, and compared with its cap as if it had zero
 * decimals: the smallest raw bound the cap could mean.
 * @returns {{ violations: object[], warnings: object[], outflow: object, inflow: object }}
 */
export function flowFindings(policy, assets) {
  const violations = [];
  const warnings = [];
  const outflow = {};
  const inflow = {};
  for (const { asset, net, decimals } of assets) {
    if (net === 0n) continue;
    const raw = net < 0n ? -net : net;
    const known = decimals !== null;
    const scale = known ? decimals : 0;
    const amount = formatUnits(raw, scale);
    (net < 0n ? outflow : inflow)[asset] = amount;
    if (!known) {
      warnings.push(finding('mint_decimals_unknown', `${net < 0n ? 'outflow' : 'inflow'}.${asset}`, amount, 'raw units',
        `decimals of mint ${asset} could not be read; its amount is shown in raw units`));
    }
    if (net > 0n) continue;

    const cap = policy.maxOutflow.get(asset);
    if (cap) {
      const { exceeds, excess } = compareToCap(raw, scale, cap);
      if (exceeds) {
        const label = asset === 'SOL' ? 'SOL outflow (lamports, fees, rent and wrapped SOL)' : `outflow of mint ${asset}`;
        violations.push(finding('outflow_exceeds_bound', `outflow.${asset}`, amount, cap.text,
          `${label} ${amount}${known ? '' : ' (raw units)'} exceeds ${capPath(asset)} = ${cap.text} by ${excess}`));
      }
      continue;
    }
    const f = finding('mint_not_allowed', `outflow.${asset}`, amount, 'tx.maxOutflow',
      `${amount}${known ? '' : ' raw units'} of mint ${asset} would leave the wallet; the mint has no cap in tx.maxOutflow`
      + ` (tx.unknownMintOutflow is "${policy.unknownMintOutflow}")`);
    (policy.unknownMintOutflow === 'deny' ? violations : warnings).push(f);
  }
  return { violations, warnings, outflow, inflow };
}
