// `flow` — the funding orchestration, with the hard-won ordering built in.
//
// The 2026-08-01 acceptance failed on sequencing, not on any bug: every
// manual step ran before the executor was started, and by the time it was,
// both deadlines had passed. The fix is not a faster human — it is a tool
// that does the machine parts instantly and keeps the human on the critical
// path for exactly one action: signing.
//
//   preflight ─► propose ─► finalize ─► [human signs] ─► auto-detect ─► confirm
//                              │                             │
//                       clock starts here            baseline diff makes an
//                       (180 seconds)                old transaction unusable
//
// Safety properties:
//   * --dry-run never leaves the scratch database and never asks for money.
//   * The signature is DETECTED, not typed: no copy-paste latency, and a
//     pre-existing transaction with an identical memo cannot be mistaken for
//     this run's funding because the baseline is captured before finalize.
//   * Every step emits an NDJSON event on stderr, so a run is auditable
//     afterwards even if the terminal is gone.
//   * This command funds an intent. It never executes one: no keypair is
//     read, nothing is signed here, and the executor is a separate process
//     the operator starts.
import { withSession } from '../mcp/session.mjs';
import { SolanaRpc } from '../solana/rpc.mjs';
import { readReserveSnapshot } from '../solana/solend.mjs';
import { RAIL, draftParams, toRawAmount } from './intent.mjs';
import { findFundingMatches } from '../solana/funding-proof.mjs';
import {
  windowState,
  shouldAttemptConfirm,
  describeOutcome,
  REQUIRED_POST_SIGNING_MS,
} from './funding-window.mjs';
import { emitResult, info, event, style, isJsonMode } from '../cli/output.mjs';
import { EXIT, UsageError, CliError } from '../cli/exit-codes.mjs';

export const spec = {
  name: 'flow',
  summary: 'Run the funding sequence in the correct order, detecting the signature automatically',
  usage: 'flow --amount 0.2 --threshold-bps 90 --user-wallet <base58> [--dry-run] [--yes]',
  options: {
    amount: { type: 'string' },
    'threshold-bps': { type: 'string' },
    'user-wallet': { type: 'string' },
    message: { type: 'string' },
    'dry-run': { type: 'boolean' },
    yes: { type: 'boolean' },
    'poll-ms': { type: 'string' },
    'reconcile-ms': { type: 'string' },
    'post-signing-ms': { type: 'string' },
  },
  notes: [
    'Start the executor (`solfrontier-mcp watch --execute`) BEFORE this command.',
    'On an empty database it idles safely on "rows": [] and can wait indefinitely.',
    'A payment is accepted only on exact proof: memo, payer signature, transferChecked',
    'fields and both balance deltas, bound to the pinned token accounts by index.',
    'The signing handoff is WITHHELD unless --post-signing-ms (default 120s) remains',
    'before the funding deadline; a payment approved later is on time and still',
    'unexecutable. That budget is a pinned assumption about this rail, not a proven',
    'bound, so it is declarable -- but lowering it lowers the safety argument with it.',
    'After the funding deadline the search continues for --reconcile-ms (default 90s),',
    'so a payment the RPC lists late is still recorded rather than lost.',
  ],
};

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// Statuses that mean "ask again with the same signature", as opposed to a
// verdict. Anything not listed here ends the loop: a wrong guess would either
// spin pointlessly or, worse, hide a real answer.
const RETRYABLE_CONFIRM_STATUSES = new Set([
  'pending',
  'pending_confirmation',
  'not_yet_confirmed',
  'funding_submitted',
  'rpc_error',
]);

// How long to keep searching past the signing cutoff. A payment can be on
// chain and on time while the RPC is still slow to list it; abandoning the
// search at the cutoff is how funds get transferred with nothing recorded.
const DEFAULT_RECONCILE_MS = 90_000;

// One depth for both the baseline and the search. They were 25 and 100, so a
// pre-run transaction ranked 26th or later escaped the baseline and could be
// replayed against a new intent carrying the same deterministic memo.
const SIGNATURE_SCAN_LIMIT = 100;

// Once an exact payment is proven, confirming it is not optional. The first
// attempt is unconditional; only retries are bounded, by this budget measured
// from the moment of proof rather than by the reconciliation deadline.
const CONFIRM_RETRY_MS = 60_000;

export function validate(flags) {
  const amount = flags.amount;
  if (!amount || toRawAmount(amount, 6) === null) {
    throw new UsageError('--amount must be a USDC decimal with at most 6 decimal places');
  }
  const thresholdBps = Number(flags['threshold-bps']);
  if (!Number.isInteger(thresholdBps) || thresholdBps < 1 || thresholdBps > 10000) {
    throw new UsageError('--threshold-bps must be an integer 1..10000');
  }
  const userWallet = flags['user-wallet'];
  if (!flags['dry-run'] && (!userWallet || !BASE58.test(userWallet))) {
    throw new UsageError('--user-wallet must be a base58 address (or use --dry-run)');
  }
  const pollMs = Number(flags['poll-ms'] ?? 1000);
  if (!Number.isInteger(pollMs) || pollMs < 250 || pollMs > 10000) {
    throw new UsageError('--poll-ms must be an integer 250..10000');
  }
  const reconcileMs = Number(flags['reconcile-ms'] ?? DEFAULT_RECONCILE_MS);
  if (!Number.isInteger(reconcileMs) || reconcileMs < 0 || reconcileMs > 600_000) {
    throw new UsageError('--reconcile-ms must be an integer 0..600000');
  }
  // The post-signing budget is an assumption about this rail, not a law, so it
  // is declarable. It is NOT a convenience knob: lowering it lowers the safety
  // argument, so an override is announced in the event stream and warned about
  // on the terminal rather than quietly honoured.
  const postSigningOverridden = flags['post-signing-ms'] !== undefined;
  const postSigningMs = Number(flags['post-signing-ms'] ?? REQUIRED_POST_SIGNING_MS);
  if (!Number.isInteger(postSigningMs) || postSigningMs < 0 || postSigningMs > 600_000) {
    throw new UsageError('--post-signing-ms must be an integer 0..600000');
  }
  return {
    amount, thresholdBps, userWallet, pollMs, reconcileMs,
    postSigningMs, postSigningOverridden,
    dryRun: Boolean(flags['dry-run']),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function run({ config, flags, verbose }) {
  const opts = validate(flags);
  const timeline = [];
  const record = (type, fields = {}) => {
    const entry = { at: new Date().toISOString(), type, ...fields };
    timeline.push(entry);
    event(type, fields);
    return entry;
  };

  const rpc = config.rpcUrlPresent ? new SolanaRpc({ timeoutMs: config.timeoutMs }) : null;

  // ---- preflight ---------------------------------------------------------
  // Checking the condition BEFORE spending the window is the whole point:
  // an intent whose condition can never be true burns 180 seconds and, if
  // funded, strands the money with no refund path.
  if (rpc) {
    const reserve = await readReserveSnapshot(rpc);
    record('preflight.reserve', {
      ageSlots: reserve.ageSlots,
      fresh: reserve.fresh,
      supplyAprBps: reserve.supplyAprBps,
    });
    info(
      `reserve: ${reserve.supplyAprBps} bps supply APY, age ${reserve.ageSlots} slots ` +
        `(${reserve.fresh ? style.green('fresh') : style.yellow('stale — executor will wait')})`,
    );
    if (reserve.supplyAprBps <= opts.thresholdBps) {
      throw new CliError(
        `condition cannot be met: supply APY ${reserve.supplyAprBps} bps is not above --threshold-bps ${opts.thresholdBps}. ` +
          'Funding now would strand the money (there is no refund handler).',
        EXIT.FAILED,
      );
    }
  } else {
    info(style.yellow('SOLFRONTIER_RPC_URL is not set: skipping chain preflight and signature auto-detection'));
    if (!opts.dryRun) {
      throw new UsageError('a real funding run needs SOLFRONTIER_RPC_URL for signature detection; use --dry-run without it');
    }
  }

  if (!opts.dryRun && !flags.yes) {
    info('');
    info(style.bold('This will create a real funding intent with a 180-second deadline.'));
    info(`  amount        ${opts.amount} USDC`);
    info(`  threshold     ${opts.thresholdBps} bps`);
    info(`  payer wallet  ${opts.userWallet}`);
    info(`  destination   ${RAIL.controlled_usdc_ata} (controlled ATA)`);
    info('');
    info('Re-run with --yes once the executor is already running.');
    return EXIT.USAGE;
  }

  return withSession(config, async (session) => {
    // ---- baseline: capture BEFORE finalize -----------------------------
    // Everything already on chain is disqualified from being this run's
    // funding. Intent ids are deterministic from (threshold_bps, amount_raw),
    // so re-running the same parameters produces the same memo, and an old
    // payment would otherwise satisfy a new intent -- the server checks only
    // that a payment is not too LATE, never that it is not too OLD.
    //
    // The slot floor is the real defence. A signature baseline is a fixed
    // window: it was 25 entries deep while the search scanned 100, so an
    // identical pre-run transaction ranked 26th or later was never excluded.
    // Widening the window only moves that edge. A slot captured before the
    // intent exists is exact regardless of history depth, and the baseline
    // remains as a cheap second line, now at the same depth as the search.
    let baseline = new Set();
    let notBeforeSlot = null;
    if (rpc) {
      notBeforeSlot = await rpc.getSlot('confirmed');
      const existing = await rpc.getSignaturesForAddress(RAIL.controlled_usdc_ata, SIGNATURE_SCAN_LIMIT);
      baseline = new Set(existing.map((s) => s.signature));
      record('baseline.captured', { count: baseline.size, notBeforeSlot });
    }

    // ---- propose (pure) --------------------------------------------------
    const proposal = await session.callTool('propose_intent', draftParams(flags));
    if (proposal.isError || proposal.body?.status !== 'ok') {
      emitResult(proposal.body);
      return EXIT.FAILED;
    }
    record('propose.ok', { draftHash: proposal.body.draft_hash });
    info(`proposed: draft ${proposal.body.draft_hash.slice(0, 12)}…`);

    if (opts.dryRun && !opts.userWallet) {
      info(style.dim('dry run: stopping before finalize (no --user-wallet given)'));
      emitResult({ dryRun: true, draft: proposal.body, timeline });
      return EXIT.OK;
    }

    // ---- finalize: THE CLOCK STARTS HERE ---------------------------------
    const finalized = await session.callTool('finalize_intent', {
      ...draftParams(flags),
      draft_id: proposal.body.draft_id,
      draft_hash: proposal.body.draft_hash,
      user_wallet: opts.userWallet,
    });
    if (finalized.isError || !finalized.body?.intent_id) {
      emitResult(finalized.body);
      return EXIT.FAILED;
    }
    const intentId = finalized.body.intent_id;
    const expiresAtMs = finalized.body.funding?.expires_at_ms;
    record('finalize.ok', { intentId, expiresAtMs });

    // ---- hand off to the human, but only if there is time to use it ------
    //
    // MECHANICAL, not advisory. Past the approval cutoff the signing URL is
    // WITHHELD rather than printed with a warning beside it. A URL that has
    // been displayed has been handed over, and no amount of red text unhands
    // it; the only enforcement a client can actually perform is not to emit it.
    //
    // The server withholds its own handoff too, but at the funding DEADLINE —
    // 120 s too late to help. In the interval between the two it will return a
    // perfectly signable page, so the decision has to be made here.
    //
    // Withholding is the safe failure: nothing is signed, no money moves, and
    // the intent expires unfunded.
    if (opts.postSigningOverridden) {
      record('handoff.post_signing_budget_overridden', {
        derivedMs: REQUIRED_POST_SIGNING_MS, declaredMs: opts.postSigningMs,
      });
      if (opts.postSigningMs < REQUIRED_POST_SIGNING_MS) {
        info(style.red(`post-signing budget lowered to ${opts.postSigningMs}ms `
          + `(derived value is ${REQUIRED_POST_SIGNING_MS}ms).`));
        info(style.dim('The approval cutoff moves later by the difference; so does the risk.'));
      }
    }
    const handoff = windowState({
      now: Date.now(), expiresAtMs, reconcileMs: opts.reconcileMs, postSigningMs: opts.postSigningMs,
    });
    if (!handoff.maySign) {
      record('handoff.withheld', {
        msUntilCutoff: handoff.msUntilCutoff,
        requiredPostSigningMs: opts.postSigningMs,
        pastFundingDeadline: handoff.pastCutoff,
      });
      // Redact in the machine-readable output too. Printing a refusal while
      // returning the URL in JSON would be theatre.
      const redacted = { ...finalized.body, signing_page_url: null, signing: null, funding_actionable: false };
      emitResult({
        intentId, status: 'handoff_withheld', finalize: redacted,
        reason: 'approval_cutoff_passed', recorded: false, runSuccess: false, timeline,
      });
      info('');
      info(style.red('SIGNING HANDOFF WITHHELD — the approval cutoff has already passed.'));
      info(style.dim(`Only ${Math.round(handoff.msUntilCutoff / 1000)}s remain before the funding deadline, and `
        + `${Math.round(opts.postSigningMs / 1000)}s are needed after signing for reserve freshness, `
        + 'confirmation and the executor.'));
      info(style.dim('A payment made now would be on time and still unexecutable. The URL is not shown.'));
      info(style.dim(`Intent ${intentId} will expire unfunded. Nothing was signed and no money moved.`));
      return EXIT.FAILED;
    }

    info('');
    info(style.bold('═══ SIGN NOW ═══'));
    if (finalized.body.signing_page_url) info(finalized.body.signing_page_url);
    info(`memo    claw:w5h:${intentId}:${finalized.body.rule_hash}`);
    info(`amount  ${finalized.body.funding?.amount_raw} raw units`);
    // The number a human should pace against is the approval cutoff, not the
    // funding deadline. Signing at the deadline produces a payment that is
    // on time and still unexecutable.
    info(`approve within  ${Math.round(handoff.msUntilApprovalCutoff / 1000)}s`);
    info(style.dim(`(funding deadline is ${Math.round(handoff.msUntilCutoff / 1000)}s away; the ` +
      `${Math.round(opts.postSigningMs / 1000)}s difference is reserve freshness, confirmation and the executor)`));
    info(style.bold('════════════════'));
    info('');

    if (opts.dryRun) {
      info(style.dim('dry run: not waiting for a signature; the intent will simply expire.'));
      emitResult({ dryRun: true, intentId, finalize: finalized.body, timeline });
      return EXIT.OK;
    }

    // ---- detect the human's signature ------------------------------------
    //
    // Two distinct deadlines, deliberately separated:
    //
    //   signing cutoff        after this, do not sign anything new. It is the
    //                         funding deadline, because a payment made later
    //                         cannot be leased by the executor.
    //   reconciliation window a bounded period PAST the cutoff during which we
    //                         keep looking. A transaction can be on chain and
    //                         on time while the RPC is still slow to list it;
    //                         stopping at the cutoff is how money ends up
    //                         transferred with nothing recorded.
    //
    // Matching is exact: memo, payer signature, transferChecked fields and
    // both balance deltas, bound to the pinned token accounts by index. A
    // near-miss is never accepted, and never stops the search.
    const expectedFunding = {
      memo: `claw:w5h:${intentId}:${finalized.body.rule_hash}`,
      amountRaw: finalized.body.funding?.amount_raw,
      userWallet: opts.userWallet,
      userAta: finalized.body.funding?.user_usdc_ata,
      controlledWallet: RAIL.controlled_wallet,
      controlledAta: RAIL.controlled_usdc_ata,
      mint: finalized.body.funding?.mint,
      decimals: Number(finalized.body.funding?.decimals ?? 6),
      notBeforeSlot,
    };

    const seen = new Set();
    let fundingSignature = null;
    let fundingProof = null;
    let lastReport = 0;
    let warnedApproval = false;
    let warnedCutoff = false;
    // Deadline arithmetic lives in funding-window.mjs, where it is tested
    // against a fake clock. Both previous versions of this logic were wrong
    // at the boundary and both looked correct running against a real one.
    const windowAt = (now = Date.now()) =>
      windowState({ now, expiresAtMs, reconcileMs: opts.reconcileMs, postSigningMs: opts.postSigningMs });

    while (windowAt().keepSearching) {
      const { pastCutoff, maySign, inGracePeriod } = windowAt();
      // The approval cutoff comes FIRST and is the one a human must obey.
      // Approving after it produces a payment that can be perfectly on time
      // and still unexecutable, because nothing downstream has time to run.
      if (!maySign && !warnedApproval) {
        warnedApproval = true;
        record('detect.approval_cutoff_passed', {
          requiredPostSigningMs: opts.postSigningMs,
          enforcement: 'advisory_only_url_already_issued',
        });
        info('');
        info(style.red('APPROVAL CUTOFF PASSED — the signing handoff is now void.'));
        info(style.dim('Too little time remains for reserve freshness, confirmation and the executor.'));
        // Honest about the limit of this particular check. Before the handoff
        // the client can withhold the URL, which is enforcement. Afterwards the
        // URL is in the operator's hands and this is only a message; the
        // mechanical block at that point has to live in the signing page, which
        // is why the page guard re-checks the same cutoff at the wallet call.
        info(style.dim('This message cannot revoke a URL already issued — do not approve in the wallet.'));
        info(style.dim('Any payment already broadcast is still being searched for.'));
      }
      if (inGracePeriod) { /* still searching for an already-broadcast payment */ }
      if (pastCutoff && !warnedCutoff) {
        warnedCutoff = true;
        record('detect.cutoff_passed', {});
        info(style.dim('Funding deadline reached; reconciliation only.'));
      }
      try {
        const rows = await rpc.getSignaturesForAddress(RAIL.controlled_usdc_ata, SIGNATURE_SCAN_LIMIT);
        const matches = await findFundingMatches({
          rows,
          expected: expectedFunding,
          baseline,
          seen,
          getTransaction: (signature) => rpc.getTransaction(signature, 'confirmed').catch(() => null),
        });
        if (matches.length > 1) {
          record('detect.multiple_matches', { signatures: matches.map((m) => m.signature) });
          info(style.red('multiple exact funding payments found; confirming the earliest, then reconcile manually'));
        }
        if (matches.length) {
          matches.sort((a, b) => Number(a.proof.slot) - Number(b.proof.slot));
          fundingSignature = matches[0].signature;
          fundingProof = matches[0].proof;
          break;
        }
      } catch (err) {
        record('detect.rpc_hiccup', { message: err.message });
      }
      if (maySign) {
        // Count down to the APPROVAL cutoff, not the funding deadline: the
        // latter is not the number a human should be pacing against.
        const left = Math.round(windowAt().msUntilApprovalCutoff / 1000);
        if (left !== lastReport && left % 15 === 0) {
          lastReport = left;
          info(style.dim(`waiting for the exact payment… ${left}s left to approve safely`));
        }
      }
      await sleep(opts.pollMs);
    }

    if (!fundingSignature) {
      record('detect.timeout', {});
      emitResult({ intentId, status: 'no_signature_detected', timeline });
      info(style.red('no exact funding payment appeared, including the reconciliation window.'));
      info(style.dim('If you approved in the wallet, do NOT rerun: reconcile that signature by hand.'));
      return EXIT.FAILED;
    }
    const lateBySeconds = Math.round((Date.now() - expiresAtMs) / 1000);
    record('detect.found', { signature: fundingSignature, slot: fundingProof.slot, afterCutoff: lateBySeconds > 0 });
    info(`detected exact payment ${fundingSignature.slice(0, 16)}… (slot ${fundingProof.slot})`);

    // ---- confirm ---------------------------------------------------------
    //
    // Always attempted, even past the cutoff. Money that reached the chain
    // must be recorded: the server decides whether it was on time, from the
    // transaction's own blockTime, and refuses a lease if it was not. Giving
    // up here is what leaves the chain and the database disagreeing.
    //
    // Only ever this one signature. A retry re-sends the same proven payment;
    // it never looks for another and never causes a second transfer.
    // The first attempt is UNCONDITIONAL. Previously the loop was gated on
    // the reconciliation deadline, so a payment proven just as that deadline
    // passed produced zero confirm calls -- money on chain, nothing recorded,
    // which is the exact failure this whole section exists to prevent. Only
    // retries are bounded, by their own budget measured from the proof.
    let confirmation = null;
    let lastStatus = null;
    const provenAt = Date.now();
    for (let attempt = 1; attempt <= 10; attempt++) {
      const decision = shouldAttemptConfirm({
        attempt,
        now: Date.now(),
        provenAt,
        retryMs: CONFIRM_RETRY_MS,
        lastStatus,
        retryableStatuses: RETRYABLE_CONFIRM_STATUSES,
      });
      if (!decision.attempt) {
        record('confirm.stopped', { attempt, reason: decision.reason });
        break;
      }
      confirmation = await session.callTool('confirm_funding', {
        intent_id: intentId,
        tx_signature: fundingSignature,
      });
      lastStatus = confirmation.body?.status ?? null;
      record('confirm.attempt', { attempt, status: lastStatus });
      if (lastStatus === 'budget_reserved') break;
      await sleep(2000);
    }

    // `budget_reserved` alone is not success: the executor still needs both
    // deadlines ahead of it to take a lease. Both stranded amounts from this
    // project reached budget_reserved and neither can ever execute.
    //
    // The whole response is handed over, not just the status. Our clock is the
    // weakest signal available and it cannot see the WatchRule's SLOT deadline
    // at all; the server reports both, and any authoritative sign of lateness
    // wins over a local clock that thinks everything is fine.
    const outcome = describeOutcome({
      confirmStatus: confirmation?.body?.status,
      now: Date.now(),
      expiresAtMs,
      confirmBody: confirmation?.body,
    });
    const { recorded, executable, runSuccess } = outcome;
    const secondsLeft = Math.round((expiresAtMs - Date.now()) / 1000);
    record(outcome.event, {
      secondsLeft, recorded, executable, label: outcome.label,
      authority: outcome.authority, signals: outcome.signals,
    });
    if (outcome.disagreements?.length) {
      record('confirm.server_field_disagreement', { fields: outcome.disagreements });
      info(style.red(`server expiry fields disagree with their own inputs: ${outcome.disagreements.join(', ')}`));
      info(style.dim('Treated as expired. This is a server-side inconsistency worth reporting.'));
    }

    if (isJsonMode()) {
      emitResult({
        intentId,
        signature: fundingSignature,
        proof: fundingProof,
        confirm: confirmation?.body,
        secondsLeft,
        recorded,
        executable,
        runSuccess,
        outcome: outcome.label,
        timeline,
      });
    } else {
      emitResult(confirmation?.body ?? { status: 'unknown' });
      info('');
      if (runSuccess) {
        info(`${style.green('funded')} — ${secondsLeft}s of budget left. The executor should lease within ~5s.`);
      } else if (recorded && outcome.label === 'budget_reserved_unverified') {
        info(style.red('funded and recorded, but NOT provably leasable.'));
        info(style.dim(`${outcome.note}.`));
        info(style.dim(`Signature ${fundingSignature} — verify by hand before assuming it will execute.`));
      } else if (recorded) {
        info(style.red('funded, but past a deadline: the executor cannot lease this intent.'));
        info(style.dim(`Recorded as ${outcome.note}.`));
        if (outcome.signals?.length) info(style.dim(`Expiry signals: ${outcome.signals.join(', ')}.`));
        info(style.dim(`Signature ${fundingSignature} — reconcile by hand, do not rerun.`));
      } else {
        info(style.red('confirm_funding did not reach budget_reserved; inspect the result above'));
        info(style.dim(`The payment is on chain as ${fundingSignature} — reconcile by hand, do not rerun.`));
      }
    }
    // Funds that can never be leased are a failed run, however tidy the
    // bookkeeping. Exiting 0 here would show automation a green light over
    // permanently stranded money.
    return runSuccess ? EXIT.OK : EXIT.FAILED;
  }, { verbose });
}
