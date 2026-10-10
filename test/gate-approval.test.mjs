// T6: holds and wallet-signature approval (SPEC §5.6, I3, I7, I11).
//
// Keys are generated at runtime; nothing here touches a network or a real
// wallet. Every listener binds port 0 because test files run in parallel.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { spawn as childSpawn } from 'node:child_process';
import http from 'node:http';
import vm from 'node:vm';
import { startApprovalServer, CSP, jsonReplacer } from '../src/gate/approval-server.mjs';
import { PAGE_HTML, APP_JS } from '../src/gate/approval-page.mjs';
import { notifyHold, escapeAppleScript } from '../src/gate/notify.mjs';
import {
  HoldQueue,
  HoldError,
  buildApprovalMessage,
  verifyApproval,
} from '../src/gate/holds.mjs';

// --- helpers --------------------------------------------------------------

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function encodeBase58(bytes) {
  const digits = [];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = '';
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) out += '1';
  for (let i = digits.length - 1; i >= 0; i--) out += B58_ALPHABET[digits[i]];
  return out;
}

/** A fresh Ed25519 wallet: base58 pubkey plus a signer over UTF-8 text. */
function wallet() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  return {
    pubkey: encodeBase58(raw),
    sign: (text) => new Uint8Array(sign(null, Buffer.from(text, 'utf8'), privateKey)),
  };
}

const HASH = 'ab'.repeat(32);
const T0 = Date.parse('2026-10-10T03:12:45.123Z');

function review(overrides = {}) {
  return {
    messageSha256: HASH,
    summaryLine: '−0.0010 SOL · 1111… · 2 ix',
    version: 'legacy',
    programs: ['11111111111111111111111111111111'],
    instructions: [{ index: 0, programId: '11111111111111111111111111111111', program: 'system', kind: 'transfer', lamports: 1000000n }],
    outflow: { SOL: '0.001005' },
    inflow: {},
    verdict: 'hold',
    violations: [],
    warnings: [{ code: 'example_warning', path: 'tx', observed: 'x', bound: 'y', message: 'just a warning' }],
    ...overrides,
  };
}

/** A queue on a hand-driven clock whose timers only fire when the test says so. */
function manualQueue({ approver = null, ids = ['0123456789ab', 'bcdef0123456', 'aaaaaaaaaaaa', 'bbbbbbbbbbbb'] } = {}) {
  let now = T0;
  const timers = new Set();
  const queue = new HoldQueue({
    approver,
    now: () => now,
    newId: () => ids.shift(),
    setTimer: (fn) => {
      const t = { fn };
      timers.add(t);
      return t;
    },
    clearTimer: (t) => timers.delete(t),
  });
  return {
    queue,
    advance: (ms) => {
      now += ms;
    },
    fireTimers: () => {
      for (const t of [...timers]) {
        timers.delete(t);
        t.fn();
      }
    },
    timerCount: () => timers.size,
  };
}

async function settledWithin(promise, ms = 200) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve('__pending__'), ms))]);
}

// --- approval message -----------------------------------------------------

describe('approval message', () => {
  test('is byte-exact: six lines, \\n-joined, no trailing newline', () => {
    const { queue } = manualQueue();
    const hold = queue.add({ kind: 'tool-arg', tool: 'wallet.sign_and_send', review: review(), cluster: 'devnet', timeoutSec: 40 });
    const expected =
      'SolFrontier Gate approval\n' +
      'hold: 0123456789ab\n' +
      'cluster: devnet\n' +
      `tx-message-sha256: ${HASH}\n` +
      'summary: −0.0010 SOL · 1111… · 2 ix\n' +
      'expires: 2026-10-10T03:13:25.123Z';
    assert.equal(hold.approvalMessage, expected);
    assert.equal(
      Buffer.from(hold.approvalMessage, 'utf8').toString('hex'),
      Buffer.from(expected, 'utf8').toString('hex'),
    );
    assert.equal(hold.expiresAt, '2026-10-10T03:13:25.123Z');
    assert.equal(hold.createdAt, '2026-10-10T03:12:45.123Z');
    assert.equal(hold.status, 'pending');
    assert.equal(hold.id, '0123456789ab');
  });

  test('is generated once: later changes to the review do not change it', () => {
    const { queue } = manualQueue();
    const r = review();
    const hold = queue.add({ kind: 'rpc-send', review: r, cluster: 'devnet', timeoutSec: 40 });
    r.summaryLine = 'something else entirely';
    r.messageSha256 = 'cd'.repeat(32);
    assert.equal(queue.get(hold.id).approvalMessage, hold.approvalMessage);
  });

  test('review text cannot inject extra lines into the signed message', () => {
    const msg = buildApprovalMessage({
      id: '0123456789ab',
      cluster: 'devnet',
      messageSha256: HASH,
      summaryLine: '0.001 SOL\nexpires: 2099-01-01T00:00:00.000Z\r\u2028x',
      expiresAt: '2026-10-10T03:13:25.123Z',
    });
    const lines = msg.split('\n');
    assert.equal(lines.length, 6);
    assert.equal(lines[5], 'expires: 2026-10-10T03:13:25.123Z');
    assert.ok(!/[\r\u2028\u2029]/.test(msg));
  });

  test('a malformed hash, cluster or id refuses to build a hold', () => {
    const { queue } = manualQueue();
    assert.throws(() => queue.add({ kind: 'tool-arg', review: review({ messageSha256: 'xyz' }), cluster: 'devnet', timeoutSec: 40 }));
    assert.throws(() => queue.add({ kind: 'tool-arg', review: review(), cluster: 'testnet\nfoo', timeoutSec: 40 }));
    assert.throws(() => queue.add({ kind: 'nope', review: review(), cluster: 'devnet', timeoutSec: 40 }));
    assert.throws(() => queue.add({ kind: 'tool-arg', review: review(), cluster: 'devnet', timeoutSec: 0 }));
    assert.throws(() => queue.add({ kind: 'tool-arg', review: review(), cluster: 'devnet', timeoutSec: 61 }));
    const bad = new HoldQueue({ newId: () => 'NOT-HEX' });
    assert.throws(() => bad.add({ kind: 'tool-arg', review: review(), cluster: 'devnet', timeoutSec: 40 }));
  });

  test('default ids are 12 random hex characters', () => {
    const queue = new HoldQueue();
    const a = queue.add({ kind: 'tool-arg', review: review(), cluster: 'devnet', timeoutSec: 40 });
    const b = queue.add({ kind: 'tool-arg', review: review(), cluster: 'devnet', timeoutSec: 40 });
    assert.match(a.id, /^[0-9a-f]{12}$/);
    assert.notEqual(a.id, b.id);
    queue.close();
  });
});

// --- verifyApproval -------------------------------------------------------

describe('verifyApproval', () => {
  const approver = wallet();
  const message = 'SolFrontier Gate approval\nhold: 0123456789ab';

  test('accepts the approver signing the exact message', () => {
    assert.equal(verifyApproval({ message, publicKey: approver.pubkey, signature: approver.sign(message), approver: approver.pubkey }), true);
  });

  test('rejects another key, a tampered message and a truncated signature', () => {
    const other = wallet();
    assert.equal(verifyApproval({ message, publicKey: other.pubkey, signature: other.sign(message), approver: approver.pubkey }), false);
    // Claiming to be the approver with someone else's signature.
    assert.equal(verifyApproval({ message, publicKey: approver.pubkey, signature: other.sign(message), approver: approver.pubkey }), false);
    assert.equal(verifyApproval({ message: `${message} `, publicKey: approver.pubkey, signature: approver.sign(message), approver: approver.pubkey }), false);
    assert.equal(verifyApproval({ message, publicKey: approver.pubkey, signature: approver.sign(message).slice(0, 63), approver: approver.pubkey }), false);
  });

  test('never throws on garbage', () => {
    const junk = [undefined, null, 0, '', 'not base58 0OIl', {}, [], new Uint8Array(64), Buffer.alloc(64), 'x'.repeat(10000)];
    for (const a of junk) {
      for (const b of junk) {
        assert.equal(verifyApproval({ message: a, publicKey: b, signature: a, approver: b }), false);
      }
    }
    assert.equal(verifyApproval(), false);
    assert.equal(verifyApproval({ message, publicKey: '1'.repeat(32), signature: new Uint8Array(64), approver: '1'.repeat(32) }), false);
  });
});

// --- HoldQueue ------------------------------------------------------------

describe('HoldQueue', () => {
  test('approver signature approves and resolves waitFor with the approval', async () => {
    const approver = wallet();
    const { queue } = manualQueue({ approver: approver.pubkey });
    const hold = queue.add({ kind: 'tool-arg', tool: 'wallet.sign_and_send', review: review(), cluster: 'mainnet-beta', timeoutSec: 40 });
    const waiting = queue.waitFor(hold.id);
    const signature = approver.sign(hold.approvalMessage);
    const approved = queue.approve(hold.id, { publicKey: approver.pubkey, signature, method: 'wallet-signature' });
    assert.equal(approved.status, 'approved');
    const outcome = await waiting;
    assert.equal(outcome.status, 'approved');
    assert.deepEqual(outcome.approval, { publicKey: approver.pubkey, signature, method: 'wallet-signature' });
    assert.deepEqual(queue.listPending(), []);
  });

  test('a bad signature throws and leaves the hold pending', () => {
    const approver = wallet();
    const other = wallet();
    const { queue } = manualQueue({ approver: approver.pubkey });
    const hold = queue.add({ kind: 'tool-arg', review: review(), cluster: 'devnet', timeoutSec: 40 });
    const attempts = [
      { publicKey: other.pubkey, signature: other.sign(hold.approvalMessage) },
      { publicKey: approver.pubkey, signature: approver.sign(`${hold.approvalMessage}x`) },
      { publicKey: approver.pubkey, signature: approver.sign(hold.approvalMessage).slice(0, 32) },
      {},
    ];
    for (const attempt of attempts) {
      assert.throws(() => queue.approve(hold.id, attempt), (err) => err instanceof HoldError && err.status === 400);
      assert.equal(queue.get(hold.id).status, 'pending');
    }
  });

  test('a signature for one hold does not approve another', () => {
    const approver = wallet();
    const { queue } = manualQueue({ approver: approver.pubkey });
    const a = queue.add({ kind: 'tool-arg', review: review(), cluster: 'devnet', timeoutSec: 40 });
    const b = queue.add({ kind: 'tool-arg', review: review(), cluster: 'devnet', timeoutSec: 40 });
    assert.throws(() => queue.approve(b.id, { publicKey: approver.pubkey, signature: approver.sign(a.approvalMessage) }), { code: 'bad_signature' });
    assert.equal(queue.get(b.id).status, 'pending');
  });

  test('no approver configured: no wallet approval succeeds', () => {
    const someone = wallet();
    const { queue } = manualQueue();
    const hold = queue.add({ kind: 'tool-arg', review: review(), cluster: 'devnet', timeoutSec: 40 });
    assert.throws(() => queue.approve(hold.id, { publicKey: someone.pubkey, signature: someone.sign(hold.approvalMessage) }), { code: 'approval_unavailable' });
    assert.equal(queue.get(hold.id).status, 'pending');
  });

  test('double approve ⇒ already_decided (409)', () => {
    const approver = wallet();
    const { queue } = manualQueue({ approver: approver.pubkey });
    const hold = queue.add({ kind: 'tool-arg', review: review(), cluster: 'devnet', timeoutSec: 40 });
    const signature = approver.sign(hold.approvalMessage);
    queue.approve(hold.id, { publicKey: approver.pubkey, signature });
    assert.throws(() => queue.approve(hold.id, { publicKey: approver.pubkey, signature }), (err) => err.code === 'already_decided' && err.status === 409);
  });

  test('approve after expiry ⇒ expired (410); waitFor resolved expired', async () => {
    const approver = wallet();
    const { queue, advance } = manualQueue({ approver: approver.pubkey });
    const hold = queue.add({ kind: 'rpc-send', review: review(), cluster: 'devnet', timeoutSec: 40 });
    const waiting = queue.waitFor(hold.id);
    advance(40_000);
    assert.throws(
      () => queue.approve(hold.id, { publicKey: approver.pubkey, signature: approver.sign(hold.approvalMessage) }),
      (err) => err.code === 'expired' && err.status === 410,
    );
    assert.deepEqual(await waiting, { status: 'expired' });
    assert.equal(queue.get(hold.id).status, 'expired');
    assert.deepEqual(await queue.waitFor(hold.id), { status: 'expired' });
  });

  test('expiry is noticed on access, one millisecond before is still pending', () => {
    const { queue, advance } = manualQueue();
    const hold = queue.add({ kind: 'rpc-send', review: review(), cluster: 'devnet', timeoutSec: 40 });
    advance(39_999);
    assert.equal(queue.listPending().length, 1);
    advance(1);
    assert.equal(queue.listPending().length, 0);
    assert.equal(queue.get(hold.id).status, 'expired');
  });

  test('the timer expires a hold nobody is looking at', async () => {
    const { queue, advance, fireTimers, timerCount } = manualQueue();
    const hold = queue.add({ kind: 'rpc-send', review: review(), cluster: 'devnet', timeoutSec: 40 });
    const waiting = queue.waitFor(hold.id);
    assert.equal(timerCount(), 1);
    // A timer that fires early re-arms instead of expiring the hold.
    advance(10_000);
    fireTimers();
    assert.equal(timerCount(), 1);
    assert.equal(await settledWithin(waiting, 20), '__pending__');
    advance(30_000);
    fireTimers();
    assert.deepEqual(await waiting, { status: 'expired' });
    assert.equal(timerCount(), 0);
  });

  test('real timers: a short hold expires on its own', async () => {
    const queue = new HoldQueue();
    const hold = queue.add({ kind: 'rpc-send', review: review(), cluster: 'devnet', timeoutSec: 0.05 });
    assert.deepEqual(await settledWithin(queue.waitFor(hold.id), 2000), { status: 'expired' });
  });

  test('reject resolves waiters with the reason', async () => {
    const { queue } = manualQueue();
    const hold = queue.add({ kind: 'tool-arg', review: review(), cluster: 'devnet', timeoutSec: 40 });
    const waiting = queue.waitFor(hold.id);
    queue.reject(hold.id, 'not today');
    assert.deepEqual(await waiting, { status: 'rejected', reason: 'not today' });
    assert.throws(() => queue.reject(hold.id, 'again'), { code: 'already_decided' });
  });

  test('cancel resolves waiters with the reason; approval after cancel ⇒ 409', async () => {
    const approver = wallet();
    const { queue } = manualQueue({ approver: approver.pubkey });
    const hold = queue.add({ kind: 'tool-arg', review: review(), cluster: 'devnet', timeoutSec: 40 });
    const waiting = queue.waitFor(hold.id);
    queue.cancel(hold.id, 'host cancelled request');
    assert.deepEqual(await waiting, { status: 'cancelled', reason: 'host cancelled request' });
    assert.throws(() => queue.approve(hold.id, { publicKey: approver.pubkey, signature: approver.sign(hold.approvalMessage) }), { status: 409 });
  });

  test('cancelWhere cancels only the matching pending holds', async () => {
    const { queue } = manualQueue();
    const a = queue.add({ kind: 'rpc-send', review: review(), cluster: 'devnet', timeoutSec: 40, parentIds: ['call-1', 'call-2'] });
    const b = queue.add({ kind: 'tool-arg', review: review(), cluster: 'devnet', timeoutSec: 40, parentIds: ['call-3'] });
    const waitA = queue.waitFor(a.id);
    const cancelled = queue.cancelWhere((h) => h.parentIds.includes('call-2'), 'host cancelled call-2');
    assert.deepEqual(cancelled.map((h) => h.id), [a.id]);
    assert.deepEqual(await waitA, { status: 'cancelled', reason: 'host cancelled call-2' });
    assert.equal(queue.get(b.id).status, 'pending');
  });

  test('a throwing predicate cancels (fail closed)', () => {
    const { queue } = manualQueue();
    const a = queue.add({ kind: 'rpc-send', review: review(), cluster: 'devnet', timeoutSec: 40 });
    queue.cancelWhere(() => {
      throw new Error('boom');
    }, 'predicate failed');
    assert.equal(queue.get(a.id).status, 'cancelled');
  });

  test('unknown ids: get → null, approve/reject → 404, waitFor rejects', async () => {
    const { queue } = manualQueue();
    assert.equal(queue.get('ffffffffffff'), null);
    assert.throws(() => queue.approve('ffffffffffff', {}), { status: 404 });
    assert.throws(() => queue.reject('ffffffffffff'), { status: 404 });
    await assert.rejects(queue.waitFor('ffffffffffff'), { code: 'not_found' });
  });

  test('local-button approval: devnet only, recorded as insecure-local-button', async () => {
    const { queue } = manualQueue();
    const dev = queue.add({ kind: 'tool-arg', review: review(), cluster: 'devnet', timeoutSec: 40 });
    const main = queue.add({ kind: 'tool-arg', review: review(), cluster: 'mainnet-beta', timeoutSec: 40 });
    const waiting = queue.waitFor(dev.id);
    queue.approve(dev.id, { method: 'local-button' });
    assert.deepEqual(await waiting, { status: 'approved', approval: { publicKey: null, signature: null, method: 'insecure-local-button' } });
    assert.throws(() => queue.approve(main.id, { method: 'local-button' }), { code: 'method_not_allowed' });
    assert.throws(() => queue.approve(main.id, { method: 'insecure-local-button' }), { code: 'method_not_allowed' });
    assert.throws(() => queue.approve(main.id, { method: 'telepathy' }), { code: 'bad_request' });
    assert.equal(queue.get(main.id).status, 'pending');
  });

  test('snapshots cannot change the queue', () => {
    const { queue } = manualQueue();
    const hold = queue.add({ kind: 'tool-arg', review: review(), cluster: 'devnet', timeoutSec: 40, parentIds: ['c1'] });
    hold.status = 'approved';
    hold.parentIds.push('c2');
    assert.equal(queue.get(hold.id).status, 'pending');
    assert.deepEqual(queue.get(hold.id).parentIds, ['c1']);
  });

  test('close cancels everything pending', async () => {
    const { queue, timerCount } = manualQueue();
    const hold = queue.add({ kind: 'tool-arg', review: review(), cluster: 'devnet', timeoutSec: 40 });
    const waiting = queue.waitFor(hold.id);
    queue.close();
    assert.deepEqual(await waiting, { status: 'cancelled', reason: 'gate stopping' });
    assert.equal(timerCount(), 0);
  });
});

// --- approval server ------------------------------------------------------

/** Raw HTTP so the test controls Host and Origin exactly (fetch would not let it). */
function request(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path, headers: { host: `127.0.0.1:${port}`, connection: 'close', ...headers } },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          text += chunk;
        });
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      },
    );
    req.on('error', reject);
    req.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
  });
}

function post(port, path, body, headers = {}) {
  return request(port, { method: 'POST', path, body, headers: { 'content-type': 'application/json', ...headers } });
}

const b64 = (bytes) => Buffer.from(bytes).toString('base64');

async function withServer(options, fn) {
  const approver = wallet();
  const ctl = manualQueue({ approver: approver.pubkey });
  const lines = [];
  const server = await startApprovalServer({
    holds: ctl.queue,
    approver: approver.pubkey,
    cluster: 'devnet',
    port: 0,
    logger: (line) => lines.push(line),
    ...options,
  });
  try {
    await fn({ ...ctl, approver, server, port: server.port, lines });
  } finally {
    await server.close();
    ctl.queue.close();
  }
}

describe('approval server', () => {
  test('binds 127.0.0.1 and serves the page with the CSP header', async () => {
    await withServer({}, async ({ server, port }) => {
      assert.equal(server.url, `http://127.0.0.1:${port}`);
      const page = await request(port, { path: '/' });
      assert.equal(page.status, 200);
      assert.match(page.headers['content-type'], /^text\/html/);
      assert.equal(
        page.headers['content-security-policy'],
        "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; " +
          "img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      );
      assert.equal(page.headers['content-security-policy'], CSP);
      assert.equal(page.text, PAGE_HTML);
      const app = await request(port, { path: '/app.js' });
      assert.equal(app.status, 200);
      assert.match(app.headers['content-type'], /^text\/javascript/);
      assert.equal(app.text, APP_JS);
      assert.equal(app.headers['content-security-policy'], CSP);
    });
  });

  test('lists pending holds with their approval message; BigInt becomes a string', async () => {
    await withServer({}, async ({ queue, port, approver }) => {
      const hold = queue.add({ kind: 'tool-arg', tool: 'wallet.sign_and_send', review: review(), cluster: 'devnet', timeoutSec: 40 });
      const list = await request(port, { path: '/api/holds' });
      assert.equal(list.status, 200);
      assert.equal(list.json.approver, approver.pubkey);
      assert.equal(list.json.method, 'wallet-signature');
      assert.equal(list.json.cluster, 'devnet');
      assert.equal(list.json.now, '2026-10-10T03:12:45.123Z');
      assert.equal(list.json.holds.length, 1);
      const view = list.json.holds[0];
      assert.equal(view.id, hold.id);
      assert.equal(view.approvalMessage, hold.approvalMessage);
      assert.equal(view.summaryLine, hold.review.summaryLine);
      assert.equal(view.messageSha256, HASH);
      assert.equal(view.instructions[0].lamports, '1000000');
      assert.equal(view.parentIds, undefined);
      const one = await request(port, { path: `/api/holds/${hold.id}` });
      assert.equal(one.status, 200);
      assert.equal(one.json.hold.status, 'pending');
    });
  });

  test('jsonReplacer turns BigInt into decimal strings', () => {
    assert.equal(JSON.stringify({ a: 2n ** 70n, b: [1n] }, jsonReplacer), '{"a":"1180591620717411303424","b":["1"]}');
  });

  test('the runtime approver signs the message ⇒ 200; waitFor resolves approved', async () => {
    await withServer({}, async ({ queue, port, approver, lines }) => {
      const hold = queue.add({ kind: 'tool-arg', review: review(), cluster: 'devnet', timeoutSec: 40 });
      const waiting = queue.waitFor(hold.id);
      const signature = approver.sign(hold.approvalMessage);
      const res = await post(port, `/api/holds/${hold.id}/approve`, { publicKey: approver.pubkey, signature: b64(signature) });
      assert.equal(res.status, 200, res.text);
      assert.equal(res.json.hold.status, 'approved');
      assert.equal(res.json.hold.approvalMethod, 'wallet-signature');
      const outcome = await waiting;
      assert.equal(outcome.status, 'approved');
      assert.deepEqual(outcome.approval, { publicKey: approver.pubkey, signature, method: 'wallet-signature' });
      assert.ok(lines.some((l) => l.includes(`hold ${hold.id} approved (wallet-signature)`)));
      assert.ok(!lines.join('\n').includes(b64(signature)), 'signatures are not logged');
    });
  });

  test('wrong key, tampered message, truncated signature ⇒ 400 and still pending', async () => {
    await withServer({}, async ({ queue, port, approver }) => {
      const hold = queue.add({ kind: 'tool-arg', review: review(), cluster: 'devnet', timeoutSec: 40 });
      const other = wallet();
      const good = approver.sign(hold.approvalMessage);
      const attempts = {
        'wrong key': { publicKey: other.pubkey, signature: b64(other.sign(hold.approvalMessage)) },
        'wrong key claiming to be the approver': { publicKey: approver.pubkey, signature: b64(other.sign(hold.approvalMessage)) },
        'tampered message': { publicKey: approver.pubkey, signature: b64(approver.sign(hold.approvalMessage.replace('devnet', 'mainnet-beta'))) },
        'truncated signature': { publicKey: approver.pubkey, signature: b64(good.slice(0, 63)) },
        'empty signature': { publicKey: approver.pubkey, signature: '' },
        'signature not base64': { publicKey: approver.pubkey, signature: '!!!' },
        'no public key': { signature: b64(good) },
      };
      for (const [name, body] of Object.entries(attempts)) {
        const res = await post(port, `/api/holds/${hold.id}/approve`, body);
        assert.equal(res.status, 400, `${name}: ${res.text}`);
        assert.equal(queue.get(hold.id).status, 'pending', name);
      }
      // ...and the genuine signature still works afterwards.
      const ok = await post(port, `/api/holds/${hold.id}/approve`, { publicKey: approver.pubkey, signature: b64(good) });
      assert.equal(ok.status, 200);
    });
  });

  test('double approve ⇒ 409', async () => {
    await withServer({}, async ({ queue, port, approver }) => {
      const hold = queue.add({ kind: 'tool-arg', review: review(), cluster: 'devnet', timeoutSec: 40 });
      const body = { publicKey: approver.pubkey, signature: b64(approver.sign(hold.approvalMessage)) };
      assert.equal((await post(port, `/api/holds/${hold.id}/approve`, body)).status, 200);
      const again = await post(port, `/api/holds/${hold.id}/approve`, body);
      assert.equal(again.status, 409);
      assert.equal(again.json.error, 'already_decided');
    });
  });

  test('approve after expiry ⇒ 410 and waitFor resolved expired', async () => {
    await withServer({}, async ({ queue, port, approver, advance }) => {
      const hold = queue.add({ kind: 'rpc-send', review: review(), cluster: 'devnet', timeoutSec: 40 });
      const waiting = queue.waitFor(hold.id);
      advance(40_001);
      const res = await post(port, `/api/holds/${hold.id}/approve`, { publicKey: approver.pubkey, signature: b64(approver.sign(hold.approvalMessage)) });
      assert.equal(res.status, 410);
      assert.deepEqual(await waiting, { status: 'expired' });
      assert.equal((await post(port, `/api/holds/${hold.id}/reject`, {})).status, 410);
      assert.deepEqual((await request(port, { path: '/api/holds' })).json.holds, []);
    });
  });

  test('unknown hold ⇒ 404', async () => {
    await withServer({}, async ({ port, approver }) => {
      assert.equal((await request(port, { path: '/api/holds/ffffffffffff' })).status, 404);
      assert.equal((await post(port, '/api/holds/ffffffffffff/approve', { publicKey: approver.pubkey, signature: b64(new Uint8Array(64)) })).status, 404);
      assert.equal((await post(port, '/api/holds/ffffffffffff/reject', {})).status, 404);
      assert.equal((await request(port, { path: '/nope' })).status, 404);
    });
  });

  test('reject resolves the waiter; reject is allowed without a signature', async () => {
    await withServer({}, async ({ queue, port }) => {
      const hold = queue.add({ kind: 'tool-arg', review: review(), cluster: 'devnet', timeoutSec: 40 });
      const waiting = queue.waitFor(hold.id);
      const res = await post(port, `/api/holds/${hold.id}/reject`, { reason: 'looks wrong' });
      assert.equal(res.status, 200);
      assert.deepEqual(await waiting, { status: 'rejected', reason: 'looks wrong' });
      assert.equal((await post(port, `/api/holds/${hold.id}/reject`, {})).status, 409);
    });
  });

  test('a cancelled hold cannot be approved over HTTP (409)', async () => {
    await withServer({}, async ({ queue, port, approver }) => {
      const hold = queue.add({ kind: 'tool-arg', review: review(), cluster: 'devnet', timeoutSec: 40, parentIds: ['call-9'] });
      queue.cancelWhere((h) => h.parentIds.includes('call-9'), 'host cancelled');
      const res = await post(port, `/api/holds/${hold.id}/approve`, { publicKey: approver.pubkey, signature: b64(approver.sign(hold.approvalMessage)) });
      assert.equal(res.status, 409);
    });
  });

  test('wrong Host ⇒ 403 (DNS rebinding)', async () => {
    await withServer({}, async ({ queue, port }) => {
      const hold = queue.add({ kind: 'tool-arg', review: review(), cluster: 'devnet', timeoutSec: 40 });
      for (const host of ['evil.example', `evil.example:${port}`, `127.0.0.1:${port + 1}`, '127.0.0.1', `[::1]:${port}`, `127.0.0.1:${port}.evil.example`]) {
        const res = await request(port, { path: '/api/holds', headers: { host } });
        assert.equal(res.status, 403, host);
      }
      const rejectAttempt = await post(port, `/api/holds/${hold.id}/reject`, {}, { host: 'evil.example' });
      assert.equal(rejectAttempt.status, 403);
      assert.equal(queue.get(hold.id).status, 'pending');
      assert.equal((await request(port, { path: '/', headers: { host: `localhost:${port}` } })).status, 200);
    });
  });

  test('foreign Origin ⇒ 403; own origin is fine', async () => {
    await withServer({}, async ({ queue, port, approver }) => {
      const hold = queue.add({ kind: 'tool-arg', review: review(), cluster: 'devnet', timeoutSec: 40 });
      const body = { publicKey: approver.pubkey, signature: b64(approver.sign(hold.approvalMessage)) };
      for (const origin of ['http://evil.example', 'null', `http://localhost:${port}`, `https://127.0.0.1:${port}`, `http://127.0.0.1:${port + 1}`]) {
        const res = await post(port, `/api/holds/${hold.id}/approve`, body, { origin });
        assert.equal(res.status, 403, origin);
        assert.equal(queue.get(hold.id).status, 'pending', origin);
      }
      assert.equal((await request(port, { path: '/api/holds', headers: { origin: 'http://evil.example' } })).status, 403);
      const ok = await post(port, `/api/holds/${hold.id}/approve`, body, { origin: `http://127.0.0.1:${port}` });
      assert.equal(ok.status, 200);
    });
  });

  test('non-JSON POST ⇒ 415; bad JSON ⇒ 400; wrong verb ⇒ 405; huge body ⇒ 413', async () => {
    await withServer({}, async ({ queue, port }) => {
      const hold = queue.add({ kind: 'tool-arg', review: review(), cluster: 'devnet', timeoutSec: 40 });
      for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', undefined]) {
        const headers = type === undefined ? {} : { 'content-type': type };
        const res = await request(port, { method: 'POST', path: `/api/holds/${hold.id}/reject`, headers, body: '{}' });
        assert.equal(res.status, 415, String(type));
      }
      assert.equal(queue.get(hold.id).status, 'pending');
      assert.equal((await post(port, `/api/holds/${hold.id}/reject`, '{not json')).status, 400);
      assert.equal((await post(port, `/api/holds/${hold.id}/reject`, '[]')).status, 400);
      assert.equal((await request(port, { path: `/api/holds/${hold.id}/approve` })).status, 405);
      assert.equal((await request(port, { method: 'DELETE', path: `/api/holds/${hold.id}` })).status, 405);
      assert.equal((await request(port, { method: 'POST', path: '/' })).status, 405);
      const big = await post(port, `/api/holds/${hold.id}/reject`, JSON.stringify({ reason: 'x'.repeat(20_000) }));
      assert.equal(big.status, 413);
      assert.equal(queue.get(hold.id).status, 'pending');
      const typed = await post(port, `/api/holds/${hold.id}/reject`, {}, { 'content-type': 'application/json; charset=utf-8' });
      assert.equal(typed.status, 200);
    });
  });

  test('local-button is refused on mainnet-beta at start', () => {
    const approver = wallet();
    const queue = new HoldQueue({ approver: approver.pubkey });
    assert.throws(
      () => startApprovalServer({ holds: queue, approver: approver.pubkey, method: 'local-button', cluster: 'mainnet-beta', port: 0 }),
      /local-button/,
    );
  });

  test('local-button on devnet approves as insecure-local-button', async () => {
    await withServer({ method: 'local-button' }, async ({ queue, port }) => {
      const list = await request(port, { path: '/api/holds' });
      assert.equal(list.json.method, 'local-button');
      const hold = queue.add({ kind: 'tool-arg', review: review(), cluster: 'devnet', timeoutSec: 40 });
      const waiting = queue.waitFor(hold.id);
      const res = await post(port, `/api/holds/${hold.id}/approve`, { method: 'local-button' });
      assert.equal(res.status, 200);
      assert.deepEqual(await waiting, { status: 'approved', approval: { publicKey: null, signature: null, method: 'insecure-local-button' } });
    });
  });

  test('local-button request in wallet-signature mode ⇒ 403, still pending', async () => {
    await withServer({}, async ({ queue, port }) => {
      const hold = queue.add({ kind: 'tool-arg', review: review(), cluster: 'devnet', timeoutSec: 40 });
      const res = await post(port, `/api/holds/${hold.id}/approve`, { method: 'local-button' });
      assert.equal(res.status, 403);
      assert.equal(queue.get(hold.id).status, 'pending');
    });
  });

  test('refuses to start with a missing, malformed or mismatched approver', () => {
    const a = wallet();
    const b = wallet();
    const queue = new HoldQueue({ approver: a.pubkey });
    assert.throws(() => startApprovalServer({ holds: queue, cluster: 'devnet', port: 0 }));
    assert.throws(() => startApprovalServer({ holds: queue, approver: 'not-a-key', cluster: 'devnet', port: 0 }));
    assert.throws(() => startApprovalServer({ holds: queue, approver: b.pubkey, cluster: 'devnet', port: 0 }), /does not match/);
    assert.throws(() => startApprovalServer({ holds: queue, approver: a.pubkey, cluster: 'testnet', port: 0 }));
    assert.throws(() => startApprovalServer({ holds: queue, approver: a.pubkey, method: 'telepathy', cluster: 'devnet', port: 0 }));
    assert.throws(() => startApprovalServer({ holds: {}, approver: a.pubkey, cluster: 'devnet', port: 0 }));
  });

  test('a busy port rejects the start promise instead of hanging', async () => {
    await withServer({}, async ({ queue, port, approver }) => {
      await assert.rejects(startApprovalServer({ holds: queue, approver: approver.pubkey, cluster: 'devnet', port }), { code: 'EADDRINUSE' });
    });
  });
});

// --- approval page --------------------------------------------------------

describe('approval page', () => {
  test('loads no external resources and no inline script', () => {
    assert.ok(!/https?:\/\//i.test(PAGE_HTML), 'no absolute URLs in the page');
    assert.ok(!/\b(src|href)\s*=\s*["']?\/\//i.test(PAGE_HTML), 'no protocol-relative URLs');
    const scripts = [...PAGE_HTML.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    assert.equal(scripts.length, 1);
    assert.match(scripts[0][1], /src="\/app\.js"/);
    assert.equal(scripts[0][2].trim(), '');
    assert.ok(!/\son[a-z]+\s*=/i.test(PAGE_HTML), 'no inline event handlers');
    assert.ok(!/https?:\/\//i.test(APP_JS), 'app.js talks to its own origin only');
  });

  test('app.js parses, never writes HTML, and follows the Phantom flow', () => {
    new vm.Script(APP_JS); // throws on a syntax error
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(APP_JS));
    assert.match(APP_JS, /window\.phantom && window\.phantom\.solana/);
    assert.match(APP_JS, /signMessage\(new TextEncoder\(\)\.encode\(hold\.approvalMessage\), 'utf8'\)/);
    assert.match(APP_JS, /\/api\/holds/);
  });
});

// A just-big-enough DOM to run app.js headless against the real server.
class FakeElement {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.parent = null;
    this.textContent = '';
    this.className = '';
    this.hidden = false;
    this.disabled = false;
    this.type = '';
    this.listeners = {};
    this.classList = { add: (...names) => { this.className = `${this.className} ${names.join(' ')}`.trim(); } };
  }
  appendChild(child) {
    child.parent = this;
    this.children.push(child);
    return child;
  }
  addEventListener(type, fn) {
    this.listeners[type] = fn;
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
  }
  *walk() {
    yield this;
    for (const child of this.children) yield* child.walk();
  }
  text() {
    return [...this.walk()].map((n) => n.textContent).join(' ');
  }
}

async function runPage(port, provider) {
  const ids = Object.fromEntries(['holds', 'empty', 'status', 'mode'].map((id) => [id, new FakeElement('div')]));
  const context = vm.createContext({
    window: provider === undefined ? {} : { phantom: { solana: provider } },
    document: { getElementById: (id) => ids[id], createElement: (tag) => new FakeElement(tag) },
    fetch: (path, init) => fetch(`http://127.0.0.1:${port}${path}`, init),
    TextEncoder,
    btoa,
    setTimeout: () => 0, // the test drives polling itself
    setInterval: () => 0,
  });
  vm.runInContext(APP_JS, context);
  for (let i = 0; i < 100 && !ids.holds.children.length; i++) await new Promise((r) => setTimeout(r, 20));
  const card = ids.holds.children[0];
  assert.ok(card, 'the page rendered the pending hold');
  const button = (label) => [...card.walk()].find((n) => n.tag === 'button' && n.textContent === label);
  return { ids, card, button };
}

function fakePhantom(signer, { connectAs = signer } = {}) {
  const calls = [];
  const key = (w) => ({ toString: () => w.pubkey });
  return {
    calls,
    isPhantom: true,
    connect: async () => {
      calls.push('connect');
      return { publicKey: key(connectAs) };
    },
    signMessage: async (bytes, display) => {
      calls.push(['signMessage', display]);
      return { signature: signer.sign(new TextDecoder().decode(bytes)), publicKey: key(signer) };
    },
  };
}

describe('approval page against the server (headless)', { skip: typeof fetch !== 'function' && 'needs global fetch' }, () => {
  test('Approve with wallet: connect, signMessage(utf8), POST ⇒ approved', async () => {
    await withServer({}, async ({ queue, port, approver }) => {
      const hold = queue.add({ kind: 'tool-arg', tool: 'wallet.sign_and_send', review: review({ summaryLine: '<img src=x onerror=alert(1)>' }), cluster: 'devnet', timeoutSec: 40 });
      const waiting = queue.waitFor(hold.id);
      const phantom = fakePhantom(approver);
      const { card, button } = await runPage(port, phantom);
      assert.ok(card.text().includes('<img src=x onerror=alert(1)>'), 'review text is shown as text');
      assert.ok(card.text().includes(hold.approvalMessage));
      await button('Approve with wallet').listeners.click();
      assert.deepEqual(phantom.calls, ['connect', ['signMessage', 'utf8']]);
      const outcome = await waiting;
      assert.equal(outcome.status, 'approved');
      assert.equal(outcome.approval.method, 'wallet-signature');
    });
  });

  test('a connected wallet that is not the approver is refused before signing', async () => {
    await withServer({}, async ({ queue, port, approver }) => {
      const hold = queue.add({ kind: 'tool-arg', review: review(), cluster: 'devnet', timeoutSec: 40 });
      const stranger = wallet();
      const phantom = fakePhantom(stranger);
      const { card, button } = await runPage(port, phantom);
      await button('Approve with wallet').listeners.click();
      assert.deepEqual(phantom.calls, ['connect']);
      assert.match(card.text(), /is not the configured approver/);
      assert.equal(queue.get(hold.id).status, 'pending');
      assert.ok(approver.pubkey);
    });
  });

  test('no Phantom: a clear error, hold still pending; Reject still works', async () => {
    await withServer({}, async ({ queue, port }) => {
      const hold = queue.add({ kind: 'tool-arg', review: review(), cluster: 'devnet', timeoutSec: 40 });
      const waiting = queue.waitFor(hold.id);
      const { card, button } = await runPage(port, undefined);
      await button('Approve with wallet').listeners.click();
      assert.match(card.text(), /Phantom was not found/);
      assert.equal(queue.get(hold.id).status, 'pending');
      await button('Reject').listeners.click();
      assert.equal((await waiting).status, 'rejected');
    });
  });

  test('local-button mode shows a plain approve button', async () => {
    await withServer({ method: 'local-button' }, async ({ queue, port }) => {
      const hold = queue.add({ kind: 'tool-arg', review: review(), cluster: 'devnet', timeoutSec: 40 });
      const waiting = queue.waitFor(hold.id);
      const { ids, button } = await runPage(port, undefined);
      assert.match(ids.mode.textContent, /INSECURE local-button/);
      await button('Approve (insecure local button)').listeners.click();
      assert.equal((await waiting).approval.method, 'insecure-local-button');
    });
  });
});

// --- notify ---------------------------------------------------------------

function recorder() {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    return { on() {}, unref() {} };
  };
  return { calls, spawn };
}

describe('notifyHold', () => {
  const url = 'http://127.0.0.1:8787/';

  test('macOS: osascript notification with escaped text, then open the page', () => {
    const { calls, spawn } = recorder();
    notifyHold({ title: 'SolFrontier Gate', body: 'say "hi" \\ bye\nnow', url, platform: 'darwin', spawn });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].command, 'osascript');
    assert.deepEqual(calls[0].args, ['-e', 'display notification "say \\"hi\\" \\\\ bye now" with title "SolFrontier Gate"']);
    assert.deepEqual(calls[1], { command: 'open', args: [url], options: calls[1].options });
    for (const call of calls) {
      assert.equal(call.options.detached, true);
      assert.equal(call.options.stdio, 'ignore');
    }
  });

  test('escapeAppleScript neutralises quotes, backslashes and control characters', () => {
    assert.equal(escapeAppleScript('a"b\\c\rd'), 'a\\"b\\\\c d');
    assert.equal(escapeAppleScript(undefined), '');
  });

  test('Linux: xdg-open only; other platforms: nothing; disabled: nothing', () => {
    const linux = recorder();
    notifyHold({ body: 'x', url, platform: 'linux', spawn: linux.spawn });
    assert.deepEqual(linux.calls.map((c) => [c.command, c.args]), [['xdg-open', [url]]]);
    const win = recorder();
    notifyHold({ body: 'x', url, platform: 'win32', spawn: win.spawn });
    assert.equal(win.calls.length, 0);
    const off = recorder();
    notifyHold({ body: 'x', url, enabled: false, platform: 'darwin', spawn: off.spawn });
    assert.equal(off.calls.length, 0);
    const noBrowser = recorder();
    notifyHold({ body: 'x', url, openUrl: false, platform: 'darwin', spawn: noBrowser.spawn });
    assert.deepEqual(noBrowser.calls.map((c) => c.command), ['osascript']);
  });

  test('only a loopback http URL is ever opened', () => {
    for (const bad of ['file:///etc/passwd', 'https://evil.example/', 'http://evil.example:8787/', 'http://127.0.0.1:8787@evil.example/', '-a Calculator', 'javascript:alert(1)']) {
      const { calls, spawn } = recorder();
      notifyHold({ body: 'x', url: bad, platform: 'darwin', spawn });
      assert.deepEqual(calls.map((c) => c.command), ['osascript'], bad);
    }
  });

  test('a nonexistent binary does not throw (and its async error is swallowed)', async () => {
    let spawned = 0;
    const missing = (command, args, options) => {
      spawned++;
      return childSpawn(`sfgate-no-such-binary-${command}`, args, options);
    };
    assert.doesNotThrow(() => notifyHold({ body: 'x', url, platform: 'darwin', spawn: missing }));
    assert.doesNotThrow(() => notifyHold({ body: 'x', url, platform: 'linux', spawn: missing }));
    assert.equal(spawned, 3);
    // An unhandled 'error' event would crash this process before the next tick.
    await new Promise((resolve) => setTimeout(resolve, 200));
  });

  test('a spawn that throws synchronously, or returns nothing, does not throw', () => {
    const throwing = () => {
      throw new Error('EPERM');
    };
    assert.doesNotThrow(() => notifyHold({ body: 'x', url, platform: 'darwin', spawn: throwing }));
    assert.doesNotThrow(() => notifyHold({ body: 'x', url, platform: 'linux', spawn: () => undefined }));
    assert.doesNotThrow(() => notifyHold({ platform: 'darwin', spawn: throwing, title: { toString: null } }));
  });
});
