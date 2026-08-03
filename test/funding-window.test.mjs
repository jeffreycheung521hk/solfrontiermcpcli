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
  serverExpiryVerdict,
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

/**
 * A `confirm_funding` success body shaped exactly like the server's, from
 * bins/solfrontier-mcp/src/funding.rs::success_response. Healthy by default.
 */
const body = ({
  arrivalMs = CUTOFF - 60_000,
  expiresMs = CUTOFF,
  txSlot = 1000,
  ruleSlot = 1480,
  ...overrides
} = {}) => ({
  status: 'budget_reserved',
  funding_arrival_time_ms: arrivalMs,
  funding_row_expires_at_ms: expiresMs,
  funding_arrival_time_source: 'funding_transaction.blockTime',
  arrived_after_funding_deadline: arrivalMs >= expiresMs,
  watch_rule: {
    expires_at_slot: ruleSlot,
    funding_transaction_slot: txSlot,
    expired_at_funding_slot: txSlot >= ruleSlot,
  },
  late_funding: arrivalMs >= expiresMs ? { refundable: true } : null,
  ...overrides,
});

describe('the server, not our clock, decides whether funds are still leasable', () => {
  test('a healthy body reports not expired and fully verified', () => {
    const v = serverExpiryVerdict(body());
    assert.equal(v.expired, false);
    assert.equal(v.verified, true);
    assert.deepEqual(v.signals, []);
  });

  test('the SLOT deadline is caught even though our clock says there is time', () => {
    // The gap that mattered: expires_at_slot is a clock this client cannot
    // evaluate. Wall-clock-only logic prints success over funds the executor
    // can never lease.
    const v = serverExpiryVerdict(body({ txSlot: 1480, ruleSlot: 1480 }));
    assert.equal(v.expired, true);
    assert.ok(v.signals.includes('watch_rule.expired_at_funding_slot'));

    const o = describeOutcome({
      confirmStatus: 'budget_reserved',
      now: CUTOFF - 60_000,          // our clock is perfectly happy
      expiresAtMs: CUTOFF,
      confirmBody: body({ txSlot: 1480, ruleSlot: 1480 }),
    });
    assert.equal(o.runSuccess, false, 'a passed slot deadline must not exit green');
    assert.equal(o.event, 'confirm.recorded_but_expired');
    assert.equal(o.authority, 'server');
  });

  test('a missing transaction slot is unknown, not "not expired"', () => {
    // expired_at_funding_slot is `observed_slot.is_some_and(..)` server-side,
    // so with no slot it is false -- identical to a genuine pass. Verification
    // must depend on the numbers being there, not on the boolean being false.
    const v = serverExpiryVerdict(body({ txSlot: null }));
    assert.equal(v.expired, false);
    assert.equal(v.verified, false, 'absence of a slot is not evidence of freshness');

    const o = describeOutcome({
      confirmStatus: 'budget_reserved', now: 0, expiresAtMs: CUTOFF,
      confirmBody: body({ txSlot: null }),
    });
    assert.equal(o.label, 'budget_reserved_unverified');
    assert.equal(o.runSuccess, false);
    assert.equal(o.event, 'confirm.recorded_but_unverified');
  });

  test('a boolean that contradicts its own inputs is treated as expired', () => {
    const v = serverExpiryVerdict(body({ txSlot: 2000, ruleSlot: 1480, watch_rule: {
      expires_at_slot: 1480, funding_transaction_slot: 2000, expired_at_funding_slot: false,
    } }));
    assert.equal(v.expired, true);
    assert.deepEqual(v.disagreements, ['watch_rule.expired_at_funding_slot']);
  });

  test('a late arrival is caught from the deadline field', () => {
    const v = serverExpiryVerdict(body({ arrivalMs: CUTOFF + 1 }));
    assert.equal(v.expired, true);
    assert.ok(v.signals.includes('arrived_after_funding_deadline'));
    assert.ok(v.signals.includes('late_funding'));
  });

  test('the fallback arrival clock is reported but does not block', () => {
    // Without blockTime the server substitutes its confirmation clock, which
    // is at or after true arrival -- it can only make a payment look later, so
    // trusting it cannot produce a false pass.
    const v = serverExpiryVerdict(body({ funding_arrival_time_source: 'confirmation_clock_fallback' }));
    assert.equal(v.expired, false);
    assert.equal(v.arrivalTimeSource, 'confirmation_clock_fallback');
  });

  test('an empty or absent body is unverified, never a pass', () => {
    for (const b of [null, undefined, {}]) {
      const v = serverExpiryVerdict(b);
      assert.equal(v.verified, false);
      assert.equal(v.expired, false, 'nothing asserts lateness');
      const o = describeOutcome({ confirmStatus: 'budget_reserved', now: 0, expiresAtMs: CUTOFF, confirmBody: b });
      assert.equal(o.runSuccess, false, 'unverifiable is not success');
    }
  });
});

describe('recording a payment is not the same as the run succeeding', () => {
  test('confirmed before both deadlines is recorded, executable and a success', () => {
    const o = describeOutcome({
      confirmStatus: 'budget_reserved', now: CUTOFF - 1, expiresAtMs: CUTOFF, confirmBody: body(),
    });
    assert.deepEqual([o.recorded, o.executable, o.runSuccess], [true, true, true]);
    assert.equal(o.event, 'confirm.ok');
    assert.equal(o.authority, 'server');
  });

  test('our own clock still fails closed even when the server looks happy', () => {
    // The server evaluates arrival against blockTime; our clock is a third,
    // weaker signal that is kept as a backstop rather than replaced.
    const o = describeOutcome({
      confirmStatus: 'budget_reserved', now: CUTOFF, expiresAtMs: CUTOFF,
      confirmBody: body({ arrivalMs: CUTOFF - 60_000 }),
    });
    assert.equal(o.runSuccess, false);
    assert.equal(o.authority, 'client_clock_only');
    assert.ok(o.signals.includes('client_wall_clock'));
  });

  test('confirmed at or after the deadline is recorded but NOT a success', () => {
    // The state both stranded amounts are in. It must be recorded -- the
    // chain and the ledger have to agree -- but a run that leaves money
    // permanently unusable did not succeed, and automation must see that.
    const o = describeOutcome({
      confirmStatus: 'budget_reserved', now: CUTOFF, expiresAtMs: CUTOFF,
      confirmBody: body({ arrivalMs: CUTOFF }),
    });
    assert.equal(o.recorded, true, 'the payment must still be recorded');
    assert.equal(o.executable, false);
    assert.equal(o.runSuccess, false, 'stranded funds are not a successful run');
    assert.match(o.note, /manual reconciliation required/);
  });

  test('the expired case is not labelled as a success in the event stream', () => {
    const o = describeOutcome({
      confirmStatus: 'budget_reserved', now: CUTOFF, expiresAtMs: CUTOFF, confirmBody: body({ arrivalMs: CUTOFF }),
    });
    assert.notEqual(o.event, 'confirm.ok', 'an audit must not see a success marker over stranded funds');
    assert.equal(o.event, 'confirm.recorded_but_expired');
  });

  test('anything other than budget_reserved is neither recorded nor a success', () => {
    for (const status of ['pending', 'invalid_funding', undefined, null]) {
      const o = describeOutcome({ confirmStatus: status, now: 0, expiresAtMs: CUTOFF, confirmBody: body() });
      assert.equal(o.recorded, false, `status ${status}`);
      assert.equal(o.runSuccess, false);
      assert.equal(o.executable, false);
      assert.equal(o.event, 'confirm.failed');
    }
  });
});

describe('the two halves of the approval gate agree on where it is', () => {
  test('the signing page guard uses the same cutoff as the command line', async () => {
    // A browser file cannot import the constant, so the agreement is asserted
    // here. They were 60000 and 120000 for a while, which meant the page kept
    // accepting signatures for a minute after the CLI declared the window shut.
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const path = await import('node:path');
    const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    const guard = readFileSync(path.join(root, 'scripts', 'demo', 'signing-guard.js'), 'utf8');
    const match = guard.match(/const APPROVAL_CUTOFF_MS = (\d+);/);
    assert.ok(match, 'the guard must declare APPROVAL_CUTOFF_MS');
    assert.equal(Number(match[1]), REQUIRED_POST_SIGNING_MS);
    assert.ok(!/expires_at_ms - 60000/.test(guard), 'the old hard-coded T-60 must be gone');
  });
});
