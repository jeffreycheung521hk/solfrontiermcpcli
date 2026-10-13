import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { APP_JS } from '../scripts/hackathon/phantom/phantom-keyless-page.mjs';

const WALLET = 'J3rFAMrr2GDNhDg2x3Cn2K9iNKyrGh4WcqbmNG9xKaRj';
const APPROVER = '6N7UYBzKmdHYtUssw45QDbGd1No2xUVTFkkVwnovTd3M';
const NOW = Date.parse('2026-10-11T12:00:00.000Z');
const copy = (value) => JSON.parse(JSON.stringify(value));
const drain = async () => { await new Promise(setImmediate); await new Promise(setImmediate); };

async function page({ expiresAt = new Date(NOW + 90000).toISOString(), phase = 'awaiting-signature', paused = false, result = null, orderExtra = {} } = {}) {
  const nodes = new Map();
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, { disabled: true, hidden: true, textContent: '', listeners: {},
      addEventListener(type, fn) { this.listeners[type] = fn; }, removeAttribute() {},
      replaceChildren() {}, appendChild() {} });
    return nodes.get(id);
  };
  let now = NOW;
  let interval;
  let signed = 0;
  const requests = [];
  const publicKey = { toBase58: () => WALLET };
  const provider = { isPhantom: true, publicKey, on() {},
    async connect() { return { publicKey }; },
    async signTransaction() { signed++; throw new Error('No wallet signing is allowed in this offline test.'); } };
  const state = { wallet: WALLET, approver: APPROVER, paused, phase, result, approvalUrl: 'http://127.0.0.1:8787',
    order: { id: 'mock-order', inAmount: '1000000', outAmount: '110000', otherAmountThreshold: '109000',
      transaction: 'unsigned-test-placeholder', expiresAt,
      review: { messageSha256: 'a'.repeat(64), summaryLine: 'offline fixture', warnings: [] }, ...orderExtra } };
  const originalOrder = copy(state.order);
  class MockDate extends Date { static now() { return now; } }
  vm.runInNewContext(APP_JS, {
    document: { getElementById: node, createElement: () => ({ textContent: '' }) },
    location: { hash: '#session=' + 'b'.repeat(48) }, URL, URLSearchParams, AbortController, Date: MockDate,
    window: { phantom: { solana: provider }, addEventListener() {} },
    setTimeout: () => 1, clearTimeout() {}, setInterval: (fn) => { interval = fn; return 1; }, clearInterval() {},
    async fetch(path, options) {
      requests.push({ path, method: options.method, body: options.body });
      if (path === '/api/order') {
        state.order = { ...originalOrder, id: 'replacement-order', expiresAt: new Date(now + 90000).toISOString() };
        state.phase = 'awaiting-signature';
      }
      return { ok: true, async json() { return copy(state); } };
    },
  });
  await drain();
  const click = async (id) => { await node(id).listeners.click(); await drain(); };
  if (!paused && !result && ['awaiting-signature', 'quote-refused'].includes(phase)) await click('connect');
  return { node, state, requests, click, signed: () => signed,
    async advance(ms) { now += ms; await interval(); await drain(); } };
}

test('existing unsigned quote can be refreshed only by an explicit click', async () => {
  const p = await page();
  assert.equal(p.node('quote').disabled, false);
  assert.equal(p.node('quote').textContent, '重新取得 0.001 SOL → USDC 報價');
  assert.equal(p.node('sign').disabled, false);
  assert.equal(p.requests.filter(r => r.path === '/api/order').length, 0);
  await p.click('quote');
  assert.equal(p.state.order.id, 'replacement-order');
  assert.equal(p.requests.filter(r => r.path === '/api/order').length, 1);
  assert.equal(p.requests.find(r => r.path === '/api/order').body, '{}');
  assert.equal(p.signed(), 0);
});

test('local deadline disables signing and tells user to refresh, without autoquote', async () => {
  const p = await page();
  await p.advance(90000);
  assert.equal(p.node('sign').disabled, true);
  assert.equal(p.node('quote').disabled, false);
  assert.match(p.node('status').textContent, /已過期.*重新取得/);
  assert.equal(p.requests.filter(r => r.path === '/api/order').length, 0);
  // Invoke the handler directly to verify its guard as well as the disabled button.
  await p.click('sign');
  assert.equal(p.signed(), 0);
  assert.match(p.node('error').textContent, /已過期/);
  assert.equal(p.requests.filter(r => r.path === '/api/signature').length, 0);
});

test('invalid expiry also refuses signing', async () => {
  const p = await page({ expiresAt: 'invalid' });
  assert.equal(p.node('sign').disabled, true);
  await p.click('sign');
  assert.equal(p.signed(), 0);
  assert.equal(p.requests.filter(r => r.path === '/api/signature').length, 0);
});

test('pre-signature quote refusal allows an explicit new quote without retrying automatically', async () => {
  const p = await page({ phase: 'quote-refused' });
  p.state.order = null;
  await p.advance(0);
  assert.equal(p.node('quote').disabled, false);
  assert.equal(p.node('sign').disabled, true);
  assert.equal(p.requests.filter(r => r.method === 'POST').length, 0);
  await p.click('quote');
  assert.equal(p.requests.filter(r => r.path === '/api/order').length, 1);
  assert.equal(p.node('sign').disabled, false);
  assert.equal(p.requests.filter(r => r.path === '/api/signature').length, 0);
  assert.equal(p.signed(), 0);
});

for (const options of [{ paused: true }, { phase: 'gate-approval-pending' }, { phase: 'submitting' },
  { phase: 'outcome-unknown' }, { phase: 'refused', result: { status: 'refused' } }]) {
  test('paused/pending/result guard survives refresh availability: ' + JSON.stringify(options), async () => {
    const p = await page({ ...options, expiresAt: new Date(NOW - 1).toISOString() });
    assert.equal(p.node('quote').disabled, true);
    assert.equal(p.node('sign').disabled, true);
    assert.doesNotMatch(p.node('status').textContent, /已過期/);
    assert.equal(p.requests.filter(r => r.method === 'POST').length, 0);
    assert.equal(p.signed(), 0);
  });
}

test('elapsed clock counts from server receipt and flags the chain-confirmed expiry', async () => {
  const p = await page({ orderExtra: { receivedAt: new Date(NOW - 12000).toISOString(),
    blockhash: { checkedAt: null, expiredAt: null } } });
  assert.equal(p.node('clock').hidden, false);
  assert.match(p.node('clock').textContent, /報價後已過 12 秒/);
  assert.equal(p.node('sign').disabled, false);
  p.state.order.blockhash = { checkedAt: null, expiredAt: new Date(NOW + 1000).toISOString() };
  p.state.order.expiresAt = new Date(NOW + 1000).toISOString();
  await p.advance(2000);
  assert.match(p.node('clock').textContent, /交易有效期結束/);
  assert.equal(p.node('sign').disabled, true);
  assert.match(p.node('status').textContent, /已過期.*重新取得/);
  assert.equal(p.requests.filter(r => r.path === '/api/order').length, 0, 'no automatic re-quote');
});

test('blockhash refusal is explained in plain words and keeps code and stage', async () => {
  const p = await page({ phase: 'refused', result: { status: 'refused', error: 'blockhash_expired', stage: 'awaiting_approval' } });
  assert.equal(p.node('result').hidden, false);
  assert.match(p.node('result').textContent, /交易有效期（blockhash）已過/);
  assert.match(p.node('result').textContent, /blockhash_expired @ awaiting_approval/);
  assert.equal(p.node('clock').hidden, true);
  assert.equal(p.requests.filter(r => r.method === 'POST').length, 0);
});

test('unknown outcome shows the candidate signature to reconcile, never a retry', async () => {
  const signature = '5'.repeat(88);
  const p = await page({ phase: 'outcome-unknown', result: { status: 'outcome-unknown', signature,
    error: 'execution_response_unavailable_reconcile_before_retry' } });
  assert.match(p.node('result').textContent, /execution_response_unavailable_reconcile_before_retry/);
  assert.ok(p.node('result').textContent.includes(signature));
  assert.equal(p.node('sign').disabled, true);
  assert.equal(p.requests.filter(r => r.method === 'POST').length, 0);
});

test('both wallet actions share the absolute deadline instead of a new approval clock', async () => {
  const p = await page({ expiresAt: new Date(NOW + 20000).toISOString(),
    orderExtra: { receivedAt: new Date(NOW).toISOString(),
      approvalDeadline: new Date(NOW + 18000).toISOString(), executionReserveMs: 2000 } });
  assert.match(p.node('clock').textContent, /本機交易期限：剩約 20\.0 秒/);
  assert.match(p.node('clock').textContent, /已預留 2\.0 秒/);
  assert.doesNotMatch(p.node('clock').textContent, /有效期約 30 秒/);
  await p.advance(6000);
  p.state.phase = 'gate-approval-pending';
  await p.advance(0);
  assert.match(p.node('clock').textContent, /本機交易期限：剩約 14\.0 秒/);
  await p.advance(12000);
  assert.match(p.node('clock').textContent, /安全倒數已結束/);
  assert.equal(p.node('sign').disabled, true);
  assert.equal(p.requests.filter(r => r.method === 'POST' && r.path !== '/api/order').length, 0);
});

test('an approval cutoff before the nominal order expiry prevents a late wallet request', async () => {
  const p = await page({ expiresAt: new Date(NOW + 19000).toISOString(),
    orderExtra: { receivedAt: new Date(NOW - 17000).toISOString(),
      approvalDeadline: new Date(NOW - 1000).toISOString(), executionReserveMs: 3000 } });
  assert.equal(p.node('sign').disabled, true);
  await p.click('sign');
  assert.equal(p.signed(), 0);
  assert.equal(p.requests.filter(r => r.path === '/api/signature').length, 0);
});

test('common deadline refusal names the operation deadline without claiming chain expiry', async () => {
  const p = await page({ phase: 'refused', result: { status: 'refused',
    error: 'approval_window_expired', stage: 'awaiting_approval' } });
  assert.match(p.node('result').textContent, /共同安全倒數已結束/);
  assert.match(p.node('result').textContent, /approval_window_expired @ awaiting_approval/);
  assert.doesNotMatch(p.node('result').textContent, /鏈上已確認/);
  assert.equal(p.signed(), 0);
});

for (const cutoff of [9000, 5000]) {
  test('signing handler stops at the profile-specific start deadline ' + cutoff, async () => {
    const p = await page({ expiresAt: new Date(NOW + 20000).toISOString(),
      orderExtra: { receivedAt: new Date(NOW).toISOString(),
        approvalDeadline: new Date(NOW + 18000).toISOString(),
        signingDeadline: new Date(NOW + cutoff).toISOString(),
        paymentSubmissionDeadline: new Date(NOW + cutoff + 3000).toISOString(), executionReserveMs: 2000 } });
    await p.advance(cutoff - 1);
    assert.equal(p.node('sign').disabled, false);
    await p.advance(1);
    assert.equal(p.node('sign').disabled, true);
    assert.equal(p.node('quote').disabled, false);
    await p.click('sign');
    assert.equal(p.signed(), 0);
    assert.match(p.node('error').textContent, /開始付款簽署的時間已過/);
    assert.equal(p.requests.filter(r => r.method === 'POST').length, 0);
  });
}
