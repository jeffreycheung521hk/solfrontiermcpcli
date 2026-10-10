// Tool checkpoint: compile the `tools` policy once, decide every tools/call
// against it (SPEC §5.2, §5.3, I1).
//
// Design notes:
//  * Compiled at load time, before anything is spawned. Every mistake an
//    operator can make in `tools` (unknown mode, unknown constraint key, a
//    `@list` that does not exist, a txArg naming nothing, a rule for a server
//    that is not configured) is an exit 2 then, never a surprise at call time.
//    A rule for a misspelt server is refused rather than ignored: next to a
//    broader `pass` glob, a silently dead `deny` rule would let a tool through.
//  * Default deny (I1). A tool no rule names, or that only the `"*"`
//    catch-all names, is `unknown_tool`: hidden and refused. An explicit rule
//    set to "deny" is `tool_denied`. `"*"` may only be "deny".
//  * `bound` constraints are checked exhaustively: every violation is
//    reported, so the agent can re-plan in one step instead of discovering
//    the bounds one retry at a time.
//  * `number-string` amounts are compared as BigInts scaled by 10^18, never as
//    floats: a double rounds "0.050000000000000001" to 0.05, this does not.
//  * Everything returned is JSON-safe (strings and numbers, SPEC §5.3). BigInt
//    lives only inside the compiled policy.
import { UsageError } from '../cli/exit-codes.mjs';

export const TOOL_MODES = Object.freeze(['pass', 'bound', 'deny']);
export const CONSTRAINT_TYPES = Object.freeze(['number', 'integer', 'string', 'number-string']);
export const TX_ARG_ENCODINGS = Object.freeze(['base64', 'base58']);

/** The stable refusal codes (SPEC §5.3), shared by every checkpoint. */
export const REFUSAL_CODES = Object.freeze([
  'unknown_tool', 'tool_denied', 'arg_missing', 'arg_type', 'arg_out_of_bounds', 'arg_not_allowed',
  'arg_pattern', 'tx_decode_failed', 'rpc_unavailable', 'simulation_failed', 'program_not_allowed',
  'outflow_exceeds_bound', 'mint_not_allowed', 'destination_not_allowed', 'token_delegation_denied',
  'legacy_token_transfer_denied', 'approval_rejected', 'approval_timeout', 'approval_unavailable',
  'downstream_error', 'unsolicited_send',
]);

/** Decimal places a `number-string` may carry; also its BigInt scale. */
export const DECIMAL_PLACES = 18;

const RULE_KEYS = new Set(['mode', 'args', 'txArg', 'txArgEncoding']);
const CONSTRAINT_KEYS = new Set(['type', 'required', 'lte', 'gte', 'in', 'pattern']);
const SERVER_RE = /^[a-z0-9-]{1,16}$/;
// A tool part may hold `*`; the rest is what a host-safe tool name can hold
// (SPEC §5.2), so a dot or a space here could never match anything.
const TOOL_PATTERN_RE = /^[A-Za-z0-9_*-]{1,64}$/;
const TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DECIMAL_RE = /^(-?)([0-9]+)(?:\.([0-9]+))?$/;
// No real amount needs more; the cap keeps a megabyte of digits out of BigInt().
const DECIMAL_MAX_LENGTH = 80;
const SCALE = 10n ** BigInt(DECIMAL_PLACES);
const OBSERVED_MAX = 120;
const IN_DISPLAY_MAX = 5;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const quote = (v) => JSON.stringify(v);

function freezeAll(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value) && !(value instanceof Map) && !(value instanceof Set)) {
    Object.freeze(value);
    for (const v of Object.values(value)) freezeAll(v);
  }
  return value;
}

// --- decimals ---------------------------------------------------------------

/**
 * Parse a plain decimal string exactly, as a BigInt scaled by 10^18.
 * Accepted: digits, an optional fraction of at most 18 digits, an optional
 * leading "-". Refused (null): exponents, "NaN", "Infinity", "+", spaces,
 * ".5", "5.", hex, underscores, non-ASCII digits, more than 80 characters.
 * @param {unknown} text
 * @returns {bigint|null}
 */
export function parseDecimal(text) {
  if (typeof text !== 'string' || text.length > DECIMAL_MAX_LENGTH) return null;
  const m = DECIMAL_RE.exec(text);
  if (!m) return null;
  const [, sign, int, frac = ''] = m;
  if (frac.length > DECIMAL_PLACES) return null;
  const scaled = BigInt(int) * SCALE + BigInt(frac.padEnd(DECIMAL_PLACES, '0'));
  return sign ? -scaled : scaled;
}

/**
 * A finite JS number as a plain decimal string, without an exponent:
 * 1e-7 -> "0.0000001". Uses the shortest round-trip form, which is what an
 * operator typed in the config for any value a JSON file can hold.
 * @param {number} n
 */
export function numberToDecimal(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new RangeError('not a finite number');
  const s = String(n);
  const m = /^(-?)([0-9])(?:\.([0-9]+))?e([+-][0-9]+)$/.exec(s);
  if (!m) return s;
  const [, sign, int, frac = '', exp] = m;
  const digits = int + frac;
  const point = int.length + Number(exp);
  if (point <= 0) return `${sign}0.${'0'.repeat(-point)}${digits}`;
  if (point >= digits.length) return `${sign}${digits}${'0'.repeat(point - digits.length)}`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

// --- compile ----------------------------------------------------------------

function compileBound(where, side, value, type) {
  if (type === 'number-string') {
    let display;
    if (typeof value === 'number' && Number.isFinite(value)) display = numberToDecimal(value);
    else if (typeof value === 'string') display = value;
    const scaled = display === undefined ? null : parseDecimal(display);
    if (scaled === null) {
      throw new UsageError(
        `${where}.${side} must be a number or a plain decimal string with at most ${DECIMAL_PLACES} decimal places, got ${quote(value)}`,
      );
    }
    return { display, scaled };
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new UsageError(`${where}.${side} must be a finite number for "type": "${type}", got ${quote(value)}`);
  }
  return { display: numberToDecimal(value), value };
}

function compileIn(where, value, lists) {
  if (typeof value === 'string') {
    if (!value.startsWith('@') || value.length < 2) {
      throw new UsageError(`${where}.in must be an array of strings or "@<list name>", got ${quote(value)}`);
    }
    const listName = value.slice(1);
    if (!Object.hasOwn(lists, listName)) {
      const known = Object.keys(lists);
      throw new UsageError(
        `${where}.in names ${quote(value)}, but lists has no "${listName}" (lists: ${known.length ? known.join(', ') : 'none'})`,
      );
    }
    const values = lists[listName];
    return { ref: value, values: new Set(values), count: values.length, display: `${value} (${values.length} value${values.length === 1 ? '' : 's'})` };
  }
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new UsageError(`${where}.in must be an array of strings or "@<list name>"`);
  }
  const display = value.length <= IN_DISPLAY_MAX ? quote(value) : `one of ${value.length} values`;
  return { ref: null, values: new Set(value), count: value.length, display };
}

function compileConstraint(where, name, spec, lists) {
  if (!isPlainObject(spec)) {
    throw new UsageError(`${where} must be a constraint object, e.g. { "type": "number", "lte": 0.05 }`);
  }
  for (const k of Object.keys(spec)) {
    if (!CONSTRAINT_KEYS.has(k)) {
      throw new UsageError(`${where}: unknown constraint key "${k}" (allowed: ${[...CONSTRAINT_KEYS].join(', ')})`);
    }
  }
  const type = spec.type ?? null;
  if (type !== null && !CONSTRAINT_TYPES.includes(type)) {
    throw new UsageError(`${where}.type must be one of ${CONSTRAINT_TYPES.join(' | ')}, got ${quote(type)}`);
  }
  const required = spec.required ?? true;
  if (typeof required !== 'boolean') throw new UsageError(`${where}.required must be true or false`);

  const numeric = type === 'number' || type === 'integer' || type === 'number-string';
  const out = { name, type, required, gte: null, lte: null, in: null, pattern: null };
  for (const side of ['gte', 'lte']) {
    if (spec[side] === undefined) continue;
    // Comparing an untyped value against a number invites coercion; say which.
    if (!numeric) throw new UsageError(`${where}.${side} needs "type": "number", "integer" or "number-string"`);
    out[side] = compileBound(where, side, spec[side], type);
  }
  if (out.gte && out.lte) {
    const empty = type === 'number-string' ? out.gte.scaled > out.lte.scaled : out.gte.value > out.lte.value;
    if (empty) throw new UsageError(`${where}: gte ${out.gte.display} is above lte ${out.lte.display}, so nothing could pass`);
  }
  if (spec.in !== undefined) {
    if (type !== null && type !== 'string') {
      throw new UsageError(`${where}.in applies to strings; use "type": "string" (or gte/lte for numbers)`);
    }
    out.in = compileIn(where, spec.in, lists);
  }
  if (spec.pattern !== undefined) {
    if (type === 'number' || type === 'integer') {
      throw new UsageError(`${where}.pattern applies to strings, not to "type": "${type}"`);
    }
    if (typeof spec.pattern !== 'string' || !spec.pattern) throw new UsageError(`${where}.pattern must be a non-empty string`);
    let re;
    try {
      // Anchored: a pattern is a whole-value match, never a substring search.
      re = new RegExp(`^(?:${spec.pattern})$`);
    } catch (err) {
      throw new UsageError(`${where}.pattern is not a valid regular expression: ${err.message}`);
    }
    out.pattern = { source: spec.pattern, re };
  }
  return out;
}

function compileRule(key, value, { lists, servers }) {
  const where = `tools[${quote(key)}]`;
  let server = null;
  let toolRe = null;
  let glob = false;
  if (key !== '*') {
    const dot = key.indexOf('.');
    if (dot <= 0) throw new UsageError(`${where}: a policy key is "<server>.<tool>" or "*" (globs only in the tool part)`);
    server = key.slice(0, dot);
    const toolPart = key.slice(dot + 1);
    if (!SERVER_RE.test(server)) {
      throw new UsageError(`${where}: "${server}" is not a server name; globs are allowed only in the tool part ("<server>.<glob>")`);
    }
    if (!servers.has(server)) {
      throw new UsageError(`${where}: no server named "${server}" in servers (configured: ${[...servers].join(', ') || 'none'})`);
    }
    if (!TOOL_PATTERN_RE.test(toolPart)) {
      throw new UsageError(`${where}: the tool part must be a tool name, optionally with * globs ([A-Za-z0-9_-*], 1-64 characters)`);
    }
    glob = toolPart.includes('*');
    // Only `*` is special; every other allowed character is literal in a RegExp.
    if (glob) toolRe = new RegExp(`^${toolPart.split('*').join('.*')}$`);
  }

  let spec;
  if (typeof value === 'string') spec = { mode: value };
  else if (isPlainObject(value)) spec = value;
  else throw new UsageError(`${where} must be "pass", "deny" or an object { "mode": "bound", ... }`);
  for (const k of Object.keys(spec)) {
    if (!RULE_KEYS.has(k)) throw new UsageError(`${where}: unknown key "${k}" (allowed: ${[...RULE_KEYS].join(', ')})`);
  }
  if (!TOOL_MODES.includes(spec.mode)) {
    throw new UsageError(`${where}: mode must be one of ${TOOL_MODES.join(' | ')}, got ${quote(spec.mode)}`);
  }
  if (key === '*' && spec.mode !== 'deny') {
    throw new UsageError(
      'tools["*"] may only be "deny": it makes default deny explicit (I1). Allow tools by name or with "<server>.<glob>".',
    );
  }

  const rule = { key, server, glob, toolRe, mode: spec.mode, args: [], txArg: null };
  if (spec.mode !== 'bound') {
    for (const k of ['args', 'txArg', 'txArgEncoding']) {
      // Constraints on a pass rule would be silently ignored; refuse instead.
      if (spec[k] !== undefined) throw new UsageError(`${where}.${k} applies only to mode "bound" (this rule is "${spec.mode}")`);
    }
    return rule;
  }

  if (spec.args !== undefined) {
    if (!isPlainObject(spec.args)) throw new UsageError(`${where}.args must be an object: { "<argument>": { constraint } }`);
    rule.args = Object.entries(spec.args).map(([name, c]) => compileConstraint(`${where}.args.${name}`, name, c, lists));
  }
  if (spec.txArg !== undefined) {
    if (typeof spec.txArg !== 'string' || !spec.txArg || spec.txArg !== spec.txArg.trim()) {
      throw new UsageError(`${where}.txArg must name the argument that carries the transaction, got ${quote(spec.txArg)}`);
    }
    const encoding = spec.txArgEncoding ?? 'base64';
    if (!TX_ARG_ENCODINGS.includes(encoding)) {
      throw new UsageError(`${where}.txArgEncoding must be one of ${TX_ARG_ENCODINGS.join(' | ')}, got ${quote(encoding)}`);
    }
    rule.txArg = { name: spec.txArg, encoding };
  } else if (spec.txArgEncoding !== undefined) {
    throw new UsageError(`${where}.txArgEncoding needs a txArg`);
  }
  if (rule.args.length === 0 && !rule.txArg) {
    throw new UsageError(`${where}: a "bound" rule needs "args" constraints or a "txArg"; with neither it is "pass" under another name`);
  }
  return rule;
}

/**
 * Compile and validate the `tools` section of a loaded gate config. Throws a
 * UsageError (exit 2) on any mistake, so call it before spawning anything.
 * Key order is declaration order: every valid key contains a dot or is `*`,
 * so none is an integer-like key that JavaScript would reorder.
 * @param {{ tools?: object, lists?: object, servers?: object, showDeniedTools?: boolean, tx?: object }} config
 */
export function compileToolPolicy(config) {
  const tools = config?.tools ?? {};
  const lists = config?.lists ?? {};
  if (!isPlainObject(tools)) throw new UsageError('tools must be an object of policy rules');
  if (!isPlainObject(lists)) throw new UsageError('lists must be an object of string arrays');
  const servers = new Set(Object.keys(config?.servers ?? {}));

  const exact = new Map();
  const globs = [];
  const rules = [];
  let catchAll = null;
  for (const [key, value] of Object.entries(tools)) {
    const rule = compileRule(key, value, { lists, servers });
    rules.push(rule);
    if (key === '*') catchAll = rule;
    else if (rule.glob) globs.push(rule);
    else exact.set(key, rule);
  }
  return freezeAll({
    exact,
    globs,
    catchAll,
    rules,
    showDeniedTools: config?.showDeniedTools === true,
    // T4 owns `tx`; only its "never" (tests only, I2) changes what Gate tells the agent.
    approvalNeeded: config?.tx?.approval !== 'never',
  });
}

// --- describe -----------------------------------------------------------------

function describeConstraint(c) {
  const parts = [];
  if (c.gte && c.lte) parts.push(`${c.gte.display} ≤ ${c.name} ≤ ${c.lte.display}`);
  else if (c.lte) parts.push(`${c.name} ≤ ${c.lte.display}`);
  else if (c.gte) parts.push(`${c.name} ≥ ${c.gte.display}`);
  if (c.in) parts.push(`${c.name} in ${c.in.display}`);
  if (c.pattern) parts.push(`${c.name} matches /^(?:${c.pattern.source})$/`);
  if (parts.length === 0) parts.push(c.type ? `${c.name}: ${c.type}` : `${c.name} given`);
  else if (c.type === 'number-string') parts[0] += ' (decimal string)';
  else if (c.type === 'integer') parts[0] += ' (integer)';
  return `${parts.join(', ')}${c.required ? '' : ' (optional)'}`;
}

/** One human line per bound rule: what its constraints allow. */
function describeRule(rule) {
  const parts = rule.args.map(describeConstraint);
  if (rule.txArg) parts.push(`${rule.txArg.name}: a ${rule.txArg.encoding} transaction, reviewed before signing`);
  return parts.join('; ');
}

function matchRule(compiled, server, tool) {
  if (typeof server !== 'string' || !SERVER_RE.test(server) || typeof tool !== 'string' || !TOOL_NAME_RE.test(tool)) {
    return compiled.catchAll;
  }
  const exact = compiled.exact.get(`${server}.${tool}`);
  if (exact) return exact;
  for (const rule of compiled.globs) if (rule.server === server && rule.toolRe.test(tool)) return rule;
  return compiled.catchAll;
}

// --- decide -------------------------------------------------------------------

/** What the agent sent, short enough to echo back and to log. */
function observed(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'string') {
    return value.length > OBSERVED_MAX ? `${value.slice(0, OBSERVED_MAX)}…(+${value.length - OBSERVED_MAX} chars)` : value;
  }
  return typeOf(value);
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

const violation = (code, path, seen, bound, message) => ({ code, path, observed: seen, bound, message });

const TYPE_WORDS = {
  number: 'a number',
  integer: 'an integer',
  string: 'a string',
  'number-string': `a plain decimal string such as "0.001" (no exponent, only a leading "-", at most ${DECIMAL_PLACES} decimal places)`,
};

function checkConstraint(c, present, value) {
  const path = c.name;
  if (!present || value === undefined || value === null) {
    return c.required ? [violation('arg_missing', path, 'missing', 'required', `${path} is required`)] : [];
  }
  const typeIsOk = {
    number: () => typeof value === 'number' && Number.isFinite(value),
    integer: () => Number.isSafeInteger(value),
    string: () => typeof value === 'string',
    'number-string': () => parseDecimal(value) !== null,
  }[c.type] ?? (() => !(c.in || c.pattern) || typeof value === 'string');
  if (!typeIsOk()) {
    const want = c.type ?? 'string';
    // A malformed decimal is worth echoing ("1e-3"); otherwise name the type.
    const badText = c.type === 'number-string' && typeof value === 'string';
    const seen = badText ? observed(value) : typeOf(value);
    return [violation('arg_type', path, seen, want, `${path} must be ${TYPE_WORDS[want]}, got ${badText ? quote(seen) : seen}`)];
  }

  const out = [];
  if (c.gte || c.lte) {
    const scaled = c.type === 'number-string' ? parseDecimal(value) : null;
    const below = (b) => (scaled === null ? value < b.value : scaled < b.scaled);
    const above = (b) => (scaled === null ? value > b.value : scaled > b.scaled);
    const shown = typeof value === 'string' ? quote(observed(value)) : String(value);
    if (c.gte && below(c.gte)) {
      out.push(violation('arg_out_of_bounds', path, observed(value), `>= ${c.gte.display}`, `${path} must be >= ${c.gte.display}, got ${shown}`));
    }
    if (c.lte && above(c.lte)) {
      out.push(violation('arg_out_of_bounds', path, observed(value), `<= ${c.lte.display}`, `${path} must be <= ${c.lte.display}, got ${shown}`));
    }
  }
  if (c.in && !c.in.values.has(value)) {
    out.push(violation('arg_not_allowed', path, observed(value), c.in.ref ?? c.in.display, `${path} must be in ${c.in.display}, got ${quote(observed(value))}`));
  }
  if (c.pattern && !c.pattern.re.test(value)) {
    out.push(violation('arg_pattern', path, observed(value), c.pattern.source, `${path} must match /^(?:${c.pattern.source})$/, got ${quote(observed(value))}`));
  }
  return out;
}

function checkArgs(rule, args) {
  if (args !== undefined && args !== null && !isPlainObject(args)) {
    return [violation('arg_type', '', typeOf(args), 'object', 'arguments must be a JSON object')];
  }
  const input = args ?? {};
  // Own properties only: "constructor" or "__proto__" must not resolve through
  // the prototype chain into something that looks present.
  const lookup = (name) => [Object.hasOwn(input, name), Object.hasOwn(input, name) ? input[name] : undefined];
  const out = [];
  for (const c of rule.args) out.push(...checkConstraint(c, ...lookup(c.name)));
  if (rule.txArg && !out.some((v) => v.path === rule.txArg.name)) {
    // The transaction itself must be there and be text, whatever `args` says
    // about it: a txArg tool without its transaction has nothing to review.
    const implicit = { name: rule.txArg.name, type: 'string', required: true, gte: null, lte: null, in: null, pattern: null };
    out.push(...checkConstraint(implicit, ...lookup(rule.txArg.name)));
  }
  return out;
}

const AGENT_HINTS = {
  unknown_tool: (tool) =>
    `${tool} is not exposed by SolFrontier Gate: no policy rule allows it. Call tools/list for the tools you may use; retrying this one will not help.`,
  tool_denied: (tool, rule) =>
    `${tool} is denied by Gate policy rule "${rule}". Retrying will not help; if the user needs this tool, they must change the Gate policy.`,
};

function boundHint(rule, violations) {
  const problems = violations.map((v) => v.message).join('; ');
  return (
    `Refused by SolFrontier Gate before reaching the server: ${problems}. ` +
    `Rule "${rule.key}" allows: ${describeRule(rule)}. ` +
    'Retry only with arguments inside these bounds, or ask the user to change the Gate policy; do not retry unchanged.'
  );
}

/**
 * Decide one tools/call (SPEC §5.3). Precedence: exact key, then globs in
 * declaration order, then `"*"`.
 * @param {object} compiled from compileToolPolicy
 * @param {{ server: string|null, tool: string, args?: object }} call
 * @returns {{ mode: 'pass'|'bound'|'deny', rule: string|null, violations: object[],
 *             txArg?: { name: string, encoding: 'base64'|'base58' }, code?: string, hint?: string }}
 *   `violations` empty ⇒ allowed to proceed; otherwise `code` is the first
 *   violation's code and `hint` is written for the agent.
 */
export function decideTool(compiled, { server, tool, args } = {}) {
  // The agent knows `wallet__foo`; the operator's policy says `wallet.foo`.
  const named = typeof server === 'string' && server;
  const hostName = observed(named ? `${server}__${tool}` : String(tool));
  const key = named ? `${server}.${tool}` : String(tool);
  const rule = matchRule(compiled, server, tool);

  if (!rule || rule.key === '*') {
    const why = rule ? 'only "*": "deny"' : 'no matching rule';
    const v = violation('unknown_tool', 'tool', hostName, why, `no policy rule allows ${observed(key)} (${why})`);
    return { mode: 'deny', rule: rule ? '*' : null, violations: [v], code: v.code, hint: AGENT_HINTS.unknown_tool(hostName) };
  }
  if (rule.mode === 'deny') {
    const v = violation('tool_denied', 'tool', hostName, `"${rule.key}": "deny"`, `${key} is denied by rule "${rule.key}"`);
    return { mode: 'deny', rule: rule.key, violations: [v], code: v.code, hint: AGENT_HINTS.tool_denied(hostName, rule.key) };
  }
  if (rule.mode === 'pass') return { mode: 'pass', rule: rule.key, violations: [] };

  const violations = checkArgs(rule, args);
  const decision = { mode: 'bound', rule: rule.key, violations };
  if (rule.txArg) decision.txArg = { ...rule.txArg };
  if (violations.length) {
    decision.code = violations[0].code;
    decision.hint = boundHint(rule, violations);
  }
  return decision;
}

// --- refuse -------------------------------------------------------------------

const DEFAULT_HINTS = {
  unknown_tool: 'Gate does not expose this tool. Call tools/list for the tools you may use.',
  tool_denied: 'Gate policy denies this tool. Retrying will not help; the user must change the policy.',
  approval_unavailable:
    'This call carries a transaction that needs a human approval, and Gate cannot take approvals right now. Do not retry; tell the user.',
  downstream_error: 'The downstream server failed; see gate__status.',
};

/** BigInt -> decimal string, drop undefined; JSON.stringify must never throw here. */
function jsonSafe(value) {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) return value.map((v) => jsonSafe(v) ?? null);
  if (isPlainObject(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const clean = jsonSafe(v);
      if (clean !== undefined) out[k] = clean;
    }
    return out;
  }
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;
  return value;
}

/**
 * A structured refusal as an MCP CallToolResult (SPEC §5.3).
 * The agent gets the same body as text (for hosts that only show text) and
 * as structuredContent (for agents that parse it).
 * @param {{ code: string, tool: string, rule?: string|null, violations?: object[], hint?: string }} refusal
 */
export function refusal({ code, tool, rule = null, violations = [], hint } = {}) {
  if (!REFUSAL_CODES.includes(code)) throw new TypeError(`unknown refusal code ${quote(code)}`);
  const body = jsonSafe({
    gate: 'refused',
    code,
    tool,
    rule,
    violations,
    hint: hint ?? DEFAULT_HINTS[code] ?? 'Refused by SolFrontier Gate. Do not retry unchanged; tell the user.',
  });
  return { content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: body, isError: true };
}

// --- list ---------------------------------------------------------------------

function withSuffix(descriptor, suffix) {
  const base = typeof descriptor.description === 'string' ? descriptor.description.trimEnd() : '';
  return { ...descriptor, description: base ? `${base} ${suffix}` : suffix };
}

/**
 * How one downstream tool appears in tools/list, or null to hide it.
 * Hidden: every tool no rule names, or only `"*"` names (I1, whatever
 * `showDeniedTools` says), and explicitly denied tools unless
 * `showDeniedTools`, which lists them with a " [denied]" suffix. Bound tools
 * carry a guard suffix saying what Gate enforces (SPEC §5.2).
 * @param {object} compiled
 * @param {{ server: string, tool: string, descriptor: object }} entry descriptor = the host-visible tool
 * @returns {object|null}
 */
export function listedTool(compiled, { server, tool, descriptor }) {
  const rule = matchRule(compiled, server, tool);
  if (!rule || rule.key === '*') return null;
  if (rule.mode === 'deny') return compiled.showDeniedTools ? withSuffix(descriptor, '[denied]') : null;
  if (rule.mode === 'pass') return descriptor;
  const guard = [describeRule(rule)];
  if (compiled.approvalNeeded) guard.push('transactions need human approval');
  return withSuffix(descriptor, `[Guarded by SolFrontier Gate: ${guard.join('; ')}]`);
}

/** JSON-safe policy summary for gate__status. */
export function policySummary(compiled) {
  return {
    defaultDeny: true,
    showDeniedTools: compiled.showDeniedTools,
    rules: compiled.rules.map((r) => ({
      rule: r.key,
      mode: r.mode,
      ...(r.mode === 'bound' ? { allows: describeRule(r) } : {}),
      ...(r.txArg ? { txArg: r.txArg.name } : {}),
    })),
  };
}
