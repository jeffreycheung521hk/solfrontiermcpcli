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
  },
  notes: [
    'Start the executor (`solfrontier-mcp watch --execute`) BEFORE this command.',
    'On an empty database it idles safely on "rows": [] and can wait indefinitely.',
    'A payment is accepted only on exact proof: memo, payer signature, transferChecked',
    'fields and both balance deltas, bound to the pinned token accounts by index.',
    'After the signing cutoff the search continues for --reconcile-ms (default 90s),',
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
  return { amount, thresholdBps, userWallet, pollMs, reconcileMs, dryRun: Boolean(flags['dry-run']) };
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
    // Everything already on chain is disqualified from being "this run's"
    // funding. Without this, a previous transaction carrying an identical
    // memo (identical parameters produce an identical intent id) could be
    // mistaken for new money.
    let baseline = new Set();
    if (rpc) {
      const existing = await rpc.getSignaturesForAddress(RAIL.controlled_usdc_ata, 25);
      baseline = new Set(existing.map((s) => s.signature));
      record('baseline.captured', { count: baseline.size });
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

    info('');
    info(style.bold('═══ SIGN NOW ═══'));
    if (finalized.body.signing_page_url) info(finalized.body.signing_page_url);
    info(`memo    claw:w5h:${intentId}:${finalized.body.rule_hash}`);
    info(`amount  ${finalized.body.funding?.amount_raw} raw units`);
    info(`window  ${Math.round((expiresAtMs - Date.now()) / 1000)}s`);
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
    };

    const seen = new Set();
    let fundingSignature = null;
    let fundingProof = null;
    let lastReport = 0;
    let warnedCutoff = false;
    const reconcileUntil = expiresAtMs + opts.reconcileMs;

    while (Date.now() < reconcileUntil) {
      const pastCutoff = Date.now() >= expiresAtMs;
      if (pastCutoff && !warnedCutoff) {
        warnedCutoff = true;
        record('detect.cutoff_passed', {});
        info('');
        info(style.yellow('SIGNING CUTOFF PASSED. Do not approve anything now.'));
        info(style.dim('Still searching for an already-broadcast payment so it cannot be lost.'));
      }
      try {
        const rows = await rpc.getSignaturesForAddress(RAIL.controlled_usdc_ata, 100);
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
      if (!pastCutoff) {
        const left = Math.round((expiresAtMs - Date.now()) / 1000);
        if (left !== lastReport && left % 15 === 0) {
          lastReport = left;
          info(style.dim(`waiting for the exact payment… ${left}s left to sign`));
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
    let confirmation = null;
    for (let attempt = 1; attempt <= 10 && Date.now() < reconcileUntil; attempt++) {
      confirmation = await session.callTool('confirm_funding', {
        intent_id: intentId,
        tx_signature: fundingSignature,
      });
      const status = confirmation.body?.status;
      record('confirm.attempt', { attempt, status });
      if (status === 'budget_reserved') break;
      if (status && !RETRYABLE_CONFIRM_STATUSES.has(status)) break;
      await sleep(2000);
    }

    const ok = confirmation?.body?.status === 'budget_reserved';
    const secondsLeft = Math.round((expiresAtMs - Date.now()) / 1000);
    const executable = ok && secondsLeft > 0;
    record(ok ? 'confirm.ok' : 'confirm.failed', { secondsLeft, executable });

    if (isJsonMode()) {
      emitResult({
        intentId,
        signature: fundingSignature,
        proof: fundingProof,
        confirm: confirmation?.body,
        secondsLeft,
        executable,
        timeline,
      });
    } else {
      emitResult(confirmation?.body ?? { status: 'unknown' });
      info('');
      if (executable) {
        info(`${style.green('funded')} — ${secondsLeft}s of budget left. The executor should lease within ~5s.`);
      } else if (ok) {
        info(style.yellow('funded, but past the funding deadline: the executor cannot lease this intent.'));
        info(style.dim('Record it as budget_reserved (expired, unexecutable, manual reconciliation required).'));
      } else {
        info(style.red('confirm_funding did not reach budget_reserved; inspect the result above'));
        info(style.dim(`The payment is on chain as ${fundingSignature} — reconcile by hand, do not rerun.`));
      }
    }
    return ok ? EXIT.OK : EXIT.FAILED;
  }, { verbose });
}
