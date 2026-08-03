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
import {
  windowState,
  shouldAttemptConfirm,
  describeOutcome,
  REQUIRED_POST_SIGNING_MS,
  POST_SIGNING_BUDGET_MS,
} from '../src/commands/funding-window.mjs';

const CUTOFF = 1_000_000;
const RECONCILE = 90_000;
const RETRYABLE = new Set(['pending', 'pending_confirmation', 'not_yet_confirmed', 'funding_submitted', 'rpc_error']);
const w = (now) => windowState({ now, expiresAtMs: CUTOFF, reconcileMs: RECONCILE });
const APPROVAL = CUTOFF - REQUIRED_POST_SIGNING_MS;

describe('the approval cutoff is earlier than the funding deadline', () => {
  // Both stranded amounts were paid on time and were still unexecutable,
  // because nothing downstream had time left to run. Signing at the funding
  // deadline is signing into a window that has already closed.
  test('the post-signing budget is derived from its parts, not chosen', () => {
    const sum = POST_SIGNING_BUDGET_MS.reserveRefresh
      + POST_SIGNING_BUDGET_MS.rpcAndConfirm
      + POST_SIGNING_BUDGET_MS.executorCycle;
    assert.equal(REQUIRED_POST_SIGNING_MS, sum);
  });

  test('the budget is at least the 120s floor set after the incident', () => {
    assert.ok(REQUIRED_POST_SIGNING_MS >= 120_000, `budget is only ${REQUIRED_POST_SIGNING_MS}ms`);
  });

  test('in a 180s window a human has roughly the first 60s', () => {
    const expires = 180_000;
    const s = windowState({ now: 0, expiresAtMs: expires, reconcileMs: RECONCILE });
    assert.equal(s.msUntilApprovalCutoff, expires - REQUIRED_POST_SIGNING_MS);
    assert.ok(s.msUntilApprovalCutoff <= 60_000);
  });

  test('signing is allowed right up to the approval cutoff', () => {
    assert.equal(w(APPROVAL - 1).maySign, true);
  });

  test('signing stops at the approval cutoff, long before the deadline', () => {
    const s = w(APPROVAL);
    assert.equal(s.maySign, false);
    assert.equal(s.pastCutoff, false, 'the funding deadline has NOT passed yet');
    assert.equal(s.inGracePeriod, true);
  });

  test('the old behaviour is gone: signing one millisecond before expiry is refused', () => {
    assert.equal(w(CUTOFF - 1).maySign, false);
  });

  test('an already-broadcast payment is still searched for during the grace period', () => {
    const s = w(CUTOFF - 1);
    assert.equal(s.maySign, false);
    assert.equal(s.keepSearching, true);
  });

  test('countdowns never go negative', () => {
    assert.equal(w(CUTOFF + 5000).msUntilCutoff, 0);
    assert.equal(w(CUTOFF).msUntilApprovalCutoff, 0);
  });
});

describe('the funding deadline is still the hard boundary', () => {
  test('past it, nothing may be signed and the deadline is flagged', () => {
    const s = w(CUTOFF);
    assert.equal(s.maySign, false);
    assert.equal(s.pastCutoff, true);
    assert.equal(s.inGracePeriod, false);
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

describe('recording a payment is not the same as the run succeeding', () => {
  test('confirmed before the deadline is recorded, executable and a success', () => {
    const o = describeOutcome({ confirmStatus: 'budget_reserved', now: CUTOFF - 1, expiresAtMs: CUTOFF });
    assert.deepEqual([o.recorded, o.executable, o.runSuccess], [true, true, true]);
    assert.equal(o.event, 'confirm.ok');
  });

  test('confirmed at or after the deadline is recorded but NOT a success', () => {
    // The state both stranded amounts are in. It must be recorded -- the
    // chain and the ledger have to agree -- but a run that leaves money
    // permanently unusable did not succeed, and automation must see that.
    const o = describeOutcome({ confirmStatus: 'budget_reserved', now: CUTOFF, expiresAtMs: CUTOFF });
    assert.equal(o.recorded, true, 'the payment must still be recorded');
    assert.equal(o.executable, false);
    assert.equal(o.runSuccess, false, 'stranded funds are not a successful run');
    assert.match(o.note, /manual reconciliation required/);
  });

  test('the expired case is not labelled as a success in the event stream', () => {
    const o = describeOutcome({ confirmStatus: 'budget_reserved', now: CUTOFF, expiresAtMs: CUTOFF });
    assert.notEqual(o.event, 'confirm.ok', 'an audit must not see a success marker over stranded funds');
    assert.equal(o.event, 'confirm.recorded_but_expired');
  });

  test('anything other than budget_reserved is neither recorded nor a success', () => {
    for (const status of ['pending', 'invalid_funding', undefined, null]) {
      const o = describeOutcome({ confirmStatus: status, now: 0, expiresAtMs: CUTOFF });
      assert.equal(o.recorded, false, `status ${status}`);
      assert.equal(o.runSuccess, false);
      assert.equal(o.executable, false);
      assert.equal(o.event, 'confirm.failed');
    }
  });
});
