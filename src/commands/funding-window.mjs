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
 * window that has already closed: the payment lands on time and is still
 * unexecutable.
 *
 * This is a PINNED SAFETY ASSUMPTION, not a proven upper bound. The total is
 * derived from its parts rather than picked, but each part is itself an
 * assumption -- one measurement taken on a single day, one configured timeout,
 * and one estimate of work that has been observed only a handful of times.
 * Treat a change to any figure as a change to the safety argument.
 *
 * It is NOT a reconstruction of either stranded amount, and an earlier version
 * of this comment wrongly claimed it was. Both were paid with far more than
 * this remaining -- roughly 133 s and 159 s -- so this cutoff would have blocked
 * neither. Their proximate causes were an executor started after the deadline
 * and a memo prefilter that discarded the one correct transaction; both are
 * fixed elsewhere and neither is addressed here. What this budget defends
 * against is a different failure that has not happened yet: a payment approved
 * so close to the deadline that nothing downstream can run.
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
    // Should we keep looking? Past the deadline, yes -- a payment can be on
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
 * Read the server's own expiry verdict out of a `confirm_funding` success body.
 *
 * The client's wall clock is the WEAKEST of the available signals and it
 * cannot see the one that matters most. Whether the executor may take a lease
 * is governed by two deadlines: the funding row's `expires_at_ms`, and the
 * WatchRule's `expires_at_slot` -- a *slot* clock the client has no way to
 * evaluate, because it never observes the transaction's slot against the
 * rule's. A run that consults only its own clock will happily print success
 * over funds whose slot deadline has already passed.
 *
 * So the server's fields decide, and the rule is fail closed: ANY authoritative
 * signal of lateness makes the funds unexecutable.
 *
 * Two subtleties, both of which turn "no" into "unknown":
 *
 *  - `expired_at_funding_slot` is computed server-side as
 *    `observed_slot.is_some_and(|s| s >= expires_at_slot)`. With no observed
 *    slot it is `false` -- indistinguishable from a genuine "not expired". The
 *    slot verdict therefore counts only when a slot was actually observed.
 *  - The booleans are re-derived here from the raw numbers alongside them. If
 *    a boolean and its own inputs disagree, something is wrong with an
 *    assumption on one side of the pipe, and disagreement is treated as
 *    expired rather than resolved in favour of the happier answer.
 *
 * `funding_arrival_time_source` is reported but does not gate: when `blockTime`
 * is missing the server substitutes its confirmation-time clock, which is at or
 * after true arrival, so it can only ever make a payment look later than it
 * was. That direction is safe.
 *
 * @param {object|null|undefined} body a `confirm_funding` response body
 */
export function serverExpiryVerdict(body) {
  const signals = [];
  const disagreements = [];
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

  const rule = body?.watch_rule ?? null;
  const arrivalMs = num(body?.funding_arrival_time_ms);
  const rowExpiresMs = num(body?.funding_row_expires_at_ms);
  const txSlot = num(rule?.funding_transaction_slot);
  const ruleExpiresSlot = num(rule?.expires_at_slot);

  // --- wall-clock deadline, as the server computed it ---------------------
  const deadlineCheckable = arrivalMs !== null && rowExpiresMs !== null;
  const reportedLate = body?.arrived_after_funding_deadline;
  if (reportedLate === true) signals.push('arrived_after_funding_deadline');
  if (deadlineCheckable) {
    const recomputed = arrivalMs >= rowExpiresMs;
    if (typeof reportedLate === 'boolean' && recomputed !== reportedLate) {
      disagreements.push('arrived_after_funding_deadline');
      signals.push('arrived_after_funding_deadline:disagreement');
    } else if (recomputed && reportedLate !== true) {
      signals.push('arrived_after_funding_deadline:recomputed');
    }
  }

  // --- slot deadline: the one the client cannot see for itself ------------
  const slotCheckable = txSlot !== null && ruleExpiresSlot !== null;
  const reportedSlotExpired = rule?.expired_at_funding_slot;
  if (slotCheckable) {
    const recomputed = txSlot >= ruleExpiresSlot;
    if (recomputed) signals.push('watch_rule.expired_at_funding_slot');
    if (typeof reportedSlotExpired === 'boolean' && recomputed !== reportedSlotExpired) {
      disagreements.push('watch_rule.expired_at_funding_slot');
      signals.push('watch_rule.expired_at_funding_slot:disagreement');
    }
  } else if (reportedSlotExpired === true) {
    // Asserted without the numbers to check it. Believe the bad news.
    signals.push('watch_rule.expired_at_funding_slot');
  }

  // --- the server's own refund marker -------------------------------------
  if (body?.late_funding !== null && body?.late_funding !== undefined) {
    signals.push('late_funding');
  }

  return {
    // Every deadline could be evaluated from server-supplied numbers.
    verified: deadlineCheckable && slotCheckable,
    expired: signals.length > 0,
    signals,
    disagreements,
    arrivalTimeSource: body?.funding_arrival_time_source ?? null,
  };
}

/**
 * How a completed run should be described, and whether it succeeded.
 *
 * Three different questions, deliberately not merged:
 *
 *   recorded    did the database record the payment? Money that reached the
 *               chain must be recorded even when it is too late to use, or
 *               the ledger and the chain disagree.
 *   executable  can the executor still take a lease on it? This is the
 *               server's verdict, not ours -- see serverExpiryVerdict.
 *   runSuccess  did the run achieve what it set out to? Funds that can never
 *               be leased are a failed run, however tidy the bookkeeping, and
 *               so are funds we cannot PROVE are leasable.
 *
 * Reporting `recorded` as success is how automation sees green while money is
 * permanently stuck. Both stranded amounts in this project reached
 * `budget_reserved`; neither can ever execute.
 *
 * @param {object} p
 * @param {string} [p.confirmStatus]  the response `status`
 * @param {number} p.now              client clock, the weakest signal
 * @param {number} p.expiresAtMs      funding deadline as the client knows it
 * @param {object} [p.confirmBody]    the full response, for the server verdict
 */
export function describeOutcome({ confirmStatus, now, expiresAtMs, confirmBody = null }) {
  if (confirmStatus !== 'budget_reserved') {
    return {
      recorded: false,
      executable: false,
      runSuccess: false,
      label: 'not_confirmed',
      event: 'confirm.failed',
      authority: 'none',
      signals: [],
      note: 'the payment was not recorded; reconcile the signature by hand',
    };
  }

  const server = serverExpiryVerdict(confirmBody);
  const clientExpired = now >= expiresAtMs;
  const signals = [...server.signals];
  if (clientExpired) signals.push('client_wall_clock');

  if (server.expired || clientExpired) {
    return {
      recorded: true,
      executable: false,
      runSuccess: false,
      label: 'budget_reserved_expired',
      // Not "confirm.ok": an audit reading the event stream must not see a
      // success marker on a run whose funds are stranded.
      event: 'confirm.recorded_but_expired',
      authority: server.expired ? 'server' : 'client_clock_only',
      signals,
      disagreements: server.disagreements,
      note: 'budget_reserved (expired, unexecutable, manual reconciliation required)',
    };
  }

  if (!server.verified) {
    // Nothing says late, but the slot deadline could not be evaluated, so
    // "leasable" is an assumption rather than a finding. Claiming success here
    // is the exact shape of the defect this function exists to prevent, only
    // with a slot clock instead of a wall clock.
    return {
      recorded: true,
      executable: false,
      runSuccess: false,
      label: 'budget_reserved_unverified',
      event: 'confirm.recorded_but_unverified',
      authority: 'insufficient',
      signals,
      disagreements: server.disagreements,
      note: 'budget_reserved, but the server did not supply the deadline fields '
        + 'needed to prove the executor can still lease it; verify by hand',
    };
  }

  return {
    recorded: true,
    executable: true,
    runSuccess: true,
    label: 'budget_reserved_executable',
    event: 'confirm.ok',
    authority: 'server',
    signals,
    disagreements: server.disagreements,
    arrivalTimeSource: server.arrivalTimeSource,
  };
}
