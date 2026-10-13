import test from 'node:test';
import assert from 'node:assert/strict';
import { sign } from 'node:crypto';
import { ledgerBalances, verifyCandidate, checkSignature, USDC, WSOL, MAINNET_GENESIS } from '../scripts/hackathon/phantom/verify-phantom-mainnet.mjs';
import { keypair, randomAddress, message, transaction, data, SYSTEM } from './solana-builders.mjs';
import { decodeTransaction, messageSha256 } from '../src/solana/tx.mjs';
import { encode } from '../src/solana/base58.mjs';
import { recordHash, GENESIS } from '../src/gate/audit-log.mjs';
import { buildApprovalMessage } from '../src/gate/holds.mjs';

const copy = (object) => JSON.parse(JSON.stringify(object));
function textOf(records) {
  let prev = GENESIS;
  return records.map((entry, index) => {
    const r = { v: 1, seq: index + 1, ts: '2026-10-11T00:00:00.000Z', prev, ...entry };
    const hash = recordHash(prev, r);
    prev = hash;
    return JSON.stringify({ ...r, hash });
  }).join('\n') + '\n';
}
function fixture({ nativeDelta = -2500000, wsolDelta = 0, received = 110000 } = {}) {
  const wallet = keypair();
  const approver = keypair();
  const other = randomAddress();
  const loaded = [randomAddress(), randomAddress(), randomAddress()];
  const readonly = [randomAddress()];
  const wire = transaction(message({ version: 0, header: [1, 0, 1], keys: [wallet.address, SYSTEM],
    instructions: [{ p: 1, a: [0, 2], d: data.systemTransfer(1000000) }],
    lookups: [{ key: randomAddress(), w: [0, 1, 2], r: [3] }] }), [wallet]);
  const decoded = decodeTransaction(wire);
  const signature = encode(decoded.signatures[0]);
  const hash = messageSha256(decoded);
  const token = (accountIndex, mint, owner, amount, decimals) => ({ accountIndex, mint, owner,
    uiTokenAmount: { amount: String(amount), decimals, uiAmount: null, uiAmountString: 'unused' } });
  const tx = { slot: 123456789, blockTime: 1791676800, transaction: [Buffer.from(wire).toString('base64'), 'base64'],
    meta: { err: null, fee: 5000, loadedAddresses: { writable: loaded, readonly },
      preBalances: [50000000, 1, 2039280, 2039280, 4039280, 1],
      postBalances: [50000000 + nativeDelta, 1, 2039280, 2039280, 4039280 + wsolDelta, 1],
      preTokenBalances: [token(2, USDC, wallet.address, 10, 6), token(3, USDC, other, 200000, 6),
        token(4, WSOL, wallet.address, 2000000, 9)],
      postTokenBalances: [token(2, USDC, wallet.address, 10 + received, 6), token(3, USDC, other, 900000, 6),
        token(4, WSOL, wallet.address, 2000000 + wsolDelta, 9)] } };
  const fields = { holdId: 'abcdef012345', callId: 'generated-call', messageSha256: hash };
  const held = { ...fields, cluster: 'mainnet-beta', summaryLine: 'generated mock swap',
    expiresAt: '2026-10-11T00:02:00.000Z' };
  held.approvalMessage = buildApprovalMessage({ id: held.holdId, ...held });
  const approvedSignature = encode(sign(null, Buffer.from(held.approvalMessage), approver.privateKey));
  const review = { messageSha256: hash, verdict: 'hold', sim: { ok: true, err: null }, violations: [] };
  const records = [
    { type: 'public_order_review', id: 'generated-order', requestId: 'generated-request', messageSha256: hash,
      inAmount: '1000000', otherAmountThreshold: '100000', review },
    { type: 'tx_review', callId: fields.callId, ...review },
    { type: 'hold_created', ...held },
    { type: 'hold_approved', ...fields, publicKey: approver.address, method: 'wallet-signature', signature: approvedSignature },
    { type: 'execute_attempt', callId: fields.callId, requestId: 'generated-request', messageSha256: hash, signature },
    { type: 'tool_result', callId: fields.callId, signature, isError: false },
  ];
  const calls = [];
  const state = { status: { confirmationStatus: 'finalized', err: null, slot: tx.slot }, tx, genesis: MAINNET_GENESIS };
  const rpc = { async call(method, params = []) {
    calls.push({ method, params });
    if (method === 'getGenesisHash') return state.genesis;
    if (method === 'getSignatureStatuses') return { value: [state.status] };
    if (method === 'getTransaction') return state.tx;
    throw new Error('unexpected request');
  } };
  return { wallet: wallet.address, approver: approver.address, signature, hash, tx, records, rpc, state, calls,
    verify() { return verifyCandidate({ signature, wallet: wallet.address, approver: approver.address,
      auditText: textOf(records), rpc }); } };
}

test('complete finalized proof binds approval, order minimum, ledger and owner balances', async () => {
  const f = fixture({ nativeDelta: -2500000, wsolDelta: -200000 });
  const r = await f.verify();
  assert.equal(r.status, 'VERIFIED');
  assert.equal(r.solOutflowLamports, '2700000');
  assert.equal(r.balances.nativeDeltaLamports, '-2500000');
  assert.equal(r.balances.ownerWsolDeltaRaw, '-200000');
  assert.equal(r.balances.usdcDeltaRaw, '110000');
  assert.deepEqual(r.audit.counts, { passed: 2, failed: 0, unverified: 0 });
  assert.deepEqual(f.calls.map((c) => c.method), ['getGenesisHash', 'getSignatureStatuses', 'getTransaction']);
  assert.deepEqual(f.calls.at(-1).params[1], { encoding: 'base64', maxSupportedTransactionVersion: 0, commitment: 'finalized' });
  assert.equal(JSON.stringify(r).includes(f.tx.transaction[0]), false);
});
test('new USDC account has zero prior balance and loaded index maps correctly', () => {
  const f = fixture();
  f.tx.meta.preTokenBalances = f.tx.meta.preTokenBalances.filter((r) => r.accountIndex !== 2);
  const r = ledgerBalances(f.tx, { wallet: f.wallet });
  assert.equal(r.usdcDelta, 110010n);
  assert.equal(r.public.tokenAccounts.find((a) => a.mint === USDC).account, f.tx.meta.loadedAddresses.writable[0]);
});
test('sums all owned USDC accounts while ignoring another owner', () => {
  const f = fixture();
  for (const rows of [f.tx.meta.preTokenBalances, f.tx.meta.postTokenBalances]) rows.find((r) => r.accountIndex === 3).owner = f.wallet;
  assert.equal(ledgerBalances(f.tx, { wallet: f.wallet }).usdcDelta, 810000n);
});
test('owner authority changes contribute negative owned balance', () => {
  const f = fixture();
  f.tx.meta.preTokenBalances.find((r) => r.accountIndex === 3).owner = f.wallet;
  assert.equal(ledgerBalances(f.tx, { wallet: f.wallet }).usdcDelta, -90000n);
});
test('closed WSOL account contributes full prior token balance', () => {
  const f = fixture({ nativeDelta: 2000000 });
  f.tx.meta.postTokenBalances = f.tx.meta.postTokenBalances.filter((r) => r.accountIndex !== 4);
  const b = ledgerBalances(f.tx, { wallet: f.wallet });
  assert.equal(b.nativeDelta, 2000000n);
  assert.equal(b.wsolDelta, -2000000n);
  assert.equal(b.solDelta, 0n);
});
test('cap includes spent WSOL and fee is not counted twice', async () => {
  assert.equal((await fixture({ nativeDelta: -1000000, wsolDelta: -2000000 }).verify()).status, 'VERIFIED');
  const r = await fixture({ nativeDelta: -1000001, wsolDelta: -2000000 }).verify();
  assert.equal(r.reason, 'ACTUAL_SOL_OUTFLOW_EXCEEDS_CAP');
});
test('received USDC below exact approved minimum fails', async () => {
  const r = await fixture({ received: 99999 }).verify();
  assert.equal(r.reason, 'ACTUAL_USDC_BELOW_APPROVED_MINIMUM');
});
test('nonfinalized status does not fetch transaction or retry', async () => {
  const f = fixture(); f.state.status.confirmationStatus = 'confirmed';
  assert.equal((await f.verify()).status, 'NOT_FINALIZED');
  assert.equal(f.calls.length, 2);
});
test('null finalized transaction is not treated as a success', async () => {
  const f = fixture(); f.state.tx = null;
  assert.equal((await f.verify()).status, 'NOT_FINALIZED');
  assert.equal(f.calls.length, 3);
});
test('wrong RPC network stops before status lookup', async () => {
  const f = fixture(); f.state.genesis = 'devnet';
  assert.equal((await f.verify()).reason, 'WRONG_RPC_NETWORK');
  assert.equal(f.calls.length, 1);
});
test('failed finalized status is never called successful', async () => {
  const f = fixture(); f.state.status.err = { InstructionError: [0, 'failure'] };
  assert.equal((await f.verify()).reason, 'FINALIZED_TRANSACTION_FAILED');
  assert.equal(f.calls.length, 2);
});
test('slot mismatch fails independently from matching message', async () => {
  const f = fixture(); f.state.status.slot += 1;
  assert.equal((await f.verify()).reason, 'FINALIZED_SLOT_MISMATCH');
});
test('valid but different signed ledger transaction cannot replace candidate', async () => {
  const f = fixture(); f.state.tx = fixture().tx;
  assert.equal((await f.verify()).reason, 'WALLET_NOT_A_LEDGER_SIGNER');
});
test('ledger signatures cannot be corrupted', async () => {
  const f = fixture(); const b = Buffer.from(f.tx.transaction[0], 'base64'); b[2] ^= 1;
  f.tx.transaction[0] = b.toString('base64');
  assert.equal((await f.verify()).reason, 'INVALID_LEDGER_SIGNATURES');
});
test('execute attempt alone cannot pass audit transaction verification', async () => {
  const f = fixture(); f.records.pop();
  assert.equal((await f.verify()).reason, 'AUDIT_MUST_HAVE_EXACTLY_ONE_TRANSACTION');
  assert.equal(f.calls.length, 0);
});
test('extra transaction claim cannot silently pass strict candidate audit', async () => {
  const f = fixture(); f.records.push({ type: 'tool_result', callId: 'other-call', signature: fixture().signature });
  assert.equal((await f.verify()).reason, 'AUDIT_MUST_HAVE_EXACTLY_ONE_TRANSACTION');
});
test('minimum bound must share request and exact message', async () => {
  const f = fixture(); f.records[0].requestId = 'another-request';
  assert.equal((await f.verify()).reason, 'ORDER_MINIMUM_LINK_FAILED');
});
test('recorded approver signature is independently checked', async () => {
  const f = fixture(); f.records[3].signature = fixture().signature;
  assert.equal((await f.verify()).reason, 'INVALID_APPROVER_SIGNATURE');
});
test('broken audit hash chain stops before network', async () => {
  const f = fixture(); const text = textOf(f.records).replace('generated-request', 'tampered-request');
  const r = await verifyCandidate({ signature: f.signature, wallet: f.wallet, approver: f.approver, auditText: text, rpc: f.rpc });
  assert.equal(r.reason, 'AUDIT_CHAIN_FAILED');
  assert.equal(f.calls.length, 0);
});
test('missing owner, duplicate indexes, and token decimals fail closed', () => {
  const f = fixture(); const a = copy(f.tx); delete a.meta.postTokenBalances[0].owner;
  assert.throws(() => ledgerBalances(a, { wallet: f.wallet }), /MISSING_TOKEN_OWNER_OR_MINT/);
  const b = copy(f.tx); b.meta.postTokenBalances.push(copy(b.meta.postTokenBalances[0]));
  assert.throws(() => ledgerBalances(b, { wallet: f.wallet }), /INVALID_TOKEN_ACCOUNT_INDEX/);
  const c = copy(f.tx); c.meta.postTokenBalances[0].uiTokenAmount.decimals = 9;
  assert.throws(() => ledgerBalances(c, { wallet: f.wallet }), /INCORRECT_USDC_DECIMALS/);
});
test('incomplete loaded addresses and unsafe lamports fail closed', () => {
  const f = fixture(); const a = copy(f.tx); a.meta.loadedAddresses.readonly = [];
  assert.throws(() => ledgerBalances(a, { wallet: f.wallet }), /LOADED_ADDRESS_COUNT_MISMATCH/);
  const b = copy(f.tx); b.meta.preBalances[0] = Number.MAX_SAFE_INTEGER + 1;
  assert.throws(() => ledgerBalances(b, { wallet: f.wallet }), /UNSAFE_NATIVE_BALANCE/);
});
test('RPC error messages containing credentials never leave public result', async () => {
  const f = fixture(); const secret = 'https://mainnet.helius-rpc.com/?api-key=fake-sensitive-example';
  f.rpc.call = async () => { throw new Error(secret); };
  const r = await f.verify();
  assert.equal(r.reason, 'VERIFICATION_UNAVAILABLE');
  assert.equal(JSON.stringify(r).includes(secret), false);
});
test('public signature input rejects malformed strings without echoing input', () => {
  assert.throws(() => checkSignature('invalid-credential-example'), /INVALID_CANDIDATE_SIGNATURE/);
});
