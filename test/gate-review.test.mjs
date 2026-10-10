import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { reviewTransaction } from '../src/gate/review.mjs';
import {
  compileTxPolicy, compareToCap, formatUnits, parseUiAmount, NATIVE_MINT,
} from '../src/gate/tx-policy.mjs';
import { SolanaRpc } from '../src/solana/rpc.mjs';
import { UsageError } from '../src/cli/exit-codes.mjs';
import {
  SYSTEM, TOKEN, TOKEN_2022, ATA, COMPUTE_BUDGET, MEMO, ALT_PROGRAM,
  keypair, randomAddress, message, transaction, data, rpcAccount, tokenAccountData, mintData, lookupTableData,
} from './solana-builders.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const JUP6 = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const PROGRAMS = [SYSTEM, COMPUTE_BUDGET, TOKEN, TOKEN_2022, ATA, MEMO];

// --- transaction vectors ------------------------------------------------------

/**
 * Compile a legacy message from instructions whose accounts are
 * [address, signer, writable] triples; the payer comes first. Signs slot 0
 * with the payer when `sign` is set, every other slot stays empty.
 */
function buildTx(payer, ixs, { sign = false } = {}) {
  const metas = new Map([[payer.address, { signer: true, writable: true }]]);
  const touch = (key, signer, writable) => {
    const m = metas.get(key) ?? { signer: false, writable: false };
    metas.set(key, { signer: m.signer || signer, writable: m.writable || writable });
  };
  for (const ix of ixs) {
    for (const [key, signer, writable] of ix.accounts) touch(key, signer, writable);
    touch(ix.programId, false, false);
  }
  const group = (s, w) => [...metas].filter(([, m]) => m.signer === s && m.writable === w).map(([k]) => k);
  const keys = [...group(true, true), ...group(true, false), ...group(false, true), ...group(false, false)];
  const numSigners = group(true, true).length + group(true, false).length;
  const header = [numSigners, group(true, false).length, group(false, false).length];
  const instructions = ixs.map((ix) => ({
    p: keys.indexOf(ix.programId),
    a: ix.accounts.map(([k]) => keys.indexOf(k)),
    d: ix.data,
  }));
  const msg = message({ header, keys, instructions });
  return transaction(msg, keys.slice(0, numSigners).map((k) => (sign && k === payer.address ? payer : null)));
}

const IX = {
  sysTransfer: (from, to, lamports) => ({
    programId: SYSTEM, accounts: [[from, true, true], [to, false, true]], data: data.systemTransfer(lamports),
  }),
  transferChecked: (source, mint, dest, owner, amount, decimals) => ({
    programId: TOKEN,
    accounts: [[source, false, true], [mint, false, false], [dest, false, true], [owner, true, false]],
    data: data.splTransferChecked(amount, decimals),
  }),
  legacyTransfer: (source, dest, owner, amount) => ({
    programId: TOKEN, accounts: [[source, false, true], [dest, false, true], [owner, true, false]], data: data.splTransfer(amount),
  }),
  approve: (source, delegate, owner, amount) => ({
    programId: TOKEN, accounts: [[source, false, true], [delegate, false, false], [owner, true, false]], data: data.splApprove(amount),
  }),
  approveChecked: (source, mint, delegate, owner, amount, decimals) => ({
    programId: TOKEN,
    accounts: [[source, false, true], [mint, false, false], [delegate, false, false], [owner, true, false]],
    data: data.splApproveChecked(amount, decimals),
  }),
  setAuthority: (account, owner, type, newAuthority) => ({
    programId: TOKEN, accounts: [[account, false, true], [owner, true, false]], data: data.splSetAuthority(type, newAuthority),
  }),
  closeAccount: (account, dest, owner) => ({
    programId: TOKEN, accounts: [[account, false, true], [dest, false, true], [owner, true, false]], data: data.splCloseAccount(),
  }),
  ataCreateIdempotent: (payer, ata, owner, mint) => ({
    programId: ATA,
    accounts: [[payer, true, true], [ata, false, true], [owner, false, false], [mint, false, false],
      [SYSTEM, false, false], [TOKEN, false, false]],
    data: data.ataCreateIdempotent(),
  }),
  syncNative: (account) => ({ programId: TOKEN, accounts: [[account, false, true]], data: data.splSyncNative() }),
  computeLimit: (units) => ({ programId: COMPUTE_BUDGET, accounts: [], data: data.computeUnitLimit(units) }),
  computePrice: (micro) => ({ programId: COMPUTE_BUDGET, accounts: [], data: data.computeUnitPrice(micro) }),
  memo: (text) => ({ programId: MEMO, accounts: [], data: data.memo(text) }),
  opaque: (programId, accounts) => ({ programId, accounts, data: [7, 7, 7] }),
};

// --- fake RPC -----------------------------------------------------------------

/**
 * In-process scripted RPC. `pre` is the chain state, `post` overrides it
 * after simulation (an explicit null = the account is gone), `extra` holds
 * mints and lookup tables, `owned` lists the wallet's token accounts per
 * token program. Every call is recorded.
 */
function fakeRpc({ pre = {}, post = {}, extra = {}, owned = {}, simErr = null, failOn = null } = {}) {
  const calls = [];
  const after = (a) => (Object.hasOwn(post, a) ? post[a] : pre[a] ?? null);
  return {
    calls,
    methods: () => calls.map((c) => c.method),
    async call(method, params) {
      calls.push({ method, params });
      if (failOn === method) throw new Error(`${method} unavailable`);
      const context = { slot: 1 };
      switch (method) {
        case 'getTokenAccountsByOwner':
          return { context, value: (owned[params[1].programId] ?? []).map((pubkey) => ({ pubkey, account: pre[pubkey] ?? null })) };
        case 'getMultipleAccounts':
          return { context, value: params[0].map((a) => extra[a] ?? pre[a] ?? null) };
        case 'simulateTransaction':
          return {
            context,
            value: {
              err: simErr,
              logs: ['Program log: scripted'],
              unitsConsumed: 4321,
              accounts: simErr ? null : params[1].accounts.addresses.map(after),
            },
          };
        default:
          throw new Error(`unexpected method ${method}`);
      }
    },
  };
}

const sol = (lamports) => rpcAccount({ lamports });
const tokenAcct = (mint, owner, amount, lamports = 2_039_280) => rpcAccount({
  lamports, owner: TOKEN, data: tokenAccountData({ mint, owner, amount }),
});
const mintAcct = (decimals) => rpcAccount({ lamports: 1_461_600, owner: TOKEN, data: mintData({ decimals }) });

function policy(overrides = {}) {
  return {
    programs: PROGRAMS,
    unknownProgram: 'deny',
    maxOutflow: { SOL: 0.05 },
    unknownMintOutflow: 'deny',
    destinations: '@allowlist',
    denyTokenDelegation: true,
    denyLegacyTokenTransfer: true,
    approval: 'always',
    ...overrides,
  };
}

/**
 * reviewTransaction plus the JSON-safety acceptance check, applied to every
 * vector in this file: the Review must survive JSON.stringify unchanged.
 */
async function review({ bytes, wallet, rpc, tx = policy(), lists = {}, signed = false }) {
  const txPolicy = compileTxPolicy(tx, lists);
  const r = await reviewTransaction({ bytes, wallet, rpc, txPolicy, lists, cluster: 'devnet', signed });
  const text = JSON.stringify(r);
  assert.deepEqual(JSON.parse(text), r, 'Review must be JSON-safe');
  return r;
}

const codes = (list) => list.map((v) => v.code);

/** A wallet, an allowlisted friend and an attacker, with the friend in `lists.allowlist`. */
function actors() {
  const wallet = keypair();
  const friend = randomAddress();
  const attacker = randomAddress();
  return { wallet, W: wallet.address, friend, attacker, lists: { allowlist: [friend] } };
}

// --- tests --------------------------------------------------------------------

describe('compileTxPolicy', () => {
  test('defaults are the fail-closed ones', () => {
    const p = compileTxPolicy({ maxOutflow: { SOL: 0.05 } });
    assert.equal(p.unknownProgram, 'deny');
    assert.equal(p.unknownMintOutflow, 'deny');
    assert.equal(p.denyTokenDelegation, true);
    assert.equal(p.denyLegacyTokenTransfer, true);
    assert.equal(p.approval, 'always');
    assert.equal(p.programs.size, 0);
    assert.equal(p.destinations.any, false);
    assert.equal(p.destinations.set.size, 0);
    assert.equal(p.maxOutflow.get('SOL').text, '0.05');
  });

  test('the example tx sections compile; a placeholder in the destinations list is refused', () => {
    const mainnet = JSON.parse(readFileSync(path.join(root, 'examples', 'sfgate.mainnet-jupiter.example.json'), 'utf8'));
    const p = compileTxPolicy(mainnet.tx, mainnet.lists);
    assert.equal(p.destinations.any, true);
    assert.equal(p.maxOutflow.get(USDC).text, '1');
    assert.equal(p.maxOutflow.get('SOL').text, '0.003');
    assert.ok(p.programs.has(JUP6));

    const devnet = JSON.parse(readFileSync(path.join(root, 'examples', 'sfgate.devnet.example.json'), 'utf8'));
    const placeholder = { allowlist: ['REPLACE_WITH_AN_ADDRESS_YOU_OWN'] };
    assert.throws(() => compileTxPolicy(devnet.tx, placeholder), (e) => e instanceof UsageError && /lists\.allowlist\[0\]/.test(e.message));
    const ok = compileTxPolicy(devnet.tx, { allowlist: [randomAddress()] });
    assert.equal(ok.destinations.label, '@allowlist');
  });

  test('caps are exact decimals: numbers, decimal strings and exponent forms', () => {
    const p = compileTxPolicy({ maxOutflow: { SOL: 1e-7, [USDC]: '0.050', [randomAddress()]: 1e21 } });
    const [solCap, usdcCap, big] = [...p.maxOutflow.values()];
    assert.equal(solCap.text, '0.0000001');
    assert.deepEqual({ units: usdcCap.units, scale: usdcCap.scale }, { units: 5n, scale: 2 });
    assert.equal(big.text, '1000000000000000000000');
  });

  const bad = [
    ['tx not an object', ['nope']],
    ['unknown key', { maxOutflow: { SOL: 1 }, maxInflow: {} }],
    ['invalid program address', { programs: [SYSTEM, 'not-a-key'], maxOutflow: { SOL: 1 } }],
    ['programs not an array', { programs: SYSTEM, maxOutflow: { SOL: 1 } }],
    ['missing SOL cap', { maxOutflow: { [USDC]: 1 } }],
    ['no maxOutflow at all', {}],
    ['invalid mint key', { maxOutflow: { SOL: 1, USDC: 1 } }],
    ['wrapped SOL capped separately', { maxOutflow: { SOL: 1, [NATIVE_MINT]: 1 } }],
    ['negative cap', { maxOutflow: { SOL: -0.1 } }],
    ['NaN cap', { maxOutflow: { SOL: Number.NaN } }],
    ['Infinity cap', { maxOutflow: { SOL: Infinity } }],
    ['exponent string cap', { maxOutflow: { SOL: '1e-3' } }],
    ['signed string cap', { maxOutflow: { SOL: '-0.1' } }],
    ['boolean cap', { maxOutflow: { SOL: true } }],
    ['destinations list missing', { maxOutflow: { SOL: 1 }, destinations: '@nope' }],
    ['destinations without @', { maxOutflow: { SOL: 1 }, destinations: 'allowlist' }],
    ['destinations array with a bad address', { maxOutflow: { SOL: 1 }, destinations: ['xyz'] }],
    ['destinations of the wrong type', { maxOutflow: { SOL: 1 }, destinations: 5 }],
    ['unknownProgram enum', { maxOutflow: { SOL: 1 }, unknownProgram: 'allow' }],
    ['unknownMintOutflow enum', { maxOutflow: { SOL: 1 }, unknownMintOutflow: 'pass' }],
    ['approval enum', { maxOutflow: { SOL: 1 }, approval: 'sometimes' }],
    ['delegation flag type', { maxOutflow: { SOL: 1 }, denyTokenDelegation: 'yes' }],
    ['legacy flag type', { maxOutflow: { SOL: 1 }, denyLegacyTokenTransfer: 1 }],
  ];
  for (const [name, tx] of bad) {
    test(`load-time error (exit 2): ${name}`, () => {
      assert.throws(() => compileTxPolicy(tx, { allowlist: ['bad address'] }), (e) => e instanceof UsageError && e.exitCode === 2);
    });
  }

  test('the list a destinations reference names is validated; comment keys are ignored', () => {
    assert.throws(() => compileTxPolicy({ maxOutflow: { SOL: 1 }, destinations: '@allowlist' }, { allowlist: ['nope'] }), UsageError);
    const p = compileTxPolicy({ _comment: 'x', maxOutflow: { SOL: 1, _note: 'y' } }, {});
    assert.deepEqual([...p.maxOutflow.keys()], ['SOL']);
  });
});

describe('exact amount math', () => {
  test('formatUnits trims and never rounds', () => {
    assert.equal(formatUnits(170_000n, 6), '0.17');
    assert.equal(formatUnits(1_005_000n, 9), '0.001005');
    assert.equal(formatUnits(1_000_000_000n, 9), '1');
    assert.equal(formatUnits(1n, 9), '0.000000001');
    assert.equal(formatUnits(12345n, 0), '12345');
    assert.equal(formatUnits(0n, 6), '0');
  });

  test('compareToCap is exact at the boundary', () => {
    const cap = parseUiAmount(0.05);
    assert.deepEqual(compareToCap(50_000_000n, 9, cap), { exceeds: false, excess: '0' });
    assert.deepEqual(compareToCap(50_000_001n, 9, cap), { exceeds: true, excess: '0.000000001' });
    assert.deepEqual(compareToCap(500_005_000n, 9, cap), { exceeds: true, excess: '0.450005' });
    // A cap finer than the asset's decimals is compared without rounding either side.
    assert.deepEqual(compareToCap(1n, 0, parseUiAmount('0.5')), { exceeds: true, excess: '0.5' });
  });

  test('no floats in the amount path: the sources never parse or coerce amounts to Number', () => {
    for (const file of ['src/gate/review.mjs', 'src/gate/tx-policy.mjs']) {
      const src = readFileSync(path.join(root, file), 'utf8');
      assert.doesNotMatch(src, /parseFloat|Number\(|toFixed|toPrecision|Math\./, file);
    }
  });
});

describe('reviewTransaction: stage 1, decode', () => {
  test('garbage bytes ⇒ tx_decode_failed, deny, and no RPC call at all', async () => {
    const { W, lists } = actors();
    const rpc = fakeRpc();
    const r = await review({ bytes: new Uint8Array([1, 2, 3, 4]), wallet: W, rpc, lists });
    assert.equal(r.verdict, 'deny');
    assert.deepEqual(codes(r.violations), ['tx_decode_failed']);
    assert.equal(r.messageSha256, null);
    assert.equal(r.sim, null);
    assert.equal(r.summaryLine, 'undecodable transaction (4 bytes)');
    assert.deepEqual(rpc.calls, []);
  });

  test('bytes that are not a Uint8Array (e.g. the base64 text itself) ⇒ tx_decode_failed', async () => {
    const { W, lists } = actors();
    const rpc = fakeRpc();
    const r = await review({ bytes: 'AQID', wallet: W, rpc, lists });
    assert.deepEqual(codes(r.violations), ['tx_decode_failed']);
    assert.deepEqual(rpc.calls, []);
  });

  test('a recognised instruction with short data ⇒ tx_decode_failed, never simulated', async () => {
    const { wallet, W, friend, lists } = actors();
    const bytes = buildTx(wallet, [{ programId: SYSTEM, accounts: [[W, true, true], [friend, false, true]], data: [2, 0, 0, 0, 1] }]);
    const rpc = fakeRpc();
    const r = await review({ bytes, wallet: W, rpc, lists });
    assert.deepEqual(codes(r.violations), ['tx_decode_failed']);
    assert.match(r.violations[0].message, /too short/);
    assert.match(r.messageSha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(rpc.calls, []);
  });

  test('v0: a destination that lives in a lookup table is resolved and checked', async () => {
    const { W, friend, attacker, lists } = actors();
    const table = randomAddress();
    for (const [dest, expected] of [[friend, 'hold'], [attacker, 'deny']]) {
      const msg = message({
        version: 0,
        header: [1, 0, 1],
        keys: [W, SYSTEM],
        instructions: [{ p: 1, a: [0, 2], d: data.systemTransfer(10_000_000) }],
        lookups: [{ key: table, w: [0], r: [] }],
      });
      const rpc = fakeRpc({
        pre: { [W]: sol(1_000_000_000) },
        post: { [W]: sol(989_995_000), [dest]: sol(10_000_000) },
        extra: { [table]: rpcAccount({ owner: ALT_PROGRAM, data: lookupTableData([dest]) }) },
      });
      const r = await review({ bytes: transaction(msg, [null]), wallet: W, rpc, lists });
      assert.equal(r.version, 0);
      assert.equal(r.instructions[0].destination, dest);
      assert.equal(r.verdict, expected);
      if (expected === 'deny') assert.deepEqual(codes(r.violations), ['destination_not_allowed']);
      assert.deepEqual(rpc.calls[0], { method: 'getMultipleAccounts', params: [[table], { encoding: 'base64', commitment: 'confirmed' }] });
    }
  });

  test('v0: a lookup table that does not exist ⇒ tx_decode_failed, never simulated', async () => {
    const { W, friend, lists } = actors();
    const msg = message({
      version: 0,
      header: [1, 0, 1],
      keys: [W, SYSTEM],
      instructions: [{ p: 1, a: [0, 2], d: data.systemTransfer(10_000_000) }],
      lookups: [{ key: randomAddress(), w: [0], r: [] }],
    });
    const rpc = fakeRpc({ pre: { [W]: sol(1_000_000_000), [friend]: sol(0) } });
    const r = await review({ bytes: transaction(msg, [null]), wallet: W, rpc, lists });
    assert.deepEqual(codes(r.violations), ['tx_decode_failed']);
    assert.match(r.violations[0].message, /does not exist/);
    assert.deepEqual(rpc.methods(), ['getMultipleAccounts']);
  });
});

describe('reviewTransaction: stage 2, static rules (never simulated when they deny)', () => {
  test('program not in tx.programs ⇒ program_not_allowed, no RPC call', async () => {
    const { wallet, W, friend, lists } = actors();
    const rogue = randomAddress();
    const bytes = buildTx(wallet, [IX.opaque(rogue, [[W, true, true]]), IX.sysTransfer(W, friend, 1_000)]);
    const rpc = fakeRpc();
    const r = await review({ bytes, wallet: W, rpc, lists });
    assert.equal(r.verdict, 'deny');
    assert.deepEqual(codes(r.violations), ['program_not_allowed']);
    assert.deepEqual(r.violations[0], {
      code: 'program_not_allowed', path: 'instructions[0].programId', observed: rogue, bound: 'tx.programs',
      message: `instruction 0 calls program ${rogue}, which is not in tx.programs`,
    });
    assert.deepEqual(r.programs, [rogue, SYSTEM]);
    assert.equal(r.sim, null);
    assert.equal(r.summaryLine, `not simulated · ${rogue.slice(0, 4)}… · 2 ix`);
    assert.deepEqual(rpc.calls, []);
  });

  test('unknownProgram "warn" ⇒ warning, simulated, held with the warning attached', async () => {
    const { wallet, W, friend, lists } = actors();
    const rogue = randomAddress();
    const bytes = buildTx(wallet, [IX.opaque(rogue, [[W, true, true]]), IX.sysTransfer(W, friend, 1_000_000)]);
    const rpc = fakeRpc({ pre: { [W]: sol(100_000_000) }, post: { [W]: sol(98_995_000), [friend]: sol(1_000_000) } });
    const r = await review({ bytes, wallet: W, rpc, lists, tx: policy({ unknownProgram: 'warn' }) });
    assert.equal(r.verdict, 'hold');
    assert.deepEqual(r.violations, []);
    assert.deepEqual(codes(r.warnings), ['program_not_allowed']);
    assert.ok(rpc.methods().includes('simulateTransaction'));
  });

  for (const kind of ['approve', 'approveChecked', 'setAuthority']) {
    test(`SPL ${kind} ⇒ token_delegation_denied, no RPC call`, async () => {
      const { wallet, W, attacker, lists } = actors();
      const myAta = randomAddress();
      const mint = randomAddress();
      const ix = {
        approve: () => IX.approve(myAta, attacker, W, 1_000_000),
        approveChecked: () => IX.approveChecked(myAta, mint, attacker, W, 1_000_000, 6),
        setAuthority: () => IX.setAuthority(myAta, W, 2, attacker),
      }[kind]();
      const rpc = fakeRpc();
      const r = await review({ bytes: buildTx(wallet, [ix]), wallet: W, rpc, lists });
      assert.equal(r.verdict, 'deny');
      assert.deepEqual(codes(r.violations), ['token_delegation_denied']);
      assert.equal(r.violations[0].bound, 'tx.denyTokenDelegation');
      assert.match(r.violations[0].message, new RegExp(attacker));
      assert.deepEqual(rpc.calls, []);
    });
  }

  test('denyTokenDelegation false ⇒ approve passes the static stage', async () => {
    const { wallet, W, attacker, lists } = actors();
    const bytes = buildTx(wallet, [IX.approve(randomAddress(), attacker, W, 5)]);
    const rpc = fakeRpc({ pre: { [W]: sol(10_000_000) }, post: { [W]: sol(9_995_000) } });
    const r = await review({ bytes, wallet: W, rpc, lists, tx: policy({ denyTokenDelegation: false }) });
    assert.equal(r.verdict, 'hold');
  });

  test('SPL legacy Transfer (tag 3) ⇒ legacy_token_transfer_denied, no RPC call', async () => {
    const { wallet, W, friend, lists } = actors();
    const bytes = buildTx(wallet, [IX.legacyTransfer(randomAddress(), friend, W, 1_000)]);
    const rpc = fakeRpc();
    const r = await review({ bytes, wallet: W, rpc, lists });
    assert.equal(r.verdict, 'deny');
    assert.deepEqual(codes(r.violations), ['legacy_token_transfer_denied']);
    assert.equal(r.instructions[0].amount, '1000');
    assert.deepEqual(rpc.calls, []);
  });

  test('every finding of the static set is collected, and simulation rules are not reached', async () => {
    const { wallet, W, attacker, lists } = actors();
    const rogue = randomAddress();
    const bytes = buildTx(wallet, [
      IX.sysTransfer(W, attacker, 900_000_000), // would also fail destinations and outflow
      IX.opaque(rogue, []),
      IX.approve(randomAddress(), attacker, W, 1),
      IX.legacyTransfer(randomAddress(), attacker, W, 1),
    ]);
    const rpc = fakeRpc();
    const r = await review({ bytes, wallet: W, rpc, lists });
    assert.deepEqual(codes(r.violations), ['program_not_allowed', 'token_delegation_denied', 'legacy_token_transfer_denied']);
    assert.deepEqual(rpc.calls, []);
  });
});

describe('reviewTransaction: stage 3, simulation', () => {
  for (const failOn of ['getTokenAccountsByOwner', 'getMultipleAccounts', 'simulateTransaction']) {
    test(`RPC failure in ${failOn} ⇒ rpc_unavailable, deny`, async () => {
      const { wallet, W, friend, lists } = actors();
      const bytes = buildTx(wallet, [IX.sysTransfer(W, friend, 1_000)]);
      const rpc = fakeRpc({ pre: { [W]: sol(10_000_000) }, failOn });
      const r = await review({ bytes, wallet: W, rpc, lists });
      assert.equal(r.verdict, 'deny');
      assert.deepEqual(codes(r.violations), ['rpc_unavailable']);
      assert.equal(r.sim, null);
      assert.deepEqual(r.outflow, {});
    });
  }

  test('a real SolanaRpc whose upstream answers HTTP 500 ⇒ rpc_unavailable, and the URL never appears', async () => {
    const server = createServer((req, res) => {
      req.resume();
      res.writeHead(500);
      res.end();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const marker = `upstream-marker-${randomUUID()}`;
    try {
      const rpc = new SolanaRpc({ url: `http://127.0.0.1:${server.address().port}/${marker}`, timeoutMs: 5000 });
      const { wallet, W, friend, lists } = actors();
      const r = await review({ bytes: buildTx(wallet, [IX.sysTransfer(W, friend, 1_000)]), wallet: W, rpc, lists });
      assert.deepEqual(codes(r.violations), ['rpc_unavailable']);
      assert.match(r.violations[0].message, /HTTP 500/);
      assert.ok(!JSON.stringify(r).includes(marker));
      assert.ok(!JSON.stringify(r).includes(String(server.address().port)));
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('sim.err ⇒ simulation_failed, deny, err kept in the Review', async () => {
    const { wallet, W, friend, lists } = actors();
    const simErr = { InstructionError: [0, { Custom: 1 }] };
    const rpc = fakeRpc({ pre: { [W]: sol(10_000_000) }, simErr });
    const r = await review({ bytes: buildTx(wallet, [IX.sysTransfer(W, friend, 1_000)]), wallet: W, rpc, lists });
    assert.equal(r.verdict, 'deny');
    assert.deepEqual(codes(r.violations), ['simulation_failed']);
    assert.deepEqual(r.sim, { ok: false, err: simErr, logs: ['Program log: scripted'], unitsConsumed: 4321 });
    assert.equal(r.violations[0].observed, JSON.stringify(simErr));
    assert.equal(r.summaryLine, 'simulation failed · 1 ix');
  });

  test('signed sends simulate with sigVerify; tool-argument transactions without', async () => {
    const { wallet, W, friend, lists } = actors();
    for (const signed of [true, false]) {
      const rpc = fakeRpc({ pre: { [W]: sol(10_000_000) }, post: { [W]: sol(9_994_000) } });
      const bytes = buildTx(wallet, [IX.sysTransfer(W, friend, 1_000)], { sign: signed });
      await review({ bytes, wallet: W, rpc, lists, signed });
      const sim = rpc.calls.find((c) => c.method === 'simulateTransaction');
      assert.equal(sim.params[1].sigVerify, signed);
      assert.equal(sim.params[0], Buffer.from(bytes).toString('base64'));
      assert.deepEqual(sim.params[1].accounts.addresses, [W, friend]);
    }
  });
});

describe('reviewTransaction: stage 4, simulation rules', () => {
  test('drain: 0.5 SOL to an unknown address, cap 0.05 ⇒ destination_not_allowed and outflow_exceeds_bound', async () => {
    const { wallet, W, attacker, lists } = actors();
    const bytes = buildTx(wallet, [IX.sysTransfer(W, attacker, 500_000_000)]);
    const rpc = fakeRpc({
      pre: { [W]: sol(1_000_000_000) },
      post: { [W]: sol(499_995_000), [attacker]: sol(500_000_000) },
    });
    const r = await review({ bytes, wallet: W, rpc, lists });
    assert.equal(r.verdict, 'deny');
    assert.deepEqual(codes(r.violations), ['destination_not_allowed', 'outflow_exceeds_bound']);
    assert.ok(rpc.methods().includes('simulateTransaction'), 'both rules are simulation-phase');
    assert.deepEqual(r.violations[0], {
      code: 'destination_not_allowed',
      path: 'instructions[0].destination',
      observed: attacker,
      bound: '@allowlist',
      message: `instruction 0 (system transfer) sends to ${attacker}, which is not the wallet, `
        + 'not a token account the wallet owns after simulation, and not in @allowlist',
    });
    assert.deepEqual(r.violations[1], {
      code: 'outflow_exceeds_bound',
      path: 'outflow.SOL',
      observed: '0.500005',
      bound: '0.05',
      message: 'SOL outflow (lamports, fees, rent and wrapped SOL) 0.500005 exceeds tx.maxOutflow.SOL = 0.05 by 0.450005',
    });
    assert.deepEqual(r.outflow, { SOL: '0.500005' });
    assert.deepEqual(r.inflow, {});
    assert.equal(r.instructions[0].lamports, '500000000');
    assert.equal(r.summaryLine, '−0.500005 SOL · 1 ix');
  });

  test('drain with destinations "any" ⇒ outflow_exceeds_bound only', async () => {
    const { wallet, W, attacker, lists } = actors();
    const bytes = buildTx(wallet, [IX.sysTransfer(W, attacker, 500_000_000)]);
    const rpc = fakeRpc({ pre: { [W]: sol(1_000_000_000) }, post: { [W]: sol(499_995_000) } });
    const r = await review({ bytes, wallet: W, rpc, lists, tx: policy({ destinations: 'any' }) });
    assert.equal(r.verdict, 'deny');
    assert.deepEqual(codes(r.violations), ['outflow_exceeds_bound']);
    assert.match(r.violations[0].message, /by 0\.450005$/);
  });

  test('an allowlisted transfer under the cap ⇒ hold', async () => {
    const { wallet, W, friend, lists } = actors();
    const bytes = buildTx(wallet, [IX.sysTransfer(W, friend, 1_000_000), IX.memo('rent')]);
    const rpc = fakeRpc({ pre: { [W]: sol(1_000_000_000) }, post: { [W]: sol(998_995_000), [friend]: sol(1_000_000) } });
    const r = await review({ bytes, wallet: W, rpc, lists });
    assert.equal(r.verdict, 'hold');
    assert.deepEqual(r.violations, []);
    assert.deepEqual(r.outflow, { SOL: '0.001005' });
    assert.equal(r.summaryLine, '−0.001005 SOL · 2 ix');
    assert.equal(r.instructions[1].text, 'rent');
  });

  test('swap-shaped vector under caps ⇒ hold with exact outflow / inflow strings and USDC in the summary', async () => {
    const { wallet, W } = actors();
    const usdcAta = randomAddress();
    const bytes = buildTx(wallet, [
      IX.computeLimit(200_000),
      IX.computePrice(1_000),
      IX.ataCreateIdempotent(W, usdcAta, W, USDC),
      IX.opaque(JUP6, [[W, true, true], [usdcAta, false, true], [USDC, false, false]]),
    ]);
    const rpc = fakeRpc({
      owned: { [TOKEN]: [usdcAta] },
      pre: { [W]: sol(20_000_000), [usdcAta]: tokenAcct(USDC, W, 0n) },
      // 1,000,000 lamports swapped + 5,000 fee; +170,000 raw USDC (6 decimals).
      post: { [W]: sol(18_995_000), [usdcAta]: tokenAcct(USDC, W, 170_000n) },
      extra: { [USDC]: mintAcct(6) },
    });
    const tx = policy({
      programs: [...PROGRAMS, JUP6], maxOutflow: { SOL: 0.003, [USDC]: 1 }, destinations: 'any',
    });
    const r = await review({ bytes, wallet: W, rpc, tx });
    assert.equal(r.verdict, 'hold');
    assert.deepEqual(r.violations, []);
    assert.deepEqual(r.warnings, []);
    assert.deepEqual(r.outflow, { SOL: '0.001005' });
    assert.deepEqual(r.inflow, { [USDC]: '0.17' });
    assert.equal(r.summaryLine, '−0.001005 SOL, +0.17 USDC · JUP6… · 4 ix');
    assert.deepEqual(r.programs, [COMPUTE_BUDGET, ATA, JUP6]);
    assert.equal(r.instructions[1].microLamports, '1000');
    assert.equal(r.feePayer, W);
    assert.equal(r.version, 'legacy');
    assert.match(r.messageSha256, /^[0-9a-f]{64}$/);
  });

  test("wrapped-SOL ATA created in the same transaction is the wallet's own: allowed, and its balance offsets the SOL outflow", async () => {
    const { wallet, W, lists } = actors();
    const wsolAta = randomAddress();
    const bytes = buildTx(wallet, [
      IX.ataCreateIdempotent(W, wsolAta, W, NATIVE_MINT),
      IX.sysTransfer(W, wsolAta, 30_000_000),
      IX.syncNative(wsolAta),
    ]);
    const rent = 2_039_280;
    const pre = { [W]: sol(100_000_000) };
    const extra = { [NATIVE_MINT]: mintAcct(9) };

    // Wrapping 0.03 SOL under a 0.05 cap: only rent + fee leave the wallet.
    const mine = fakeRpc({
      pre, extra,
      post: { [W]: sol(100_000_000 - rent - 30_000_000 - 5_000), [wsolAta]: tokenAcct(NATIVE_MINT, W, 30_000_000n, rent + 30_000_000) },
    });
    const r = await review({ bytes, wallet: W, rpc: mine, lists });
    assert.equal(r.verdict, 'hold');
    assert.deepEqual(r.violations, []);
    assert.deepEqual(r.outflow, { SOL: '0.00204428' });
    assert.deepEqual(r.inflow, {});
    assert.deepEqual(mine.calls.find((c) => c.method === 'simulateTransaction').params[1].accounts.addresses, [W, wsolAta]);

    // Same bytes, but the post-state account belongs to someone else: not the wallet's.
    const theirs = fakeRpc({
      pre, extra,
      post: { [W]: sol(100_000_000 - rent - 30_000_000 - 5_000), [wsolAta]: tokenAcct(NATIVE_MINT, randomAddress(), 30_000_000n) },
    });
    const r2 = await review({ bytes, wallet: W, rpc: theirs, lists });
    assert.equal(r2.verdict, 'deny');
    assert.deepEqual(codes(r2.violations), ['destination_not_allowed']);
    assert.deepEqual(r2.outflow, { SOL: '0.03204428' });
  });

  test('transferChecked between two of the wallet\'s own token accounts is allowed without a list entry', async () => {
    const { wallet, W, lists } = actors();
    const mint = randomAddress();
    const [a, b] = [randomAddress(), randomAddress()];
    const bytes = buildTx(wallet, [IX.transferChecked(a, mint, b, W, 5_000_000, 6)]);
    const rpc = fakeRpc({
      owned: { [TOKEN]: [a, b] },
      pre: { [W]: sol(10_000_000), [a]: tokenAcct(mint, W, 5_000_000n), [b]: tokenAcct(mint, W, 0n) },
      post: { [W]: sol(9_995_000), [a]: tokenAcct(mint, W, 0n), [b]: tokenAcct(mint, W, 5_000_000n) },
      extra: { [mint]: mintAcct(6) },
    });
    const r = await review({ bytes, wallet: W, rpc, lists });
    assert.equal(r.verdict, 'hold');
    assert.deepEqual(r.outflow, { SOL: '0.000005' });
    assert.equal(r.instructions[0].amount, '5000000');
  });

  test('transferChecked to a token account of an allowlisted owner is still refused (the list names destinations, not owners)', async () => {
    const { wallet, W, friend, lists } = actors();
    const [mine, friendAta] = [randomAddress(), randomAddress()];
    const bytes = buildTx(wallet, [IX.transferChecked(mine, USDC, friendAta, W, 100_000, 6)]);
    const rpc = fakeRpc({
      owned: { [TOKEN]: [mine] },
      pre: { [W]: sol(10_000_000), [mine]: tokenAcct(USDC, W, 1_000_000n), [friendAta]: tokenAcct(USDC, friend, 0n) },
      post: { [W]: sol(9_995_000), [mine]: tokenAcct(USDC, W, 900_000n), [friendAta]: tokenAcct(USDC, friend, 100_000n) },
      extra: { [USDC]: mintAcct(6) },
    });
    const r = await review({ bytes, wallet: W, rpc, lists, tx: policy({ maxOutflow: { SOL: 0.05, [USDC]: 1 } }) });
    assert.deepEqual(codes(r.violations), ['destination_not_allowed']);
    assert.deepEqual(r.outflow, { SOL: '0.000005', [USDC]: '0.1' });
  });

  test('closeAccount sending the rent to a stranger ⇒ destination_not_allowed', async () => {
    const { wallet, W, attacker, lists } = actors();
    const mine = randomAddress();
    const mint = randomAddress();
    const bytes = buildTx(wallet, [IX.closeAccount(mine, attacker, W)]);
    const rpc = fakeRpc({
      owned: { [TOKEN]: [mine] },
      pre: { [W]: sol(10_000_000), [mine]: tokenAcct(mint, W, 0n) },
      post: { [W]: sol(9_995_000), [mine]: null },
      extra: { [mint]: mintAcct(6) },
    });
    const r = await review({ bytes, wallet: W, rpc, lists });
    assert.deepEqual(codes(r.violations), ['destination_not_allowed']);
    assert.equal(r.violations[0].path, 'instructions[0].destination');
  });

  test('outflow of a mint above its cap ⇒ outflow_exceeds_bound, with the excess', async () => {
    const { wallet, W, friend } = actors();
    const mine = randomAddress();
    const bytes = buildTx(wallet, [IX.transferChecked(mine, USDC, friend, W, 1_500_000, 6)]);
    const rpc = fakeRpc({
      owned: { [TOKEN]: [mine] },
      pre: { [W]: sol(10_000_000), [mine]: tokenAcct(USDC, W, 2_000_000n) },
      post: { [W]: sol(9_995_000), [mine]: tokenAcct(USDC, W, 500_000n) },
      extra: { [USDC]: mintAcct(6) },
    });
    const r = await review({ bytes, wallet: W, rpc, tx: policy({ destinations: 'any', maxOutflow: { SOL: 0.05, [USDC]: 1 } }) });
    assert.deepEqual(codes(r.violations), ['outflow_exceeds_bound']);
    assert.deepEqual(r.violations[0], {
      code: 'outflow_exceeds_bound',
      path: `outflow.${USDC}`,
      observed: '1.5',
      bound: '1',
      message: `outflow of mint ${USDC} 1.5 exceeds tx.maxOutflow["${USDC}"] = 1 by 0.5`,
    });
    assert.equal(r.summaryLine, '−0.000005 SOL, −1.5 USDC · 1 ix');
  });

  test('outflow of a mint with no cap ⇒ mint_not_allowed; unknownMintOutflow "warn" ⇒ hold with the warning', async () => {
    const { wallet, W, friend } = actors();
    const mint = randomAddress();
    const mine = randomAddress();
    const bytes = buildTx(wallet, [IX.transferChecked(mine, mint, friend, W, 42, 0)]);
    const scripted = () => fakeRpc({
      owned: { [TOKEN]: [mine] },
      pre: { [W]: sol(10_000_000), [mine]: tokenAcct(mint, W, 100n) },
      post: { [W]: sol(9_995_000), [mine]: tokenAcct(mint, W, 58n) },
      extra: { [mint]: mintAcct(0) },
    });
    const denied = await review({ bytes, wallet: W, rpc: scripted(), tx: policy({ destinations: 'any' }) });
    assert.equal(denied.verdict, 'deny');
    assert.deepEqual(codes(denied.violations), ['mint_not_allowed']);
    assert.equal(denied.violations[0].observed, '42');
    assert.deepEqual(denied.outflow, { SOL: '0.000005', [mint]: '42' });
    assert.match(denied.summaryLine, new RegExp(`^−0\\.000005 SOL, −42 ${mint.slice(0, 4)}…${mint.slice(-4)} · 1 ix$`));

    const warned = await review({ bytes, wallet: W, rpc: scripted(), tx: policy({ destinations: 'any', unknownMintOutflow: 'warn' }) });
    assert.equal(warned.verdict, 'hold');
    assert.deepEqual(codes(warned.warnings), ['mint_not_allowed']);
  });

  test('unknown decimals ⇒ raw units, a warning, and the cap compared as if 0 decimals', async () => {
    const { wallet, W, friend } = actors();
    const mint = randomAddress();
    const mine = randomAddress();
    const run = async (sent) => {
      const bytes = buildTx(wallet, [IX.transferChecked(mine, mint, friend, W, sent, 6)]);
      const rpc = fakeRpc({
        owned: { [TOKEN]: [mine] },
        pre: { [W]: sol(10_000_000), [mine]: tokenAcct(mint, W, 1_000_000n) },
        post: { [W]: sol(9_995_000), [mine]: tokenAcct(mint, W, 1_000_000n - BigInt(sent)) },
        // no mint account: decimals cannot be read
      });
      return review({ bytes, wallet: W, rpc, tx: policy({ destinations: 'any', maxOutflow: { SOL: 0.05, [mint]: 1000 } }) });
    };
    const small = await run(500);
    assert.equal(small.verdict, 'hold');
    assert.deepEqual(small.outflow, { SOL: '0.000005', [mint]: '500' });
    assert.deepEqual(codes(small.warnings), ['mint_decimals_unknown']);
    assert.match(small.summaryLine, /−500 raw /);

    const big = await run(5_000);
    assert.deepEqual(codes(big.violations), ['outflow_exceeds_bound']);
    assert.match(big.violations[0].message, /5000 \(raw units\) exceeds .* = 1000 by 4000$/);
  });
});

describe('reviewTransaction: stage 5, verdict', () => {
  const clean = async (tx) => {
    const { wallet, W, friend, lists } = actors();
    const bytes = buildTx(wallet, [IX.sysTransfer(W, friend, 1_000_000)]);
    const rpc = fakeRpc({ pre: { [W]: sol(100_000_000) }, post: { [W]: sol(98_995_000) } });
    return review({ bytes, wallet: W, rpc, lists, tx });
  };

  test('approval "never" ⇒ allow', async () => {
    assert.equal((await clean(policy({ approval: 'never' }))).verdict, 'allow');
  });

  test('approval "always" ⇒ hold; omitted ⇒ hold', async () => {
    assert.equal((await clean(policy({ approval: 'always' }))).verdict, 'hold');
    const { approval, ...rest } = policy();
    assert.equal(approval, 'always');
    assert.equal((await clean(rest)).verdict, 'hold');
  });

  test('a raw tx config is compiled on the way in; caller mistakes throw', async () => {
    const { wallet, W, friend, lists } = actors();
    const bytes = buildTx(wallet, [IX.sysTransfer(W, friend, 1_000_000)]);
    const rpc = fakeRpc({ pre: { [W]: sol(100_000_000) }, post: { [W]: sol(98_995_000) } });
    const r = await reviewTransaction({ bytes, wallet: W, rpc, txPolicy: policy(), lists, cluster: 'devnet', signed: false });
    assert.equal(r.verdict, 'hold');
    await assert.rejects(reviewTransaction({ bytes, wallet: W, rpc, txPolicy: { maxOutflow: {} }, lists, signed: false }), UsageError);
    await assert.rejects(reviewTransaction({ bytes, wallet: 'nope', rpc, txPolicy: policy(), lists, signed: false }));
    await assert.rejects(reviewTransaction({ bytes, wallet: W, rpc, txPolicy: policy(), lists }), TypeError);
  });
});
