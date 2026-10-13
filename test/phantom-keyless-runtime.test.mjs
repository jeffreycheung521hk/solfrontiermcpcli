// Hermetic prototype checks only: generated Ed25519 keys, in-memory scripted
// RPC responses and transports. No network, actual wallet or browser is used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import { createKeylessRuntime, validateSignedTransaction, SOL, USDC, MAINNET_GENESIS } from '../scripts/hackathon/phantom/phantom-keyless-runtime.mjs';
import { prepareConfig } from '../scripts/hackathon/phantom/phantom-keyless-server.mjs';
import { AuditLog, verifyChainText } from '../src/gate/audit-log.mjs';
import { HoldQueue } from '../src/gate/holds.mjs';
import { collectSentTransactions, verifyAuditLog } from '../src/commands/audit.mjs';
import { decodeTransaction } from '../src/solana/tx.mjs';
import { keypair, randomAddress, message, transaction, rpcAccount, tokenAccountData,
  mintData, lookupTableData, TOKEN, ALT_PROGRAM } from './solana-builders.mjs';

// The imported helper only prepares/validates public config. It never starts
// listeners or reads the real RPC credential when called in this mode.
const configDirectory = mkdtempSync(path.join(tmpdir(), 'phantom-public-config-'));
let baseConfig;
try { baseConfig = prepareConfig({ directory: configDirectory }).config; }
finally { rmSync(configDirectory, { recursive: true, force: true }); }
const JUP6 = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const base64 = (bytes) => Buffer.from(bytes).toString('base64');
const token = (wallet, amount) => rpcAccount({ lamports: 2039280, owner: TOKEN,
  data: tokenAccountData({ mint: USDC, owner: wallet, amount }) });

function vector({ cosigner = null, missingCosigner = false, lookup = false } = {}) {
  const wallet = keypair();
  const tokenAddress = randomAddress();
  const alt = randomAddress();
  const keys = cosigner ? [wallet.address, cosigner.address, tokenAddress, JUP6]
    : lookup ? [wallet.address, JUP6] : [wallet.address, tokenAddress, JUP6];
  const msg = message({ version: lookup ? 0 : 'legacy', header: [cosigner ? 2 : 1, cosigner ? 1 : 0, 1],
    keys, instructions: [{ p: keys.indexOf(JUP6), a: [0, lookup ? 2 : keys.indexOf(tokenAddress)], d: [7, 7, 7] }],
    ...(lookup ? { lookups: [{ key: alt, w: [0], r: [] }] } : {}) });
  const unsigned = base64(transaction(msg, cosigner ? [null, missingCosigner ? null : cosigner] : [null]));
  const signed = base64(transaction(msg, cosigner ? [wallet, cosigner] : [wallet]));
  return { wallet, tokenAddress, alt, msg, unsigned, signed };
}

function fixture(options = {}) {
  const v = vector(options);
  const approver = keypair();
  const directory = mkdtempSync(path.join(tmpdir(), 'phantom-runtime-fake-'));
  const auditPath = path.join(directory, 'audit.jsonl');
  const audit = AuditLog.open(auditPath);
  const counts = { rpc: [], orders: 0, execute: 0, simulations: [] };
  const vars = { output: 110000, solOut: 1005000, simErr: null, genesis: MAINNET_GENESIS,
    blockhashValid: true, response: 'Success', echoSigned: false, time: Date.now(), failRpc: null,
    failAuditType: null, auditError: 'scripted unknown audit error', simGate: null, blockhashGate: null,
    auditAdvanceMs: 0 };
  const timers = [];
  const setFakeTimer = (callback, ms) => {
    const timer = { callback, at: vars.time + ms, cancelled: false };
    timers.push(timer);
    return timer;
  };
  const clearFakeTimer = (timer) => { timer.cancelled = true; };
  const timerOptions = options.manualTimers ? { setTimer: setFakeTimer, clearTimer: clearFakeTimer } : {};
  const holds = new HoldQueue({ approver: approver.address, now: () => vars.time, ...timerOptions });
  function advance(ms) {
    vars.time += ms;
    for (let limit = 0; limit < 100; limit += 1) {
      const due = timers.filter(timer => !timer.cancelled && timer.at <= vars.time).sort((a, b) => a.at - b.at)[0];
      if (!due) return;
      due.cancelled = true;
      due.callback();
    }
    assert.fail('fake deadline timers did not settle');
  }
  const raw = { inputMint: SOL, outputMint: USDC, inAmount: '1000000', outAmount: '110000',
    otherAmountThreshold: '109450', swapMode: 'ExactIn', slippageBps: 50, taker: v.wallet.address,
    requestId: 'fake-order-for-hermetic-test', transaction: v.unsigned };
  const pre = () => ({ [v.wallet.address]: rpcAccount({ lamports: 50000000 }),
    [v.tokenAddress]: token(v.wallet.address, 0) });
  const post = () => ({ [v.wallet.address]: rpcAccount({ lamports: 50000000 - vars.solOut }),
    [v.tokenAddress]: token(v.wallet.address, vars.output) });
  const extra = { [USDC]: rpcAccount({ owner: TOKEN, data: mintData({ decimals: 6 }) }),
    [v.alt]: rpcAccount({ owner: ALT_PROGRAM, data: lookupTableData([v.tokenAddress]) }) };
  const rpc = { async call(method, params = []) {
    counts.rpc.push(method);
    if (vars.failRpc === method) throw new Error('scripted RPC unavailable');
    const context = { slot: 123 };
    switch (method) {
      case 'getGenesisHash': return vars.genesis;
      case 'isBlockhashValid':
        if (vars.blockhashGate) await vars.blockhashGate;
        return { context, value: vars.blockhashValid };
      case 'getTokenAccountsByOwner': return { context,
        value: params[1].programId === TOKEN ? [{ pubkey: v.tokenAddress, account: pre()[v.tokenAddress] }] : [] };
      case 'getMultipleAccounts': return { context, value: params[0].map(address => extra[address] ?? pre()[address] ?? null) };
      case 'simulateTransaction': {
        const simulationTx = decodeTransaction(Buffer.from(params[0], 'base64'));
        assert.ok(simulationTx.signatures.every(signature => signature.every(value => value === 0)),
          'RPC must receive only zero signature slots, even after Phantom signed');
        assert.ok(Buffer.from(simulationTx.messageBytes).equals(Buffer.from(v.msg)), 'simulation preserves exact message');
        assert.notEqual(params[0], v.signed, 'broadcast-capable payload must never reach simulation RPC');
        assert.equal(params[1].sigVerify, false);
        assert.equal(params[1].encoding, 'base64');
        counts.simulations.push(params[0]);
        if (vars.simGate) await vars.simGate;
        return { context, value: { err: vars.simErr,
          // A hostile fake RPC can echo arbitrary bytes known to its fixture;
          // this still tests the audit redactor independently of RPC stripping.
          logs: vars.echoSigned ? [`echo ${v.signed}`] : ['Program log: synthetic fake swap'], unitsConsumed: 4321,
          accounts: vars.simErr ? null : params[1].accounts.addresses.map(address => post()[address] ?? pre()[address] ?? null) } };
      }
      default: throw new Error(`unexpected fake RPC method: ${method}`);
    }
  } };
  const transport = {
    async order(params) {
      counts.orders += 1;
      assert.deepEqual(params, { inputMint: SOL, outputMint: USDC, amount: '1000000', taker: v.wallet.address });
      return { ...raw };
    },
    async execute(body) {
      counts.execute += 1;
      assert.equal(body.signedTransaction, v.signed);
      assert.equal(body.requestId, raw.requestId);
      const records = readRecords();
      assert.ok(records.some(record => record.type === 'hold_approved'));
      assert.equal(records.at(-1).type, 'execute_attempt', 'intent must be durable before the fake POST');
      if (vars.response === 'timeout') throw new Error('synthetic timeout, no network request');
      if (vars.response === 'mismatch') return { status: 'Success', signature: randomAddress() };
      return { status: vars.response, signature: validateSignedTransaction(v.unsigned, v.signed, v.wallet.address).signature };
    },
  };
  const config = { ...baseConfig, approver: approver.address, audit: { path: auditPath },
    ...(options.approvalTimeoutSec ? { approval: { ...baseConfig.approval, timeoutSec: options.approvalTimeoutSec } } : {}) };
  const diagnosticAudit = { append(type, payload) {
    if (vars.failAuditType === type) throw new Error(vars.auditError);
    const record = audit.append(type, payload);
    if (type === 'execute_attempt') vars.time += vars.auditAdvanceMs;
    return record;
  } };
  const runtime = createKeylessRuntime({ config, rpc, transport, audit: diagnosticAudit, holds,
    approvalUrl: 'http://127.0.0.1:8787', now: () => vars.time,
    wallet: v.wallet.address, approver: approver.address, blockhashPollMs: options.pollMs ?? 0,
    orderLifetimeMs: options.orderLifetimeMs, executionReserveMs: options.executionReserveMs,
    maxPaymentAgeMs: options.maxPaymentAgeMs, signStartLimitMs: options.signStartLimitMs, ...timerOptions });
  function readRecords() { return readFileSync(auditPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  async function pendingHold() {
    for (let index = 0; index < 100; index += 1) {
      const pending = holds.listPending();
      if (pending.length) return pending[0];
      await tick();
    }
    assert.fail('fake review must create a pending Gate hold');
  }
  function approve(hold) {
    holds.approve(hold.id, { publicKey: approver.address,
      signature: new Uint8Array(sign(null, Buffer.from(hold.approvalMessage), approver.privateKey)) });
  }
  async function ready() { runtime.resume(); return runtime.quote(); }
  async function cleanup() { await runtime.close(); rmSync(directory, { recursive: true, force: true }); }
  return { ...v, runtime, vars, counts, raw, holds, approver, readRecords, pendingHold, approve, ready, cleanup,
    auditPath, timers, advance };
}

test('valid exact-message Phantom signature is verified, and output is public-only', () => {
  const v = vector();
  const result = validateSignedTransaction(v.unsigned, v.signed, v.wallet.address);
  assert.match(result.messageSha256, /^[0-9a-f]{64}$/);
  assert.equal(Object.keys(result).sort().join(','), 'messageSha256,signature');
});

test('changed message, invalid signature, wrong signer and noncanonical encoding are refused', () => {
  const v = vector();
  const changed = Buffer.from(v.signed, 'base64');
  changed[changed.length - 1] ^= 1;
  assert.throws(() => validateSignedTransaction(v.unsigned, changed.toString('base64'), v.wallet.address), /transaction_message_changed/);
  const badSig = Buffer.from(v.signed, 'base64');
  badSig[1] ^= 1;
  assert.throws(() => validateSignedTransaction(v.unsigned, badSig.toString('base64'), v.wallet.address), /invalid_transaction_signatures/);
  assert.throws(() => validateSignedTransaction(v.unsigned, v.signed, keypair().address), /wallet_not_required_signer/);
  assert.throws(() => validateSignedTransaction(v.unsigned, `${v.signed}\n`, v.wallet.address), /invalid_transaction_encoding/);
});

test('known valid cosignature is preserved, missing cosigner signature is refused', () => {
  const cosigner = keypair();
  const v = vector({ cosigner });
  assert.ok(validateSignedTransaction(v.unsigned, v.signed, v.wallet.address).signature);
  const missing = vector({ cosigner, missingCosigner: true });
  assert.throws(() => validateSignedTransaction(missing.unsigned, missing.signed, missing.wallet.address), /missing_cosigner_signature/);
  const invalidCosig = Buffer.from(v.unsigned, 'base64');
  invalidCosig[65] ^= 1;
  assert.throws(() => validateSignedTransaction(invalidCosig.toString('base64'), v.signed, v.wallet.address), /invalid_original_signature/);
});

test('constructor and initially paused quote perform no I/O', async () => {
  const f = fixture();
  try {
    assert.equal(f.runtime.state().paused, true);
    await assert.rejects(() => f.runtime.quote(), /simulation_paused/);
    assert.deepEqual(f.counts, { rpc: [], orders: 0, execute: 0, simulations: [] });
  } finally { await f.cleanup(); }
});

test('fake order and fake simulation create no submission before generated Gate approval', async () => {
  const f = fixture();
  try {
    const order = await f.ready();
    assert.equal(order.inAmount, '1000000');
    const pending = f.runtime.submit({ id: order.id, signedTransaction: f.signed });
    const hold = await f.pendingHold();
    assert.equal(f.counts.execute, 0);
    assert.equal(f.runtime.state().phase, 'gate-approval-pending');
    assert.equal(f.runtime.state().order.transaction, undefined);
    f.approve(hold);
    const result = await pending;
    assert.equal(result.status, 'submitted');
    assert.equal(f.counts.execute, 1);
    assert.equal(f.runtime.state().phase, 'submitted');
    assert.ok(!JSON.stringify(f.runtime.state()).includes(f.signed));
    const text = readFileSync(f.auditPath, 'utf8');
    assert.ok(!text.includes(f.signed));
    assert.equal(verifyChainText(text).ok, true);
    const groups = collectSentTransactions(f.readRecords());
    assert.equal(groups.length, 1);
    assert.equal(groups[0].link, 'ok');
    assert.equal(groups[0].signature, result.signature);
    // This ledger response is also synthetic; it verifies linkage, not a live transaction.
    const checked = await verifyAuditLog({ text, rpc: { async call(method, params) {
      assert.equal(method, 'getTransaction');
      assert.equal(params[0], result.signature);
      return { transaction: [f.signed, 'base64'], slot: 123, meta: { err: null } };
    } } });
    assert.equal(checked.verdict, 'VERIFIED');
    assert.equal(checked.counts.failed, 0);
    assert.equal(checked.counts.unverified, 0);
    await assert.rejects(() => f.runtime.submit({ id: order.id, signedTransaction: f.signed }), /submission_restart_required/);
  } finally { await f.cleanup(); }
});

test('versioned transaction lookup tables are covered by read-only RPC allowlist', async () => {
  const f = fixture({ lookup: true });
  try {
    const order = await f.ready();
    assert.equal(order.review.version, 0);
    assert.ok(f.counts.rpc.includes('getMultipleAccounts'));
    const pending = f.runtime.submit({ id: order.id, signedTransaction: f.signed });
    f.approve(await f.pendingHold());
    assert.equal((await pending).status, 'submitted');
  } finally { await f.cleanup(); }
});

test('refused quote keeps its one review as audit evidence without a second simulation', async () => {
  const f = fixture();
  try {
    f.vars.solOut = 4000000;
    await assert.rejects(() => f.ready(), /transaction_review_refused/);
    assert.equal(f.counts.simulations.length, 1);
    const reviews = f.readRecords().filter(record => record.type === 'public_order_review');
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0].review.verdict, 'deny');
    assert.ok(reviews[0].review.violations.some(violation => violation.code === 'outflow_exceeds_bound'));
    assert.equal(f.runtime.state().order, null);
    assert.equal(f.counts.execute, 0);
    assert.equal(f.holds.listPending().length, 0);
  } finally { await f.cleanup(); }
});

test('pre-sign and final Gate review send only unsigned legacy/v0 payloads to fake RPC', async () => {
  for (const lookup of [false, true]) {
    const f = fixture({ lookup });
    try {
      const order = await f.ready();
      assert.equal(f.counts.simulations.length, 1);
      assert.equal(f.counts.simulations[0], f.unsigned);
      const pending = f.runtime.submit({ id: order.id, signedTransaction: f.signed });
      const hold = await f.pendingHold();
      assert.equal(f.counts.simulations.length, 2);
      assert.equal(f.counts.simulations[1], f.unsigned);
      assert.equal(f.counts.execute, 0);
      f.approve(hold);
      assert.equal((await pending).status, 'submitted');
      assert.equal(f.counts.execute, 1, 'only approved Jupiter transport receives signed bytes');
    } finally { await f.cleanup(); }
  }
});

test('all cosigner slots are stripped for simulation while signed execute preserves them', async () => {
  const f = fixture({ cosigner: keypair() });
  try {
    const order = await f.ready();
    assert.notEqual(f.counts.simulations[0], f.unsigned, 'known valid original cosigner must also be zeroed for RPC');
    const pending = f.runtime.submit({ id: order.id, signedTransaction: f.signed });
    const hold = await f.pendingHold();
    assert.equal(f.counts.simulations.length, 2);
    assert.equal(f.counts.simulations[0], f.counts.simulations[1]);
    assert.equal(f.counts.execute, 0);
    f.approve(hold);
    assert.equal((await pending).status, 'submitted');
    assert.equal(f.counts.execute, 1);
  } finally { await f.cleanup(); }
});

for (const [label, mutate, code] of [
  ['wrong mainnet genesis', f => { f.vars.genesis = 'not-mainnet'; }, 'wrong_rpc_cluster'],
  ['wrong input amount', f => { f.raw.inAmount = '2000000'; }, 'unexpected_order'],
  ['wrong taker', f => { f.raw.taker = keypair().address; }, 'unexpected_order'],
  ['wrong mint', f => { f.raw.outputMint = SOL; }, 'unexpected_order'],
  ['excess slippage', f => { f.raw.slippageBps = 101; }, 'invalid_order_slippage'],
  ['misleading threshold', f => { f.raw.otherAmountThreshold = '100000'; }, 'order_threshold_too_low'],
  ['threshold above quote', f => { f.raw.otherAmountThreshold = '120000'; }, 'invalid_order_threshold'],
  ['missing minimum', f => { delete f.raw.otherAmountThreshold; }, 'invalid_order_amount'],
  ['simulation loses USDC', f => { f.vars.output = 100000; }, 'minimum_usdc_not_received'],
  ['SOL outflow exceeds cap', f => { f.vars.solOut = 4000000; }, 'transaction_review_refused'],
  ['simulation error', f => { f.vars.simErr = { InstructionError: [0, 'Custom'] }; }, 'transaction_review_refused'],
  ['expired blockhash', f => { f.vars.blockhashValid = false; }, 'blockhash_expired'],
  ['expired order', f => { f.raw.expireAt = new Date(f.vars.time - 1).toISOString(); }, 'order_expired'],
]) {
  test(`fake quote refuses ${label}`, async () => {
    const f = fixture();
    try {
      mutate(f);
      await assert.rejects(() => f.ready(), new RegExp(code));
      assert.equal(f.counts.execute, 0);
      assert.equal(f.holds.listPending().length, 0);
      assert.equal(f.runtime.state().order, null);
    } finally { await f.cleanup(); }
  });
}

test('quote refuses additional unsigned cosigner, but accepts a known valid cosigner', async () => {
  const bad = fixture({ cosigner: keypair(), missingCosigner: true });
  try { await assert.rejects(() => bad.ready(), /missing_cosigner_signature/); }
  finally { await bad.cleanup(); }
  const good = fixture({ cosigner: keypair() });
  try { assert.ok((await good.ready()).transaction); }
  finally { await good.cleanup(); }
});

test('final Gate simulation must still meet minimum USDC before fake POST', async () => {
  const f = fixture();
  try {
    const order = await f.ready();
    f.vars.output = 108000;
    const pending = f.runtime.submit({ id: order.id, signedTransaction: f.signed });
    f.approve(await f.pendingHold());
    const result = await pending;
    assert.equal(result.status, 'refused');
    assert.equal(result.signature, undefined);
    assert.equal(f.counts.execute, 0);
    assert.ok(!f.readRecords().some(record => record.type === 'execute_attempt'));
  } finally { await f.cleanup(); }
});

test('user rejection and pause cancel holds without executing', async () => {
  for (const action of ['reject', 'pause']) {
    const f = fixture();
    try {
      const order = await f.ready();
      const pending = f.runtime.submit({ id: order.id, signedTransaction: f.signed });
      const hold = await f.pendingHold();
      if (action === 'reject') f.holds.reject(hold.id, 'synthetic user rejection');
      else f.runtime.pause();
      assert.equal((await pending).status, 'refused');
      assert.equal(f.counts.execute, 0);
      assert.equal(f.holds.listPending().length, 0);
      await assert.rejects(() => f.runtime.quote(), action === 'pause' ? /simulation_paused/ : /submission_restart_required/);
    } finally { await f.cleanup(); }
  }
});

test('caller cancellation aborts pending approval without a fake POST', async () => {
  const f = fixture();
  try {
    const order = await f.ready();
    const controller = new AbortController();
    const pending = f.runtime.submit({ id: order.id, signedTransaction: f.signed }, controller.signal);
    await f.pendingHold();
    controller.abort();
    assert.equal((await pending).status, 'refused');
    assert.equal(f.counts.execute, 0);
    assert.equal(f.holds.listPending().length, 0);
  } finally { await f.cleanup(); }
});

test('final blockhash expiry refuses fake POST even after generated approval', async () => {
  const f = fixture();
  try {
    const order = await f.ready();
    const pending = f.runtime.submit({ id: order.id, signedTransaction: f.signed });
    const hold = await f.pendingHold();
    f.vars.blockhashValid = false;
    f.approve(hold);
    const result = await pending;
    assert.equal(result.status, 'refused');
    assert.equal(result.error, 'blockhash_expired');
    assert.equal(result.stage, 'blockhash_freshness');
    assert.equal(result.signature, undefined);
    assert.equal(f.counts.execute, 0);
    const records = f.readRecords();
    assert.ok(records.some(record => record.type === 'hold_approved'));
    assert.equal(records.some(record => record.type === 'execute_attempt'), false);
    const refusal = records.find(record => record.type === 'execution_refused');
    assert.equal(refusal.code, 'blockhash_expired');
    assert.equal(refusal.stage, 'blockhash_freshness');
    assert.equal(refusal.callId, records.find(record => record.type === 'hold_approved').callId);
    assert.equal(refusal.requestId, f.raw.requestId);
    assert.equal(refusal.messageSha256, order.messageSha256);
    assert.equal(refusal.signature, undefined);
    assert.ok(!JSON.stringify(refusal).includes(f.signed));
    await assert.rejects(() => f.runtime.quote(), /submission_restart_required/);
    await assert.rejects(() => f.runtime.submit({ id: order.id, signedTransaction: f.signed }), /submission_restart_required/);
    assert.equal(f.counts.execute, 0);
  } finally { await f.cleanup(); }
});

test('unknown pre-execution exception uses only generic diagnostic code and no raw error', async () => {
  const f = fixture();
  try {
    const order = await f.ready();
    const pending = f.runtime.submit({ id: order.id, signedTransaction: f.signed });
    const hold = await f.pendingHold();
    const secret = 'https://example.invalid/?api-key=synthetic-secret-for-redaction-check';
    f.vars.failAuditType = 'execute_attempt';
    f.vars.auditError = `${secret} transaction=${f.signed}`;
    f.approve(hold);
    const result = await pending;
    assert.equal(result.status, 'refused');
    assert.equal(result.error, 'execution_precondition_failed');
    assert.equal(result.stage, 'audit_intent');
    assert.equal(result.signature, undefined);
    assert.equal(f.counts.execute, 0);
    const records = f.readRecords();
    assert.equal(records.some(record => record.type === 'execute_attempt'), false);
    const refusal = records.find(record => record.type === 'execution_refused');
    assert.equal(refusal.code, 'execution_precondition_failed');
    assert.equal(refusal.stage, 'audit_intent');
    const text = readFileSync(f.auditPath, 'utf8');
    assert.equal(text.includes(secret), false);
    assert.equal(text.includes(f.signed), false);
    assert.equal(JSON.stringify(f.runtime.state()).includes(secret), false);
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.equal(verifyChainText(text).ok, true);
    await assert.rejects(() => f.runtime.quote(), /submission_restart_required/);
    assert.equal(f.counts.execute, 0);
  } finally { await f.cleanup(); }
});

for (const response of ['timeout', 'mismatch', 'Failed']) {
  test(`fake POST ${response} retains candidate signature and forbids retry`, async () => {
    const f = fixture();
    try {
      f.vars.response = response;
      const order = await f.ready();
      const pending = f.runtime.submit({ id: order.id, signedTransaction: f.signed });
      f.approve(await f.pendingHold());
      const result = await pending;
      assert.equal(result.status, 'outcome-unknown');
      assert.equal(result.signature, validateSignedTransaction(f.unsigned, f.signed, f.wallet.address).signature);
      assert.equal(f.counts.execute, 1);
      const groups = collectSentTransactions(f.readRecords());
      assert.equal(groups.length, 1);
      assert.equal(groups[0].signature, result.signature);
      assert.equal(groups[0].link, 'ok');
      await assert.rejects(() => f.runtime.submit({ id: order.id, signedTransaction: f.signed }), /submission_restart_required/);
      await assert.rejects(() => f.runtime.quote(), /submission_restart_required/);
      assert.equal(f.counts.execute, 1);
    } finally { await f.cleanup(); }
  });
}

test('signed transaction echoed by fake RPC is removed from audit and public state', async () => {
  const f = fixture();
  try {
    const order = await f.ready();
    f.vars.echoSigned = true;
    const pending = f.runtime.submit({ id: order.id, signedTransaction: f.signed });
    f.approve(await f.pendingHold());
    await pending;
    assert.ok(!readFileSync(f.auditPath, 'utf8').includes(f.signed));
    assert.ok(!JSON.stringify(f.runtime.state()).includes(f.signed));
    assert.equal(verifyChainText(readFileSync(f.auditPath, 'utf8')).ok, true);
  } finally { await f.cleanup(); }
});

test('expired reviewed order cannot be signed and never reaches Gate or transport', async () => {
  const f = fixture();
  try {
    const order = await f.ready();
    f.vars.time += 90001;
    await assert.rejects(() => f.runtime.submit({ id: order.id, signedTransaction: f.signed }), /order_expired/);
    assert.equal(f.counts.execute, 0);
    assert.equal(f.holds.listPending().length, 0);
  } finally { await f.cleanup(); }
});

test('pause during an in-flight scripted RPC prevents the next RPC and order', async () => {
  const f = fixture();
  let release;
  try {
    // A second runtime uses a deferred read-only stub, never a network socket.
    const holds = new HoldQueue({ approver: f.approver.address });
    const runtime = createKeylessRuntime({ config: { ...baseConfig, approver: f.approver.address },
      rpc: { async call() { return new Promise(resolve => { release = resolve; }); } },
      transport: { async order() { assert.fail('pause must prevent fetching order'); }, async execute() { assert.fail('no execution'); } },
      audit: { append() {} }, holds, approvalUrl: 'http://127.0.0.1:8787',
      wallet: f.wallet.address, approver: f.approver.address });
    runtime.resume();
    const quote = runtime.quote();
    runtime.pause();
    release(MAINNET_GENESIS);
    await assert.rejects(() => quote, /request_cancelled/);
    await runtime.close();
    assert.equal(runtime.state().phase, 'closed');
  } finally { await f.cleanup(); }
});


// --- 2026-10-11 follow-up: 200 ms slots leave ~30 s of blockhash life ---------

async function until(predicate, label, timeoutMs = 3000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) assert.fail(`timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}
const blockhashOf = (base64Transaction) => decodeTransaction(Buffer.from(base64Transaction, 'base64')).recentBlockhash;
const countRpc = (f, method) => f.counts.rpc.filter(name => name === method).length;

test('refusal record names the guard, elapsed time and chain answer (2026-10-11 replay)', async () => {
  // Only this historical replay restores the historical 90 s / no-reserve window.
  const f = fixture({ orderLifetimeMs: 90000, executionReserveMs: 0, approvalTimeoutSec: 60 });
  try {
    const order = await f.ready();
    const quoteRecord = f.readRecords().find(record => record.type === 'public_order_review');
    assert.equal(quoteRecord.recentBlockhash, blockhashOf(f.unsigned));
    assert.equal(quoteRecord.receivedAt, new Date(f.vars.time).toISOString());
    assert.equal(quoteRecord.blockhashContextSlot, 123);
    const pending = f.runtime.submit({ id: order.id, signedTransaction: f.signed });
    const hold = await f.pendingHold();
    f.vars.time += 23300; // order -> approval gap observed on mainnet (seq 8 -> 12)
    f.vars.blockhashValid = false;
    f.approve(hold);
    const result = await pending;
    assert.deepEqual(result, { status: 'refused', error: 'blockhash_expired', stage: 'blockhash_freshness' });
    const refusal = f.readRecords().find(record => record.type === 'execution_refused');
    assert.deepEqual({ stage: refusal.stage, code: refusal.code, msSinceOrder: refusal.msSinceOrder,
      blockhashValid: refusal.blockhashValid, blockhashContextSlot: refusal.blockhashContextSlot },
    { stage: 'blockhash_freshness', code: 'blockhash_expired', msSinceOrder: 23300,
      blockhashValid: false, blockhashContextSlot: 123 });
    assert.equal(f.counts.execute, 0);
    assert.equal(verifyChainText(readFileSync(f.auditPath, 'utf8')).ok, true);
  } finally { await f.cleanup(); }
});

test('final RPC failure is recorded as rpc_unavailable, distinct from an expired blockhash', async () => {
  const f = fixture();
  try {
    const order = await f.ready();
    const pending = f.runtime.submit({ id: order.id, signedTransaction: f.signed });
    const hold = await f.pendingHold();
    f.vars.failRpc = 'isBlockhashValid';
    f.approve(hold);
    const result = await pending;
    assert.deepEqual(result, { status: 'refused', error: 'rpc_unavailable', stage: 'blockhash_freshness' });
    const refusal = f.readRecords().find(record => record.type === 'execution_refused');
    assert.equal(Object.hasOwn(refusal, 'blockhashValid'), false, 'no chain answer was received');
    assert.equal(f.counts.execute, 0);
  } finally { await f.cleanup(); }
});

test('blockhash watchdog cancels the pending Gate hold once the chain says the blockhash is gone', async () => {
  const f = fixture({ pollMs: 5, orderLifetimeMs: 90000, executionReserveMs: 0, approvalTimeoutSec: 60 });
  try {
    const order = await f.ready();
    const pending = f.runtime.submit({ id: order.id, signedTransaction: f.signed });
    const hold = await f.pendingHold();
    f.vars.time += 23300;
    f.vars.blockhashValid = false;
    const result = await pending;
    assert.deepEqual(result, { status: 'refused', error: 'blockhash_expired', stage: 'awaiting_approval' });
    assert.equal(f.counts.execute, 0);
    assert.equal(f.holds.listPending().length, 0);
    assert.throws(() => f.approve(hold), /hold already cancelled/);
    const records = f.readRecords();
    const expired = records.find(record => record.type === 'order_blockhash_expired');
    assert.equal(expired.phase, 'gate-approval-pending');
    assert.equal(expired.msSinceOrder, 23300);
    assert.equal(expired.recentBlockhash, blockhashOf(f.unsigned));
    assert.equal(expired.requestId, f.raw.requestId);
    assert.equal(expired.messageSha256, order.messageSha256);
    assert.equal(records.find(record => record.type === 'hold_cancelled').reason, 'blockhash expired');
    assert.ok(!records.some(record => ['hold_approved', 'execute_attempt'].includes(record.type)));
    const text = readFileSync(f.auditPath, 'utf8');
    assert.ok(!text.includes(f.signed));
    assert.equal(verifyChainText(text).ok, true);
    assert.equal(f.runtime.state().result.error, 'blockhash_expired');
    await assert.rejects(() => f.runtime.quote(), /submission_restart_required/);
    const polls = countRpc(f, 'isBlockhashValid');
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(countRpc(f, 'isBlockhashValid'), polls, 'watchdog stops after the decision');
  } finally { await f.cleanup(); }
});

test('blockhash watchdog expires an unsigned order before Phantom is asked to sign', async () => {
  const f = fixture({ pollMs: 5 });
  try {
    const order = await f.ready();
    f.vars.time += 12000;
    f.vars.blockhashValid = false;
    await until(() => f.runtime.state().order?.blockhash?.expiredAt, 'watchdog expiry');
    const state = f.runtime.state();
    assert.ok(Date.parse(state.order.blockhash.expiredAt) <= f.vars.time, 'page sees chain expiry independently from local cutoff');
    assert.equal(state.phase, 'awaiting-signature');
    await assert.rejects(() => f.runtime.submit({ id: order.id, signedTransaction: f.signed }), /blockhash_expired/);
    assert.equal(f.holds.listPending().length, 0);
    assert.equal(f.counts.execute, 0);
    const expired = f.readRecords().find(record => record.type === 'order_blockhash_expired');
    assert.equal(expired.phase, 'awaiting-signature');
    assert.equal(expired.msSinceOrder, 12000);
    assert.equal(expired.callId, null);
    // Only an explicit new quote replaces it; nothing is re-quoted automatically.
    assert.equal(f.counts.orders, 1);
    f.vars.blockhashValid = true;
    assert.notEqual((await f.runtime.quote()).id, order.id);
    assert.equal(f.counts.orders, 2);
  } finally { await f.cleanup(); }
});

test('blockhash watchdog ignores RPC trouble; only an explicit false expires the order', async () => {
  const f = fixture({ pollMs: 5 });
  try {
    const order = await f.ready();
    const pending = f.runtime.submit({ id: order.id, signedTransaction: f.signed });
    const hold = await f.pendingHold();
    f.vars.failRpc = 'isBlockhashValid';
    const before = countRpc(f, 'isBlockhashValid');
    await until(() => countRpc(f, 'isBlockhashValid') >= before + 3, 'watchdog polls');
    assert.equal(f.holds.listPending().length, 1, 'RPC errors never expire an order');
    f.vars.failRpc = null;
    f.approve(hold);
    const result = await pending;
    assert.equal(result.status, 'submitted');
    assert.equal(f.counts.execute, 1);
    assert.ok(!f.readRecords().some(record => record.type === 'order_blockhash_expired'));
    const polls = countRpc(f, 'isBlockhashValid');
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(countRpc(f, 'isBlockhashValid'), polls, 'watchdog stops once approved');
  } finally { await f.cleanup(); }
});

test('pause stops the blockhash watchdog and resume restarts it for the unsigned order', async () => {
  const f = fixture({ pollMs: 5 });
  try {
    await f.ready();
    await until(() => countRpc(f, 'isBlockhashValid') >= 3, 'watchdog polls');
    f.runtime.pause();
    const polls = countRpc(f, 'isBlockhashValid');
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(countRpc(f, 'isBlockhashValid'), polls);
    f.runtime.resume();
    f.vars.blockhashValid = false;
    await until(() => f.runtime.state().order?.blockhash?.expiredAt, 'watchdog expiry after resume');
    assert.equal(f.counts.execute, 0);
  } finally { await f.cleanup(); }
});

test('a hold opened after the watchdog saw the hash die is cancelled at birth', async () => {
  const f = fixture({ pollMs: 5 });
  try {
    const order = await f.ready();
    let release;
    f.vars.simGate = new Promise(resolve => { release = resolve; });
    const pending = f.runtime.submit({ id: order.id, signedTransaction: f.signed });
    await until(() => f.counts.simulations.length === 2, 'final Gate review in flight');
    f.vars.blockhashValid = false;
    await until(() => f.runtime.state().order?.blockhash?.expiredAt, 'watchdog expiry during review');
    f.vars.simGate = null;
    release();
    const result = await pending;
    assert.deepEqual(result, { status: 'refused', error: 'blockhash_expired', stage: 'awaiting_approval' });
    const records = f.readRecords();
    const created = records.find(record => record.type === 'hold_created');
    const cancelled = records.find(record => record.type === 'hold_cancelled');
    assert.ok(created && cancelled && cancelled.seq === created.seq + 1, 'cancelled immediately after creation');
    assert.equal(cancelled.reason, 'blockhash expired');
    assert.equal(f.holds.listPending().length, 0);
    assert.equal(f.counts.execute, 0);
  } finally { await f.cleanup(); }
});

for (const limit of [12000, 8000]) {
  test('late payment is rejected before any Gate hold at ' + limit + ' ms', async () => {
    const f = fixture({ manualTimers: true, maxPaymentAgeMs: limit, signStartLimitMs: limit - 3000 });
    try {
      const order = await f.ready();
      f.advance(limit + 1);
      await assert.rejects(f.runtime.submit({ id: order.id, signedTransaction: f.signed }), /payment_signature_too_late/);
      assert.equal(f.counts.simulations.length, 1, 'late payment never starts the final review');
      assert.equal(f.counts.execute, 0);
      assert.equal(f.readRecords().some(r => r.type === 'hold_created'), false);
      assert.equal(f.readRecords().some(r => r.type === 'execute_attempt'), false);
      assert.ok(f.readRecords().some(r => r.type === 'payment_signature_rejected'));
      assert.equal(f.runtime.state().canRequote, true);
      assert.equal(f.counts.orders, 1, 'never automatically refresh an order');
      await f.runtime.quote();
      assert.equal(f.counts.orders, 2, 'an explicit manual quote is allowed');
    } finally { await f.cleanup(); }
  });

  test('payment exactly at the configured arrival threshold is accepted at ' + limit + ' ms', async () => {
    const f = fixture({ manualTimers: true, maxPaymentAgeMs: limit, signStartLimitMs: limit - 3000 });
    try {
      const order = await f.ready();
      f.advance(limit);
      const pending = f.runtime.submit({ id: order.id, signedTransaction: f.signed });
      const hold = await f.pendingHold();
      assert.ok(Date.parse(hold.expiresAt) <= Date.parse(order.approvalDeadline));
      f.holds.reject(hold.id);
      await pending;
      assert.equal(f.counts.execute, 0);
    } finally { await f.cleanup(); }
  });
}

test('payment does not restart the absolute deadline and stalled RPC cannot keep approval open', async () => {
  const f = fixture({ manualTimers: true, pollMs: 5 });
  let release;
  try {
    const order = await f.ready();
    assert.equal(Date.parse(order.expiresAt) - Date.parse(order.receivedAt), 20000);
    assert.equal(Date.parse(order.approvalDeadline) - Date.parse(order.receivedAt), 18000);
    f.advance(11000);
    const pending = f.runtime.submit({ id: order.id, signedTransaction: f.signed });
    const hold = await f.pendingHold();
    assert.ok(Date.parse(hold.expiresAt) <= Date.parse(order.approvalDeadline));
    assert.ok(Date.parse(hold.expiresAt) - f.vars.time <= 7000);
    const pollsBeforeStall = countRpc(f, 'isBlockhashValid');
    f.vars.blockhashGate = new Promise(resolve => { release = resolve; });
    await until(() => countRpc(f, 'isBlockhashValid') > pollsBeforeStall,
      'watchdog has entered the stalled fake RPC');
    f.advance(7000);
    const result = await pending;
    assert.equal(result.error, 'approval_window_expired');
    assert.equal(f.holds.listPending().length, 0);
    assert.equal(f.counts.execute, 0);
    assert.ok(f.readRecords().some(r => r.type === 'order_window_expired'));
  } finally { release?.(); f.vars.blockhashGate = null; await f.cleanup(); }
});

test('synchronous audit time cannot consume the send reserve and still trigger POST', async () => {
  const f = fixture({ manualTimers: true });
  try {
    const order = await f.ready();
    const pending = f.runtime.submit({ id: order.id, signedTransaction: f.signed });
    const hold = await f.pendingHold();
    f.vars.time += 10000;
    f.vars.auditAdvanceMs = 9000;
    f.approve(hold);
    const result = await pending;
    assert.equal(result.error, 'approval_window_expired');
    assert.equal(result.stage, 'post_intent_execution_reserve');
    assert.equal(f.counts.execute, 0);
    assert.ok(f.readRecords().some(r => r.type === 'execute_attempt'));
    assert.equal(f.runtime.state().canRequote, false);
  } finally { await f.cleanup(); }
});

test('pause never extends a deadline and old timer callbacks cannot expire a replacement', async () => {
  const f = fixture({ manualTimers: true });
  try {
    const old = await f.ready();
    const oldCallback = f.timers[0].callback;
    f.runtime.pause();
    f.advance(1000);
    f.runtime.resume();
    assert.equal(f.runtime.state().order.approvalDeadline, old.approvalDeadline);
    const replacement = await f.runtime.quote();
    oldCallback();
    assert.notEqual(replacement.id, old.id);
    assert.equal(f.runtime.state().order.approvalWindowExpiredAt, null);
    f.runtime.pause();
    f.advance(18000);
    f.runtime.resume();
    assert.equal(f.runtime.state().order.approvalDeadline, replacement.approvalDeadline);
    assert.ok(f.runtime.state().order.approvalWindowExpiredAt);
    assert.equal(f.counts.execute, 0);
  } finally { await f.cleanup(); }
});
