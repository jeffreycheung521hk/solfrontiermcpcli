// Tool policy (T2): compile, decide, refuse, list — and the same through
// `gate run` over stdio.
//
// The recorder downstream below is written to a temp dir at runtime (same
// reason as gate-core's env-echo: test/fixtures/ belongs to another card). It
// appends every tools/call it receives to a file, which is how these tests
// prove that a refused call never reached the downstream at all.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';

import {
  compileToolPolicy,
  decideTool,
  refusal,
  listedTool,
  policySummary,
  parseDecimal,
  numberToDecimal,
  REFUSAL_CODES,
} from '../src/gate/tool-policy.mjs';
import { base58Encode } from '../src/gate/config.mjs';
import { ROOT } from './helpers.mjs';

const runtimeAddress = () => base58Encode(Buffer.from(generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x, 'base64url'));
const ALLOWED = runtimeAddress();
const ATTACKER = runtimeAddress();

const TRANSFER_RULE = {
  mode: 'bound',
  args: { to: { type: 'string', in: '@allowlist' }, amount: { type: 'number', gte: 0, lte: 0.05 } },
};

/** The SPEC §5.1 example policy, with runtime addresses. */
function walletConfig(extra = {}) {
  return {
    servers: { wallet: {}, jup: {} },
    lists: { allowlist: [ALLOWED] },
    tools: {
      'wallet.get_balance': 'pass',
      'wallet.transfer_sol': TRANSFER_RULE,
      'wallet.sign_and_send': { mode: 'bound', txArg: 'transaction', txArgEncoding: 'base64' },
      '*': 'deny',
    },
    ...extra,
  };
}

const compile = (tools, extra = {}) => compileToolPolicy({ servers: { wallet: {}, jup: {} }, lists: { allowlist: [ALLOWED] }, tools, ...extra });
const decide = (policy, server, tool, args = {}) => decideTool(policy, { server, tool, args });
const codes = (decision) => decision.violations.map((v) => v.code);
const usage = (re) => (err) => err?.exitCode === 2 && re.test(err.message);

describe('compileToolPolicy: config errors at load time (exit 2)', () => {
  const bad = [
    ['unknown mode string', { 'wallet.x': 'allow' }, /mode must be one of pass \| bound \| deny/],
    ['unknown mode in an object', { 'wallet.x': { mode: 'maybe' } }, /mode must be one of/],
    ['object without a mode', { 'wallet.x': { args: { a: { type: 'string' } } } }, /mode must be one of/],
    ['a value that is neither string nor object', { 'wallet.x': 1 }, /must be "pass", "deny" or an object/],
    ['unknown rule key', { 'wallet.x': { mode: 'bound', argz: {} } }, /unknown key "argz"/],
    ['unknown constraint key', { 'wallet.x': { mode: 'bound', args: { amount: { type: 'number', max: 1 } } } }, /unknown constraint key "max"/],
    ['constraint that is not an object', { 'wallet.x': { mode: 'bound', args: { amount: 'number' } } }, /must be a constraint object/],
    ['args that is not an object', { 'wallet.x': { mode: 'bound', args: ['amount'] } }, /args must be an object/],
    ['unknown type', { 'wallet.x': { mode: 'bound', args: { a: { type: 'float' } } } }, /type must be one of number \| integer \| string \| number-string/],
    ['required that is not a boolean', { 'wallet.x': { mode: 'bound', args: { a: { type: 'string', required: 'yes' } } } }, /required must be true or false/],
    ['@list that does not exist', { 'wallet.x': { mode: 'bound', args: { to: { type: 'string', in: '@friends' } } } }, /lists has no "friends"/],
    ['in: a string that is not @list', { 'wallet.x': { mode: 'bound', args: { to: { type: 'string', in: 'allowlist' } } } }, /in must be an array of strings or "@<list name>"/],
    ['in: a bare "@"', { 'wallet.x': { mode: 'bound', args: { to: { type: 'string', in: '@' } } } }, /in must be an array/],
    ['in: an array with a non-string', { 'wallet.x': { mode: 'bound', args: { to: { type: 'string', in: ['a', 1] } } } }, /in must be an array of strings/],
    ['in on a number', { 'wallet.x': { mode: 'bound', args: { a: { type: 'number', in: ['1'] } } } }, /in applies to strings/],
    ['txArg naming nothing (empty)', { 'wallet.x': { mode: 'bound', txArg: '' } }, /txArg must name the argument/],
    ['txArg naming nothing (not a string)', { 'wallet.x': { mode: 'bound', txArg: true } }, /txArg must name the argument/],
    ['txArg with padding', { 'wallet.x': { mode: 'bound', txArg: ' tx ' } }, /txArg must name the argument/],
    ['unknown txArgEncoding', { 'wallet.x': { mode: 'bound', txArg: 'tx', txArgEncoding: 'hex' } }, /txArgEncoding must be one of base64 \| base58/],
    ['txArgEncoding without txArg', { 'wallet.x': { mode: 'bound', args: { a: { type: 'string' } }, txArgEncoding: 'base64' } }, /txArgEncoding needs a txArg/],
    ['"bound" with nothing to bind (string)', { 'wallet.x': 'bound' }, /needs "args" constraints or a "txArg"/],
    ['"bound" with nothing to bind (empty args)', { 'wallet.x': { mode: 'bound', args: {} } }, /needs "args" constraints or a "txArg"/],
    ['args on a pass rule', { 'wallet.x': { mode: 'pass', args: { a: { type: 'string' } } } }, /args applies only to mode "bound"/],
    ['txArg on a deny rule', { 'wallet.x': { mode: 'deny', txArg: 'tx' } }, /txArg applies only to mode "bound"/],
    ['"*" set to pass', { '*': 'pass' }, /tools\["\*"\] may only be "deny"/],
    ['"*" set to bound', { '*': { mode: 'bound', txArg: 'tx' } }, /may only be "deny"/],
    ['a server that is not configured', { 'walet.transfer_sol': 'deny' }, /no server named "walet"/],
    ['a glob in the server part', { '*.transfer_sol': 'deny' }, /globs are allowed only in the tool part/],
    ['a key without a dot', { wallet_transfer: 'pass' }, /a policy key is "<server>.<tool>"/],
    ['a key starting with a dot', { '.x': 'pass' }, /a policy key is/],
    ['a tool part with a dot', { 'wallet.a.b': 'pass' }, /tool part must be a tool name/],
    ['a tool part with a space', { 'wallet.get balance': 'pass' }, /tool part must be a tool name/],
    ['lte without a type', { 'wallet.x': { mode: 'bound', args: { a: { lte: 1 } } } }, /lte needs "type": "number", "integer" or "number-string"/],
    ['gte on a string', { 'wallet.x': { mode: 'bound', args: { a: { type: 'string', gte: 1 } } } }, /gte needs "type"/],
    ['a string bound for a number', { 'wallet.x': { mode: 'bound', args: { a: { type: 'number', lte: '0.05' } } } }, /lte must be a finite number/],
    ['an exponent bound for a number-string', { 'wallet.x': { mode: 'bound', args: { a: { type: 'number-string', lte: '1e-3' } } } }, /lte must be a number or a plain decimal string/],
    ['a bound finer than 18 decimals', { 'wallet.x': { mode: 'bound', args: { a: { type: 'number-string', lte: 1e-19 } } } }, /at most 18 decimal places/],
    ['gte above lte', { 'wallet.x': { mode: 'bound', args: { a: { type: 'number', gte: 2, lte: 1 } } } }, /gte 2 is above lte 1/],
    ['gte above lte (number-string)', { 'wallet.x': { mode: 'bound', args: { a: { type: 'number-string', gte: '0.0500000001', lte: 0.05 } } } }, /nothing could pass/],
    ['an invalid pattern', { 'wallet.x': { mode: 'bound', args: { a: { type: 'string', pattern: '([a-z' } } } }, /pattern is not a valid regular expression/],
    ['a pattern on an integer', { 'wallet.x': { mode: 'bound', args: { a: { type: 'integer', pattern: '[0-9]+' } } } }, /pattern applies to strings/],
    ['an empty pattern', { 'wallet.x': { mode: 'bound', args: { a: { type: 'string', pattern: '' } } } }, /pattern must be a non-empty string/],
  ];
  for (const [what, tools, re] of bad) {
    test(what, () => assert.throws(() => compile(tools), usage(re)));
  }

  test('tools and lists must be objects', () => {
    assert.throws(() => compileToolPolicy({ servers: {}, tools: [] }), usage(/tools must be an object/));
    assert.throws(() => compileToolPolicy({ servers: {}, tools: {}, lists: [] }), usage(/lists must be an object/));
  });

  test('the example configs compile', () => {
    for (const name of ['sfgate.devnet.example.json', 'sfgate.mainnet-jupiter.example.json']) {
      const config = JSON.parse(readFileSync(path.join(ROOT, 'examples', name), 'utf8'));
      const policy = compileToolPolicy(config);
      assert.ok(policy.rules.length >= 3, name);
      assert.equal(policy.catchAll?.mode, 'deny', name);
    }
  });

  test('the compiled policy is frozen', () => {
    const policy = compileToolPolicy(walletConfig());
    assert.ok(Object.isFrozen(policy) && Object.isFrozen(policy.rules) && Object.isFrozen(policy.rules[1].args[0]));
    // A frozen RegExp still matches (it is never global, so lastIndex is never written).
    const glob = compile({ 'wallet.get_*': 'pass' });
    assert.equal(decide(glob, 'wallet', 'get_balance').mode, 'pass');
    assert.equal(decide(glob, 'wallet', 'get_balance').mode, 'pass');
  });
});

describe('decideTool: modes and precedence', () => {
  test('pass: allowed, no violations, the matching key as rule', () => {
    const d = decide(compileToolPolicy(walletConfig()), 'wallet', 'get_balance', { anything: [1, 2] });
    assert.deepEqual(d, { mode: 'pass', rule: 'wallet.get_balance', violations: [] });
  });

  test('no rule at all -> unknown_tool (rule null)', () => {
    for (const policy of [compile({}), compileToolPolicy({ servers: { wallet: {} } })]) {
      const d = decide(policy, 'wallet', 'get_balance');
      assert.equal(d.mode, 'deny');
      assert.equal(d.rule, null);
      assert.equal(d.code, 'unknown_tool');
      assert.deepEqual(codes(d), ['unknown_tool']);
      assert.equal(d.violations[0].observed, 'wallet__get_balance');
    }
  });

  test('only "*": "deny" matched -> unknown_tool (rule "*")', () => {
    const d = decide(compileToolPolicy(walletConfig()), 'wallet', 'drain_everything');
    assert.equal(d.mode, 'deny');
    assert.equal(d.rule, '*');
    assert.deepEqual(codes(d), ['unknown_tool']);
    assert.match(d.hint, /wallet__drain_everything is not exposed/);
  });

  test('"wallet.foo": "deny" -> tool_denied; so does an explicit glob', () => {
    const policy = compile({ 'wallet.foo': 'deny', 'wallet.admin_*': { mode: 'deny' }, '*': 'deny' });
    const exact = decide(policy, 'wallet', 'foo');
    assert.equal(exact.mode, 'deny');
    assert.equal(exact.rule, 'wallet.foo');
    assert.deepEqual(codes(exact), ['tool_denied']);
    assert.match(exact.hint, /denied by Gate policy rule "wallet\.foo"/);
    const glob = decide(policy, 'wallet', 'admin_drain');
    assert.equal(glob.rule, 'wallet.admin_*');
    assert.deepEqual(codes(glob), ['tool_denied']);
  });

  test('exact key beats a glob declared before it', () => {
    const policy = compile({ 'wallet.*': 'deny', 'wallet.get_balance': 'pass' });
    assert.equal(decide(policy, 'wallet', 'get_balance').mode, 'pass');
    assert.equal(decide(policy, 'wallet', 'transfer_sol').code, 'tool_denied');
  });

  test('globs apply in declaration order', () => {
    const first = compile({ 'wallet.get_*': 'pass', 'wallet.*': 'deny' });
    assert.equal(decide(first, 'wallet', 'get_balance').rule, 'wallet.get_*');
    assert.equal(decide(first, 'wallet', 'transfer_sol').rule, 'wallet.*');
    const reversed = compile({ 'wallet.*': 'deny', 'wallet.get_*': 'pass' });
    assert.equal(decide(reversed, 'wallet', 'get_balance').rule, 'wallet.*');
    assert.equal(decide(reversed, 'wallet', 'get_balance').code, 'tool_denied');
  });

  test('"*" comes last: after every exact key and glob', () => {
    const policy = compile({ '*': 'deny', 'wallet.get_*': 'pass', 'wallet.token_info': 'pass' });
    assert.equal(decide(policy, 'wallet', 'get_balance').mode, 'pass');
    assert.equal(decide(policy, 'wallet', 'token_info').mode, 'pass');
    assert.equal(decide(policy, 'wallet', 'transfer_sol').rule, '*');
  });

  test('globs are anchored, stay in their server, and * matches any run of characters', () => {
    const policy = compile({ 'wallet.get_*': 'pass', 'wallet.*_info': 'pass', 'wallet.a*b*c': 'pass' });
    assert.equal(decide(policy, 'wallet', 'xget_balance').code, 'unknown_tool');
    assert.equal(decide(policy, 'wallet', 'get_').mode, 'pass');
    assert.equal(decide(policy, 'wallet', 'token_info').mode, 'pass');
    assert.equal(decide(policy, 'wallet', 'token_info_x').code, 'unknown_tool');
    assert.equal(decide(policy, 'wallet', 'a-b-c').mode, 'pass');
    assert.equal(decide(policy, 'wallet', 'acb').code, 'unknown_tool');
    assert.equal(decide(policy, 'jup', 'get_balance').code, 'unknown_tool', 'a wallet glob never matches jup');
    assert.equal(decide(compile({ 'wallet.*': 'pass' }), 'jup', 'anything').rule, null);
  });

  test('names that are not tool names never match a glob', () => {
    const policy = compile({ 'wallet.*': 'pass', '*': 'deny' });
    for (const [server, tool] of [['wallet', '*'], ['wallet', 'a.b'], ['wallet', 'a b'], ['wallet', ''], ['Wallet', 'x'], [null, 'plain'], ['wallet', 'x'.repeat(65)]]) {
      const d = decide(policy, server, tool);
      assert.equal(d.code, 'unknown_tool', `${server}/${tool}`);
      assert.equal(d.rule, '*');
    }
  });

  test('a decision is JSON-safe', () => {
    const policy = compileToolPolicy(walletConfig());
    for (const d of [decide(policy, 'wallet', 'transfer_sol', { to: ATTACKER, amount: 9 }), decide(policy, 'wallet', 'nope')]) {
      assert.deepEqual(JSON.parse(JSON.stringify(d)), d);
    }
  });
});

describe('decideTool: constraints', () => {
  const policy = compileToolPolicy(walletConfig());

  test('within bounds -> allowed; extra arguments are allowed', () => {
    const d = decide(policy, 'wallet', 'transfer_sol', { to: ALLOWED, amount: 0.05, memo: 'hi' });
    assert.deepEqual(d, { mode: 'bound', rule: 'wallet.transfer_sol', violations: [] });
    assert.deepEqual(decide(policy, 'wallet', 'transfer_sol', { to: ALLOWED, amount: 0 }).violations, []);
  });

  test('every violation is reported, in declaration order; code is the first', () => {
    const d = decide(policy, 'wallet', 'transfer_sol', { to: ATTACKER, amount: 5 });
    assert.deepEqual(codes(d), ['arg_not_allowed', 'arg_out_of_bounds']);
    assert.equal(d.code, 'arg_not_allowed');
    const [notAllowed, tooMuch] = d.violations;
    assert.deepEqual(tooMuch, { code: 'arg_out_of_bounds', path: 'amount', observed: 5, bound: '<= 0.05', message: 'amount must be <= 0.05, got 5' });
    assert.equal(notAllowed.path, 'to');
    assert.equal(notAllowed.observed, ATTACKER);
    assert.equal(notAllowed.bound, '@allowlist');
    // The hint says what applied and what would be allowed.
    assert.match(d.hint, /amount must be <= 0\.05, got 5/);
    assert.match(d.hint, /allows: to in @allowlist \(1 value\); 0 ≤ amount ≤ 0\.05/);
    assert.match(d.hint, /do not retry unchanged/);
  });

  test('type number: finite numbers only; gte / lte inclusive', () => {
    assert.deepEqual(codes(decide(policy, 'wallet', 'transfer_sol', { to: ALLOWED, amount: 0.0500001 })), ['arg_out_of_bounds']);
    assert.deepEqual(codes(decide(policy, 'wallet', 'transfer_sol', { to: ALLOWED, amount: -0.01 })), ['arg_out_of_bounds']);
    for (const amount of ['0.01', NaN, Infinity, true, [0.01], { v: 0.01 }]) {
      const d = decide(policy, 'wallet', 'transfer_sol', { to: ALLOWED, amount });
      assert.deepEqual(codes(d), ['arg_type'], String(amount));
      assert.equal(d.violations[0].bound, 'number');
    }
    assert.equal(decide(policy, 'wallet', 'transfer_sol', { to: ALLOWED, amount: '0.01' }).violations[0].observed, 'string');
  });

  test('type integer: safe integers only', () => {
    const p = compile({ 'jup.order': { mode: 'bound', args: { slippageBps: { type: 'integer', gte: 1, lte: 100 } } } });
    assert.deepEqual(decide(p, 'jup', 'order', { slippageBps: 50 }).violations, []);
    assert.deepEqual(decide(p, 'jup', 'order', { slippageBps: 100 }).violations, []);
    assert.deepEqual(codes(decide(p, 'jup', 'order', { slippageBps: 101 })), ['arg_out_of_bounds']);
    assert.deepEqual(codes(decide(p, 'jup', 'order', { slippageBps: 0 })), ['arg_out_of_bounds']);
    for (const v of [50.5, '50', 2 ** 53, NaN]) assert.deepEqual(codes(decide(p, 'jup', 'order', { slippageBps: v })), ['arg_type'], String(v));
  });

  test('type string', () => {
    const p = compile({ 'wallet.token_info': { mode: 'bound', args: { mint: { type: 'string' } } } });
    assert.deepEqual(decide(p, 'wallet', 'token_info', { mint: 'abc' }).violations, []);
    assert.deepEqual(codes(decide(p, 'wallet', 'token_info', { mint: 7 })), ['arg_type']);
  });

  test('required defaults to true; required: false lets the argument be absent; null counts as absent', () => {
    assert.deepEqual(codes(decide(policy, 'wallet', 'transfer_sol', { to: ALLOWED })), ['arg_missing']);
    assert.deepEqual(codes(decide(policy, 'wallet', 'transfer_sol', {})), ['arg_missing', 'arg_missing']);
    assert.deepEqual(codes(decide(policy, 'wallet', 'transfer_sol', { to: ALLOWED, amount: null })), ['arg_missing']);
    const missing = decide(policy, 'wallet', 'transfer_sol', { to: ALLOWED }).violations[0];
    assert.deepEqual(missing, { code: 'arg_missing', path: 'amount', observed: 'missing', bound: 'required', message: 'amount is required' });
    const p = compile({ 'wallet.x': { mode: 'bound', args: { memo: { type: 'string', required: false, pattern: '[a-z]{1,8}' } } } });
    assert.deepEqual(decide(p, 'wallet', 'x', {}).violations, []);
    assert.deepEqual(decide(p, 'wallet', 'x', { memo: null }).violations, []);
    assert.deepEqual(codes(decide(p, 'wallet', 'x', { memo: 'TOOLONGMEMO' })), ['arg_pattern']);
  });

  test('in: a literal array and an @list; type checked first', () => {
    const p = compile({
      'jup.order': { mode: 'bound', args: { inputMint: { type: 'string', in: ['So11111111111111111111111111111111111111112'] }, to: { in: '@allowlist' } } },
    });
    assert.deepEqual(decide(p, 'jup', 'order', { inputMint: 'So11111111111111111111111111111111111111112', to: ALLOWED }).violations, []);
    const d = decide(p, 'jup', 'order', { inputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', to: ATTACKER });
    assert.deepEqual(codes(d), ['arg_not_allowed', 'arg_not_allowed']);
    assert.equal(d.violations[0].bound, '["So11111111111111111111111111111111111111112"]');
    assert.equal(d.violations[1].bound, '@allowlist');
    // Untyped `in` still requires a string; a wrong type is one violation, not two.
    assert.deepEqual(codes(decide(p, 'jup', 'order', { inputMint: 'So11111111111111111111111111111111111111112', to: 42 })), ['arg_type']);
    // An empty list allows nothing.
    const empty = compile({ 'wallet.x': { mode: 'bound', args: { to: { type: 'string', in: '@none' } } } }, { lists: { none: [] } });
    assert.deepEqual(codes(decide(empty, 'wallet', 'x', { to: ALLOWED })), ['arg_not_allowed']);
  });

  test('pattern is anchored (whole value), alternation included', () => {
    const p = compile({ 'wallet.x': { mode: 'bound', args: { a: { type: 'string', pattern: 'abc' }, b: { type: 'string', pattern: 'yes|no' } } } });
    assert.deepEqual(decide(p, 'wallet', 'x', { a: 'abc', b: 'no' }).violations, []);
    const d = decide(p, 'wallet', 'x', { a: 'xabcx', b: 'yesno' });
    assert.deepEqual(codes(d), ['arg_pattern', 'arg_pattern']);
    assert.equal(d.violations[0].bound, 'abc');
    assert.deepEqual(codes(decide(p, 'wallet', 'x', { a: 'abc\n', b: 'yes' })), ['arg_pattern']);
  });

  test('arguments that are not an object are one arg_type violation', () => {
    for (const args of [[], 'x', 5]) {
      const d = decide(policy, 'wallet', 'transfer_sol', args);
      assert.deepEqual(codes(d), ['arg_type']);
      assert.equal(d.violations[0].path, '');
    }
  });

  test('constraint names never resolve through the prototype chain', () => {
    const p = compile({ 'wallet.x': { mode: 'bound', args: { constructor: { type: 'string' }, toString: { required: true } } } });
    assert.deepEqual(codes(decide(p, 'wallet', 'x', {})), ['arg_missing', 'arg_missing']);
    assert.deepEqual(decide(p, 'wallet', 'x', JSON.parse('{"constructor":"a","toString":1}')).violations, []);
  });

  test('a long observed value is truncated in the violation', () => {
    const d = decide(policy, 'wallet', 'transfer_sol', { to: 'A'.repeat(5000), amount: 0.01 });
    assert.ok(d.violations[0].observed.length < 160);
    assert.match(d.violations[0].observed, /…\(\+4880 chars\)$/);
  });
});

describe('number-string: exact decimal comparison', () => {
  const p = compile({
    'jup.order': { mode: 'bound', args: { amount: { type: 'number-string', gte: 0, lte: 0.05 } } },
    'jup.tiny': { mode: 'bound', args: { amount: { type: 'number-string', lte: 1e-7 } } },
    'jup.str': { mode: 'bound', args: { amount: { type: 'number-string', gte: '-1.5', lte: '123456789012345678.123456789012345678' } } },
  });
  const amount = (value, tool = 'order') => decide(p, 'jup', tool, { amount: value });

  test('"0.05" <= 0.05 passes; "0.0500000001" fails', () => {
    assert.deepEqual(amount('0.05').violations, []);
    assert.deepEqual(amount('0.050').violations, []);
    assert.deepEqual(amount('0').violations, []);
    assert.deepEqual(amount('00.01').violations, []);
    const d = amount('0.0500000001');
    assert.deepEqual(codes(d), ['arg_out_of_bounds']);
    assert.equal(d.violations[0].observed, '0.0500000001');
    assert.equal(d.violations[0].bound, '<= 0.05');
  });

  test('exact where a double is not', () => {
    assert.equal(Number('0.050000000000000001'), 0.05, 'a float comparison would let this through');
    assert.deepEqual(codes(amount('0.050000000000000001')), ['arg_out_of_bounds']);
    assert.deepEqual(codes(amount('-0.000000000000000001')), ['arg_out_of_bounds']);
    assert.deepEqual(amount('-0').violations, []);
  });

  test('"1e-3" and every other non-plain form is rejected as arg_type', () => {
    for (const v of ['1e-3', '1E-3', '5e0', 'NaN', 'Infinity', '-Infinity', '+0.01', ' 0.01', '0.01 ', '.5', '5.', '0x10', '1_000', '1,5', '１', '', '-', '--1', '0.0.1', '0.0000000000000000001', '1'.repeat(81)]) {
      const d = amount(v);
      assert.deepEqual(codes(d), ['arg_type'], JSON.stringify(v));
      assert.equal(d.violations[0].bound, 'number-string');
    }
    assert.match(amount('1e-3').violations[0].message, /got "1e-3"/);
  });

  test('a JSON number is not a number-string', () => {
    const d = amount(0.001);
    assert.deepEqual(codes(d), ['arg_type']);
    assert.equal(d.violations[0].observed, 'number');
  });

  test('18 decimal places is the limit; bounds from exponent numbers and from strings', () => {
    assert.deepEqual(amount('0.000000000000000001').violations, []);
    assert.deepEqual(amount('0.0000001', 'tiny').violations, []);
    assert.deepEqual(codes(amount('0.00000010000000001', 'tiny')), ['arg_out_of_bounds']);
    assert.equal(amount('0.0000002', 'tiny').violations[0].bound, '<= 0.0000001');
    assert.deepEqual(amount('123456789012345678.123456789012345678', 'str').violations, []);
    assert.deepEqual(codes(amount('123456789012345678.123456789012345679', 'str')), ['arg_out_of_bounds']);
    assert.deepEqual(amount('-1.5', 'str').violations, []);
    assert.deepEqual(codes(amount('-1.500000000000000001', 'str')), ['arg_out_of_bounds']);
  });

  test('parseDecimal and numberToDecimal', () => {
    assert.equal(parseDecimal('0.05'), 50_000_000_000_000_000n);
    assert.equal(parseDecimal('-1'), -1_000_000_000_000_000_000n);
    assert.equal(parseDecimal('1e-3'), null);
    assert.equal(parseDecimal(0.05), null);
    assert.equal(numberToDecimal(0.05), '0.05');
    assert.equal(numberToDecimal(1e-7), '0.0000001');
    assert.equal(numberToDecimal(-2.5e-8), '-0.000000025');
    assert.equal(numberToDecimal(1.5e21), '1500000000000000000000');
    assert.equal(numberToDecimal(123), '123');
    assert.throws(() => numberToDecimal(NaN), RangeError);
  });
});

describe('txArg', () => {
  const policy = compileToolPolicy(walletConfig());

  test('the decision carries the transaction argument and its encoding', () => {
    const d = decide(policy, 'wallet', 'sign_and_send', { transaction: 'AQID' });
    assert.deepEqual(d, { mode: 'bound', rule: 'wallet.sign_and_send', violations: [], txArg: { name: 'transaction', encoding: 'base64' } });
    const b58 = compile({ 'jup.exec': { mode: 'bound', txArg: 'tx', txArgEncoding: 'base58' }, 'jup.exec2': { mode: 'bound', txArg: 'tx' } });
    assert.deepEqual(decide(b58, 'jup', 'exec', { tx: 'abc' }).txArg, { name: 'tx', encoding: 'base58' });
    assert.deepEqual(decide(b58, 'jup', 'exec2', { tx: 'abc' }).txArg, { name: 'tx', encoding: 'base64' }, 'base64 by default');
  });

  test('the transaction must be present and a string, whatever args says', () => {
    assert.deepEqual(codes(decide(policy, 'wallet', 'sign_and_send', {})), ['arg_missing']);
    assert.deepEqual(codes(decide(policy, 'wallet', 'sign_and_send', { transaction: [1, 2] })), ['arg_type']);
    const loose = compile({ 'wallet.x': { mode: 'bound', txArg: 'tx', args: { tx: { required: false }, n: { type: 'integer' } } } });
    assert.deepEqual(codes(decide(loose, 'wallet', 'x', { n: 1 })), ['arg_missing'], 'required: false cannot loosen the txArg');
    const strict = compile({ 'wallet.x': { mode: 'bound', txArg: 'tx', args: { tx: { type: 'string', pattern: '[A-Za-z0-9+/=]+' } } } });
    assert.deepEqual(codes(decide(strict, 'wallet', 'x', { tx: 5 })), ['arg_type'], 'one violation per path, not two');
    assert.ok(decide(strict, 'wallet', 'x', {}).txArg, 'txArg is reported even when refused');
  });
});

describe('refusal', () => {
  test('CallToolResult shape: text = JSON body = structuredContent, isError', () => {
    const violations = [{ code: 'arg_out_of_bounds', path: 'amount', observed: 5, bound: '<= 0.05', message: 'amount must be <= 0.05, got 5' }];
    const r = refusal({ code: 'arg_out_of_bounds', tool: 'wallet__transfer_sol', rule: 'wallet.transfer_sol', violations, hint: 'use less' });
    assert.equal(r.isError, true);
    assert.equal(r.content.length, 1);
    assert.equal(r.content[0].type, 'text');
    const body = { gate: 'refused', code: 'arg_out_of_bounds', tool: 'wallet__transfer_sol', rule: 'wallet.transfer_sol', violations, hint: 'use less' };
    assert.deepEqual(r.structuredContent, body);
    assert.equal(r.content[0].text, JSON.stringify(body));
  });

  test('defaults: rule null, no violations, a hint for the agent', () => {
    const r = refusal({ code: 'approval_unavailable', tool: 'wallet__sign_and_send' });
    assert.equal(r.structuredContent.rule, null);
    assert.deepEqual(r.structuredContent.violations, []);
    assert.match(r.structuredContent.hint, /needs a human approval/);
    for (const code of REFUSAL_CODES) assert.equal(typeof refusal({ code, tool: 't' }).structuredContent.hint, 'string', code);
  });

  test('JSON-safe even when handed a BigInt', () => {
    const r = refusal({ code: 'outflow_exceeds_bound', tool: 't', violations: [{ code: 'outflow_exceeds_bound', path: 'SOL', observed: 5_000_000_000n, bound: 0.05, message: 'm' }] });
    assert.equal(r.structuredContent.violations[0].observed, '5000000000');
    assert.equal(JSON.parse(r.content[0].text).violations[0].observed, '5000000000');
  });

  test('the stable codes are exactly the SPEC §5.3 list; an unknown code is a programming error', () => {
    assert.deepEqual([...REFUSAL_CODES].sort(), [
      'approval_rejected', 'approval_timeout', 'approval_unavailable', 'arg_missing', 'arg_not_allowed', 'arg_out_of_bounds',
      'arg_pattern', 'arg_type', 'destination_not_allowed', 'downstream_error', 'legacy_token_transfer_denied',
      'mint_not_allowed', 'outflow_exceeds_bound', 'program_not_allowed', 'rpc_unavailable', 'simulation_failed',
      'token_delegation_denied', 'tool_denied', 'tx_decode_failed', 'unknown_tool', 'unsolicited_send',
    ]);
    assert.throws(() => refusal({ code: 'nope', tool: 't' }), TypeError);
  });
});

describe('listing', () => {
  const descriptor = (name, description = 'Does a thing.') => ({ name, description, inputSchema: { type: 'object' } });
  const config = walletConfig({
    tools: { ...walletConfig().tools, 'wallet.admin_*': 'deny', 'wallet.token_info': 'deny' },
  });
  // Keep "*" last, as an operator would.
  delete config.tools['*'];
  config.tools['*'] = 'deny';

  test('pass is listed unchanged; bound gets the guard suffix', () => {
    const policy = compileToolPolicy(config);
    const pass = descriptor('wallet__get_balance');
    assert.deepEqual(listedTool(policy, { server: 'wallet', tool: 'get_balance', descriptor: pass }), pass);
    const bound = listedTool(policy, { server: 'wallet', tool: 'transfer_sol', descriptor: descriptor('wallet__transfer_sol', 'Send SOL.  ') });
    assert.equal(
      bound.description,
      'Send SOL. [Guarded by SolFrontier Gate: to in @allowlist (1 value); 0 ≤ amount ≤ 0.05; transactions need human approval]',
    );
    assert.deepEqual(bound.inputSchema, { type: 'object' });
    const tx = listedTool(policy, { server: 'wallet', tool: 'sign_and_send', descriptor: { name: 'wallet__sign_and_send' } });
    assert.equal(tx.description, '[Guarded by SolFrontier Gate: transaction: a base64 transaction, reviewed before signing; transactions need human approval]');
  });

  test('tx.approval "never" (tests only) drops the approval claim', () => {
    const policy = compileToolPolicy({ ...config, tx: { approval: 'never' } });
    const bound = listedTool(policy, { server: 'wallet', tool: 'transfer_sol', descriptor: descriptor('wallet__transfer_sol') });
    assert.doesNotMatch(bound.description, /human approval/);
  });

  test('denied tools are hidden; showDeniedTools lists explicit denies with [denied]', () => {
    const hidden = compileToolPolicy(config);
    for (const tool of ['admin_drain', 'token_info']) {
      assert.equal(listedTool(hidden, { server: 'wallet', tool, descriptor: descriptor(`wallet__${tool}`) }), null, tool);
    }
    const shown = compileToolPolicy({ ...config, showDeniedTools: true });
    const admin = listedTool(shown, { server: 'wallet', tool: 'admin_drain', descriptor: descriptor('wallet__admin_drain') });
    assert.equal(admin.description, 'Does a thing. [denied]');
    assert.equal(listedTool(shown, { server: 'wallet', tool: 'token_info', descriptor: { name: 'wallet__token_info' } }).description, '[denied]');
  });

  test('a tool no rule names (or only "*") stays hidden even with showDeniedTools (I1)', () => {
    const shown = compileToolPolicy({ ...config, showDeniedTools: true });
    assert.equal(listedTool(shown, { server: 'wallet', tool: 'mystery', descriptor: descriptor('wallet__mystery') }), null);
    const noStar = compile({ 'wallet.get_balance': 'pass' }, { showDeniedTools: true });
    assert.equal(listedTool(noStar, { server: 'jup', tool: 'swap', descriptor: descriptor('jup__swap') }), null);
  });

  test('policySummary is JSON-safe and lists every rule in order', () => {
    const summary = policySummary(compileToolPolicy(config));
    assert.deepEqual(JSON.parse(JSON.stringify(summary)), summary);
    assert.equal(summary.defaultDeny, true);
    assert.deepEqual(summary.rules.map((r) => r.rule), ['wallet.get_balance', 'wallet.transfer_sol', 'wallet.sign_and_send', 'wallet.admin_*', 'wallet.token_info', '*']);
    assert.equal(summary.rules[2].txArg, 'transaction');
    assert.match(summary.rules[1].allows, /0 ≤ amount ≤ 0\.05/);
  });
});
