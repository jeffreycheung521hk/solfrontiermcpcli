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
  },
  notes: [
    'Start the executor (`solfrontier-mcp watch --execute`) BEFORE this command.',
    'On an empty database it idles safely on "rows": [] and can wait indefinitely.',
  ],
};

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

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
  return { amount, thresholdBps, userWallet, pollMs, dryRun: Boolean(flags['dry-run']) };
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
    let fundingSignature = null;
    let lastReport = 0;
    while (Date.now() < expiresAtMs - 3000) {
      try {
        const sigs = await rpc.getSignaturesForAddress(RAIL.controlled_usdc_ata, 25);
        const fresh = sigs.filter((s) => !baseline.has(s.signature) && !s.err);
        if (fresh.length) {
          fundingSignature = fresh[fresh.length - 1].signature;
          break;
        }
      } catch (err) {
        record('detect.rpc_hiccup', { message: err.message });
      }
      const left = Math.round((expiresAtMs - Date.now()) / 1000);
      if (left !== lastReport && left % 15 === 0) {
        lastReport = left;
        info(style.dim(`waiting for signature… ${left}s left`));
      }
      await sleep(opts.pollMs);
    }

    if (!fundingSignature) {
      record('detect.timeout', {});
      emitResult({ intentId, status: 'no_signature_detected', timeline });
      info(style.red('no funding signature arrived before the deadline; the intent expires unfunded'));
      return EXIT.FAILED;
    }
    record('detect.found', { signature: fundingSignature });
    info(`detected ${fundingSignature.slice(0, 16)}…`);

    // ---- confirm ---------------------------------------------------------
    let confirmation = null;
    for (let attempt = 1; attempt <= 10 && Date.now() < expiresAtMs - 1000; attempt++) {
      confirmation = await session.callTool('confirm_funding', {
        intent_id: intentId,
        tx_signature: fundingSignature,
      });
      const status = confirmation.body?.status;
      record('confirm.attempt', { attempt, status });
      if (status && status !== 'pending' && status !== 'not_yet_confirmed') break;
      await sleep(2000);
    }

    const ok = confirmation?.body?.status === 'budget_reserved';
    const secondsLeft = Math.round((expiresAtMs - Date.now()) / 1000);
    record(ok ? 'confirm.ok' : 'confirm.failed', { secondsLeft });

    if (isJsonMode()) {
      emitResult({ intentId, signature: fundingSignature, confirm: confirmation?.body, secondsLeft, timeline });
    } else {
      emitResult(confirmation?.body ?? { status: 'unknown' });
      info('');
      info(
        ok
          ? `${style.green('funded')} — ${secondsLeft}s of budget left. The executor should lease within ~5s.`
          : style.red('confirm_funding did not reach budget_reserved; inspect the result above'),
      );
    }
    return ok ? EXIT.OK : EXIT.FAILED;
  }, { verbose });
}
