// Fake-clock tests for the two deadlines.
//
// These exist because both previous versions of this logic were wrong at the
// boundary and both looked fine running against a real clock: the first
// stopped searching the instant signing was cut off, and the repair then
// gated confirmation on that same instant, so a payment proven exactly there
// was never confirmed at all. Boundaries are where this fails, so boundaries
// are what gets tested -- with time as a parameter, never Date.now().
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { windowState, shouldAttemptConfirm, describeOutcome } from '../src/commands/funding-window.mjs';

const CUTOFF = 1_000_000;
const RECONCILE = 90_000;
const RETRYABLE = new Set(['pending', 'pending_confirmation', 'not_yet_confirmed', 'funding_submitted', 'rpc_error']);
const w = (now) => windowState({ now, expiresAtMs: CUTOFF, reconcileMs: RECONCILE });

describe('signing cutoff', () => {
  test('signing is allowed right up to the cutoff', () => {
    assert.equal(w(CUTOFF - 1).maySign, true);
  });

  test('signing stops exactly at the cutoff, not a millisecond later', () => {
    assert.equal(w(CUTOFF).maySign, false);
    assert.equal(w(CUTOFF).pastCutoff, true);
  });

  test('countdown never goes negative', () => {
    assert.equal(w(CUTOFF + 5000).msUntilCutoff, 0);
  });
});

describe('reconciliation window', () => {
  test('searching continues past the cutoff', () => {
    // The 2026-08-02 defect: the search ended here, so a payment the RPC
    // listed late would never be found.
    const s = w(CUTOFF + 1);
    assert.equal(s.pastCutoff, true);
    assert.equal(s.keepSearching, true, 'the search must outlive the signing cutoff');
    assert.equal(s.maySign, false, 'but signing must not');
  });

  test('searching continues to the last millisecond of the window', () => {
    assert.equal(w(CUTOFF + RECONCILE - 1).keepSearching, true);
  });

  test('searching stops at the end of the window', () => {
    assert.equal(w(CUTOFF + RECONCILE).keepSearching, false);
  });

  test('a zero reconciliation window degenerates to the old behaviour', () => {
    const s = windowState({ now: CUTOFF, expiresAtMs: CUTOFF, reconcileMs: 0 });
    assert.equal(s.keepSearching, false);
  });
});

describe('confirmation is not optional once a payment is proven', () => {
  test('the first attempt happens even when proof lands after the window closed', () => {
    // The exact regression: proof at the boundary previously produced zero
    // confirm calls, leaving money on chain and nothing in the database.
    const provenAt = CUTOFF + RECONCILE;
    const d = shouldAttemptConfirm({
      attempt: 1, now: provenAt, provenAt, retryMs: 60_000,
      lastStatus: null, retryableStatuses: RETRYABLE,
    });
    assert.equal(d.attempt, true);
    assert.equal(d.reason, 'first_attempt_is_unconditional');
  });

  test('the first attempt happens even long past every deadline', () => {
    const provenAt = CUTOFF + 10 * RECONCILE;
    assert.equal(shouldAttemptConfirm({
      attempt: 1, now: provenAt, provenAt, retryMs: 1,
      lastStatus: null, retryableStatuses: RETRYABLE,
    }).attempt, true);
  });

  test('retries are bounded from the moment of proof, not from the window', () => {
    const provenAt = 500_000;
    const base = { attempt: 2, provenAt, retryMs: 60_000, lastStatus: 'pending', retryableStatuses: RETRYABLE };
    assert.equal(shouldAttemptConfirm({ ...base, now: provenAt + 59_999 }).attempt, true);
    const spent = shouldAttemptConfirm({ ...base, now: provenAt + 60_000 });
    assert.equal(spent.attempt, false);
    assert.equal(spent.reason, 'retry_budget_exhausted');
  });

  test('every retryable status keeps retrying', () => {
    for (const status of RETRYABLE) {
      const d = shouldAttemptConfirm({
        attempt: 2, now: 0, provenAt: 0, retryMs: 60_000,
        lastStatus: status, retryableStatuses: RETRYABLE,
      });
      assert.equal(d.attempt, true, `status ${status} should retry`);
    }
  });

  test('a terminal status stops the loop instead of burning the budget', () => {
    const d = shouldAttemptConfirm({
      attempt: 2, now: 0, provenAt: 0, retryMs: 60_000,
      lastStatus: 'invalid_funding', retryableStatuses: RETRYABLE,
    });
    assert.equal(d.attempt, false);
    assert.equal(d.reason, 'terminal_status');
  });

  test('success stops the loop', () => {
    const d = shouldAttemptConfirm({
      attempt: 2, now: 0, provenAt: 0, retryMs: 60_000,
      lastStatus: 'budget_reserved', retryableStatuses: RETRYABLE,
    });
    assert.equal(d.attempt, false);
    assert.equal(d.reason, 'already_reserved');
  });
});

describe('outcome is not reported as success when the funds cannot move', () => {
  test('confirmed before the deadline is executable', () => {
    const o = describeOutcome({ confirmStatus: 'budget_reserved', now: CUTOFF - 1, expiresAtMs: CUTOFF });
    assert.deepEqual([o.ok, o.executable], [true, true]);
  });

  test('confirmed at or after the deadline is reserved but unexecutable', () => {
    // This is the state both stranded amounts are in. Reporting it as a
    // plain success is how a run gets called green while the money is stuck.
    const o = describeOutcome({ confirmStatus: 'budget_reserved', now: CUTOFF, expiresAtMs: CUTOFF });
    assert.equal(o.ok, true);
    assert.equal(o.executable, false);
    assert.match(o.note, /manual reconciliation required/);
  });

  test('anything other than budget_reserved is not ok', () => {
    for (const status of ['pending', 'invalid_funding', undefined, null]) {
      const o = describeOutcome({ confirmStatus: status, now: 0, expiresAtMs: CUTOFF });
      assert.equal(o.ok, false, `status ${status}`);
      assert.equal(o.executable, false);
    }
  });
});
