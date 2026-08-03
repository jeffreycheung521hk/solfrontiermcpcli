// The two deadlines of a funding run, as a pure state machine.
//
// Extracted from the polling loop because the loop is the wrong place to
// reason about time: on 2026-08-02 a correct payment was lost partly because
// the search stopped at the same instant signing was cut off, and the first
// repair then gated the confirm loop on that same instant, so a payment
// proven at the boundary produced zero confirm calls. Both defects are
// invisible in a loop that only runs against a real clock.
//
// Every function here takes `now` explicitly. Nothing calls Date.now().

/**
 * @param {object} p
 * @param {number} p.now              current epoch ms
 * @param {number} p.expiresAtMs      funding deadline = signing cutoff
 * @param {number} p.reconcileMs      how long to keep searching afterwards
 */
export function windowState({ now, expiresAtMs, reconcileMs }) {
  const reconcileUntil = expiresAtMs + reconcileMs;
  const pastCutoff = now >= expiresAtMs;
  return {
    reconcileUntil,
    // May the human still approve a payment? Only before the cutoff: a later
    // payment cannot be leased by the executor, so inviting one would strand
    // funds by design.
    maySign: !pastCutoff,
    // Should we keep looking? Past the cutoff, yes — a payment can be on
    // chain and on time while the RPC is still slow to list it. Abandoning
    // the search at the cutoff is how money moves with nothing recorded.
    keepSearching: now < reconcileUntil,
    pastCutoff,
    msUntilCutoff: Math.max(0, expiresAtMs - now),
    msUntilReconcileEnd: Math.max(0, reconcileUntil - now),
  };
}

/**
 * Confirmation is not optional once a payment is proven.
 *
 * The first attempt is unconditional: the money is already on chain, and the
 * server alone decides whether it was late. Only retries are bounded, by a
 * budget measured from the moment of proof rather than from any window that
 * may already have closed.
 */
export function shouldAttemptConfirm({ attempt, now, provenAt, retryMs, lastStatus, retryableStatuses }) {
  if (attempt <= 1) return { attempt: true, reason: 'first_attempt_is_unconditional' };
  if (lastStatus === 'budget_reserved') return { attempt: false, reason: 'already_reserved' };
  if (lastStatus && !retryableStatuses.has(lastStatus)) return { attempt: false, reason: 'terminal_status' };
  if (now - provenAt >= retryMs) return { attempt: false, reason: 'retry_budget_exhausted' };
  return { attempt: true, reason: 'retryable' };
}

/**
 * How a completed run should be described.
 *
 * `budget_reserved` alone does not mean the intent can execute: the executor
 * needs the funding deadline still ahead of it to take a lease. Conflating
 * the two is how a run gets reported as a success while the funds are
 * permanently stuck.
 */
export function describeOutcome({ confirmStatus, now, expiresAtMs }) {
  if (confirmStatus !== 'budget_reserved') {
    return { ok: false, executable: false, label: 'not_confirmed' };
  }
  if (now >= expiresAtMs) {
    return {
      ok: true,
      executable: false,
      label: 'budget_reserved_expired',
      note: 'budget_reserved (expired, unexecutable, manual reconciliation required)',
    };
  }
  return { ok: true, executable: true, label: 'budget_reserved_executable' };
}
