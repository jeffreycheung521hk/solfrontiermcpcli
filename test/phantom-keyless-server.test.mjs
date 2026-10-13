// Hermetic HTTP checks: only a fake runtime on a temporary loopback port.
import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { startLocalServer, prepareConfig, APPROVAL_TIMEOUT_SEC, BLOCKHASH_POLL_MS,
  ORDER_LIFETIME_MS, EXECUTION_RESERVE_MS, timingForProfile } from '../scripts/hackathon/phantom/phantom-keyless-server.mjs';
import { keypair, message, transaction, data, SYSTEM, randomAddress } from './solana-builders.mjs';

const browserBundle = process.env.SFGATE_BROWSER_WEB3_PATH;
test('local browser library preserves generated legacy and v0 transaction bytes', {
  skip: browserBundle ? false : 'Optional browser bridge not supplied; live proof used the recorded bundle',
}, () => {
  const context = vm.createContext({ Uint8Array, ArrayBuffer, DataView, TextEncoder, TextDecoder,
    setTimeout, clearTimeout, setInterval, clearInterval, console,
    fetch() { throw new Error('Network forbidden in browser library check'); } });
  const bundle = readFileSync(browserBundle, 'utf8');
  vm.runInContext(bundle, context, { timeout: 5000 });
  const payer = keypair();
  for (const version of ['legacy', 0]) {
    const bytes = transaction(message({ version, header: [1, 0, 1],
      keys: [payer.address, randomAddress(), SYSTEM],
      instructions: [{ p: 2, a: [0, 1], d: data.systemTransfer(1000000n) }] }), [null]);
    const tx = context.solanaWeb3.VersionedTransaction.deserialize(bytes);
    assert.equal(tx.message.staticAccountKeys[0].toBase58(), payer.address);
    assert.equal(tx.message.header.numRequiredSignatures, 1);
    assert.equal(Buffer.compare(Buffer.from(tx.serialize()), Buffer.from(bytes)), 0);
  }
});

function configForTest(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'phantom-public-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return prepareConfig({ directory });
}

test('public-only configuration starts paused without a wallet injection', t => {
  const { config } = configForTest(t);
  assert.equal(config.cluster, 'mainnet-beta');
  assert.equal(config.pettyCash, null);
  assert.equal(config.servers.jup.walletVar, null);
  assert.equal(config.tx.maxOutflow.SOL, 0.003);
  assert.equal(config.tx.approval, 'always');
  assert.equal(config.approval.method, 'wallet-signature');
});

test('loopback API enforces session, Host, Origin and fixed request shape', async t => {
  const counts = { quote: 0, submit: 0, pause: 0 };
  let canRequote = false;
  let submissionError = null;
  const runtime = {
    state: () => ({ paused: true, phase: 'paused', order: null, canRequote }),
    async quote() { counts.quote++; },
    async submit() { counts.submit++; if (submissionError) throw submissionError; return { status: 'fake' }; },
    pause() { counts.pause++; },
  };
  const sessionToken = 'fake-session-for-test-only';
  const local = await startLocalServer({ runtime, sessionToken, port: 0,
    web3Path: new URL('../scripts/hackathon/phantom/phantom-keyless-page.mjs', import.meta.url) });
  t.after(() => local.close());
  const port = local.server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  const call = (pathname, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: pathname, method, headers }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
  const auth = { 'x-sfgate-session': sessionToken };
  const post = { ...auth, origin, 'content-type': 'application/json' };
  const page = await call('/');
  assert.equal(page.status, 200);
  assert.equal(page.headers['x-frame-options'], 'DENY');
  assert.match(page.headers['content-security-policy'], /connect-src 'self'/);
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.equal((await call('/api/state')).status, 403);
  assert.equal((await call('/api/state', { headers: { ...auth, host: `attacker.invalid:${port}` } })).status, 403);
  assert.equal((await call('/api/state', { headers: { ...auth, origin: 'https://attacker.invalid' } })).status, 403);
  const state = await call('/api/state', { headers: auth });
  assert.equal(state.status, 200);
  assert.equal(JSON.parse(state.text).paused, true);
  assert.deepEqual(counts, { quote: 0, submit: 0, pause: 0 });
  assert.equal((await call('/api/order', { method: 'POST', headers: auth, body: '{}' })).status, 403);
  assert.equal((await call('/api/order', { method: 'POST', headers: { ...auth, origin, 'content-type': 'text/plain' }, body: '{}' })).status, 403);
  assert.equal((await call('/api/order', { method: 'POST', headers: post, body: '{"amount":"0.05"}' })).status, 400);
  assert.equal((await call('/api/order', { method: 'POST', headers: post, body: '[]' })).status, 400);
  assert.equal((await call('/api/signature', { method: 'POST', headers: post, body: '{"id":"fake","signedTransaction":"fake","rpc":"https://attacker.invalid"}' })).status, 400);
  assert.equal((await call('/api/resume', { method: 'POST', headers: post, body: '{}' })).status, 404);
  assert.deepEqual(counts, { quote: 0, submit: 0, pause: 0 });
  assert.equal((await call('/api/order', { method: 'POST', headers: post, body: '{}' })).status, 200);
  assert.equal((await call('/api/cancel', { method: 'POST', headers: post, body: '{}' })).status, 200);
  assert.deepEqual(counts, { quote: 1, submit: 0, pause: 1 });

  const signatureRequest = { method: 'POST', headers: post, body: '{"id":"fake","signedTransaction":"fake"}' };
  submissionError = new Error('payment_signature_too_late');
  canRequote = true;
  const late = await call('/api/signature', signatureRequest);
  assert.equal(late.status, 400);
  assert.deepEqual(JSON.parse(late.text), { error: '付款簽名送到時已超過時限，沒有建立 Gate 核准。請手動重新取得報價。',
    code: 'payment_signature_too_late', canRequote: true });
  canRequote = false;
  const locked = JSON.parse((await call('/api/signature', signatureRequest)).text);
  assert.equal(locked.canRequote, undefined, 'a possibly accepted signature must not unlock a new quote');
  canRequote = true;
  submissionError = new Error('provider credential or payload must remain private');
  const unknown = JSON.parse((await call('/api/signature', signatureRequest)).text);
  assert.equal(unknown.canRequote, undefined, 'only a known pre-accept refusal may unlock a quote');
  assert.doesNotMatch(unknown.error, /credential|payload/);
});

test('production approval maximum leaves a relay reserve inside the measured short order window', t => {
  const { config } = configForTest(t);
  assert.equal(ORDER_LIFETIME_MS, 20000);
  assert.equal(EXECUTION_RESERVE_MS, 2000);
  assert.equal(APPROVAL_TIMEOUT_SEC, 12);
  assert.ok(APPROVAL_TIMEOUT_SEC * 1000 + EXECUTION_RESERVE_MS < ORDER_LIFETIME_MS);
  assert.equal(config.approval.timeoutSec, APPROVAL_TIMEOUT_SEC);
  assert.ok(config.servers.jup.timeoutMs >= (config.approval.timeoutSec + 30) * 1000);
  assert.ok(BLOCKHASH_POLL_MS > 0 && BLOCKHASH_POLL_MS <= 2000);
});

test('two profiles and same Phantom select their fixed early payment budgets', () => {
  assert.deepEqual(timingForProfile(), { profileMode: 'two-profiles', maxPaymentAgeMs: 12000, signStartLimitMs: 9000 });
  assert.deepEqual(timingForProfile('same-profile'), { profileMode: 'same-profile', maxPaymentAgeMs: 8000, signStartLimitMs: 5000 });
  assert.throws(() => timingForProfile('unknown'));
});
