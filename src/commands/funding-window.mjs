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
 * What has to happen AFTER a payment is signed, before the executor can take
 * a lease. Signing with less than the sum of these left is signing into a
 * window that has already closed — the payment lands on time and is still
 * unexecutable, which is precisely how both stranded amounts happened.
 *
 * Derived, not chosen. Each figure is measured or pinned elsewhere:
 */
export const POST_SIGNING_BUDGET_MS = {
  // Solend reserve freshness. Measured 2026-08-01: fresh for ~6.4s out of
  // roughly every 60s, so a full refresh cycle is the honest worst case.
  reserveRefresh: 60_000,
  // RPC visibility plus one confirm round trip, at the CLI's default
  // per-request timeout.
  rpcAndConfirm: 20_000,
  // Executor scan interval, final revalidation, CAS, simulation, policy,
  // signing and broadcast.
  executorCycle: 40_000,
};

/** Total time that must remain after signing. 120s at present. */
export const REQUIRED_POST_SIGNING_MS = Object.values(POST_SIGNING_BUDGET_MS).reduce((a, b) => a + b, 0);

/**
 * @param {object} p
 * @param {number} p.now                 current epoch ms
 * @param {number} p.expiresAtMs         funding deadline (hard, server-side)
 * @param {number} p.reconcileMs         how long to keep searching afterwards
 * @param {number} [p.postSigningMs]     time that must remain after signing
 */
export function windowState({ now, expiresAtMs, reconcileMs, postSigningMs = REQUIRED_POST_SIGNING_MS }) {
  const reconcileUntil = expiresAtMs + reconcileMs;
  const pastCutoff = now >= expiresAtMs;

  // The approval cutoff is EARLIER than the funding deadline, and it is the
  // one a human must respect. Treating the funding deadline as the signing
  // cutoff permits approving a payment one millisecond before expiry: that
  // payment can be perfectly on time and still unexecutable, because nothing
  // downstream has any time left to run.
  const approvalDeadlineMs = expiresAtMs - postSigningMs;
  const maySign = now < approvalDeadlineMs;

  return {
    reconcileUntil,
    approvalDeadlineMs,
    // May a human still approve a payment?
    maySign,
    // Past the approval cutoff but before the hard deadline: a payment could
    // still land in time, so anything already broadcast must still be found
    // and confirmed. Nothing NEW may be approved.
    inGracePeriod: !maySign && !pastCutoff,
    // Should we keep looking? Past the deadline, yes — a payment can be on
    // chain and on time while the RPC is still slow to list it. Abandoning
    // the search at the deadline is how money moves with nothing recorded.
    keepSearching: now < reconcileUntil,
    pastCutoff,
    msUntilApprovalCutoff: Math.max(0, approvalDeadlineMs - now),
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
 * How a completed run should be described, and whether it succeeded.
 *
 * Two different questions, deliberately not merged:
 *
 *   recorded    did the database record the payment? Money that reached the
 *               chain must be recorded even when it is too late to use, or
 *               the ledger and the chain disagree.
 *   runSuccess  did the run achieve what it set out to? Funds that can never
 *               be leased are a failed run, however tidy the bookkeeping.
 *
 * Reporting `recorded` as success is how automation sees green while money is
 * permanently stuck. Both stranded amounts in this project reached
 * `budget_reserved`; neither can ever execute.
 */
export function describeOutcome({ confirmStatus, now, expiresAtMs }) {
  if (confirmStatus !== 'budget_reserved') {
    return {
      recorded: false,
      executable: false,
      runSuccess: false,
      label: 'not_confirmed',
      event: 'confirm.failed',
      note: 'the payment was not recorded; reconcile the signature by hand',
    };
  }
  if (now >= expiresAtMs) {
    return {
      recorded: true,
      executable: false,
      runSuccess: false,
      label: 'budget_reserved_expired',
      // Not "confirm.ok": an audit reading the event stream must not see a
      // success marker on a run whose funds are stranded.
      event: 'confirm.recorded_but_expired',
      note: 'budget_reserved (expired, unexecutable, manual reconciliation required)',
    };
  }
  return {
    recorded: true,
    executable: true,
    runSuccess: true,
    label: 'budget_reserved_executable',
    event: 'confirm.ok',
  };
}
