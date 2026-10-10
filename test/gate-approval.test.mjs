// T6: holds and wallet-signature approval (SPEC §5.6, I3, I7, I11).
//
// Keys are generated at runtime; nothing here touches a network or a real
// wallet. Every listener binds port 0 because test files run in parallel.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
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
