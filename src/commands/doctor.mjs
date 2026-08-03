// `doctor` — one command that answers "will a run work right now?"
//
// This exists because of a specific, documented failure: on 2026-08-01 a
// mainnet acceptance run was lost not to a bug but to ordering and timing.
// Every check below is a lesson from that afternoon, made mechanical:
//
//   * is the binary there and does it actually complete a handshake?
//   * is the database real, writable, and migrated — or a zero-byte file
//     that will make the first scan fail?
//   * is the RPC endpoint configured at all?
//   * is the Solend reserve fresh enough to satisfy the executor's 16-slot
//     gate right now, and how often has it been fresh recently?
//   * does the current supply APY clear the threshold you plan to use?
//   * is a wallet keypair sitting in this environment when it should not be?
//
// Exit 0 means GO. Exit 1 means NO-GO with the reasons enumerated.
import { existsSync, statSync } from 'node:fs';
import { withSession } from '../mcp/session.mjs';
import { SolanaRpc } from '../solana/rpc.mjs';
import { readReserveSnapshot, MAX_RESERVE_STALENESS_SLOTS } from '../solana/solend.mjs';
import { emitResult, info, table, style, isJsonMode } from '../cli/output.mjs';
import { EXIT, UsageError } from '../cli/exit-codes.mjs';

export const spec = {
  name: 'doctor',
  summary: 'Preflight every precondition for a run and report GO / NO-GO',
  usage: 'doctor [--threshold-bps 90] [--sample-seconds 30]',
  options: {
    'threshold-bps': { type: 'string' },
    'sample-seconds': { type: 'string' },
  },
};

const PASS = 'pass';
const WARN = 'warn';
const FAIL = 'fail';

function check(name, status, detail) {
  return { name, status, detail };
}

export async function run({ config, flags, verbose }) {
  const checks = [];
  const thresholdBps = flags['threshold-bps'] !== undefined ? Number(flags['threshold-bps']) : null;
  if (thresholdBps !== null && (!Number.isInteger(thresholdBps) || thresholdBps < 1 || thresholdBps > 10000)) {
    throw new UsageError('--threshold-bps must be an integer 1..10000');
  }
  const sampleSeconds = Number(flags['sample-seconds'] ?? 0);
  if (!Number.isFinite(sampleSeconds) || sampleSeconds < 0 || sampleSeconds > 600) {
    throw new UsageError('--sample-seconds must be between 0 and 600');
  }

  // ---- 1. binary ---------------------------------------------------------
  if (!existsSync(config.serverBin)) {
    checks.push(check('server binary', FAIL, `not found: ${config.serverBin}`));
  } else {
    const size = statSync(config.serverBin).size;
    checks.push(check('server binary', PASS, `${config.serverBin} (${size.toLocaleString()} bytes)`));
  }

  // ---- 2. database -------------------------------------------------------
  if (!existsSync(config.dbPath)) {
    checks.push(check('database file', WARN, `${config.dbPath} does not exist yet — the server will create it`));
  } else {
    const size = statSync(config.dbPath).size;
    checks.push(
      size === 0
        ? check('database file', WARN, 'zero bytes: not yet migrated. Run any command once so the server applies migrations.')
        : check('database file', PASS, `${config.dbPath} (${size.toLocaleString()} bytes, migrated)`),
    );
  }

  // ---- 3. handshake ------------------------------------------------------
  let tools = [];
  if (existsSync(config.serverBin)) {
    try {
      await withSession(config, async (session) => {
        tools = await session.listTools();
        checks.push(
          check('MCP handshake', PASS, `${session.serverInfo?.name} ${session.serverInfo?.version}, ${tools.length} tools`),
        );
      }, { verbose });
    } catch (err) {
      checks.push(check('MCP handshake', FAIL, err.message));
    }
  }

  // ---- 4. environment ----------------------------------------------------
  checks.push(
    config.rpcUrlPresent
      ? check('SOLFRONTIER_RPC_URL', PASS, 'set (value never displayed)')
      : check('SOLFRONTIER_RPC_URL', WARN, 'not set — chain reads and finalize will return config_missing'),
  );

  // A keypair in this environment is not dangerous by itself: this client
  // never spawns the executor. But it means the shell is one command away
  // from being an execution environment, and that deserves to be said.
  checks.push(
    config.controlledKeypairEnvPresent
      ? check(
          'controlled wallet keypair',
          WARN,
          'SOLFRONTIER_CONTROLLED_WALLET_KEYPAIR is set in this environment. This CLI never spawns the executor, but consider using a shell without it.',
        )
      : check('controlled wallet keypair', PASS, 'not present in this environment'),
  );

  // ---- 5. chain conditions ----------------------------------------------
  let reserve = null;
  if (config.rpcUrlPresent) {
    try {
      const rpc = new SolanaRpc({ timeoutMs: config.timeoutMs });
      reserve = await readReserveSnapshot(rpc);
      // The reason has to be derived from the same predicate that chose the
      // branch. `fresh` is three conditions -- the explicit stale bit clear AND
      // a slot age within the gate -- so blaming age alone was wrong whenever
      // the stale bit was what failed: a reserve at age 0 with a refresh
      // pending was reported as "age 0 slots exceeds the 16-slot gate", which
      // is not true and sends the reader to the wrong cause. The demo harness
      // learned the three-part definition in 9b5274c; the product did not,
      // which is the same shape as the fix that stayed in the harness while
      // the product kept the defect that lost money.
      const staleBitSet = reserve.staleFlag === true;
      const ageOverGate = !(reserve.ageSlots >= 0 && reserve.ageSlots <= MAX_RESERVE_STALENESS_SLOTS);
      const reason = staleBitSet && ageOverGate
        ? `the reserve's stale bit is set and age ${reserve.ageSlots} is outside 0..${MAX_RESERVE_STALENESS_SLOTS}`
        : staleBitSet
          ? `the reserve's stale bit is set (age ${reserve.ageSlots} is within the gate; a refresh is pending)`
          : `age ${reserve.ageSlots} slots is outside 0..${MAX_RESERVE_STALENESS_SLOTS}`;
      checks.push(
        reserve.fresh
          ? check('reserve freshness', PASS, `stale bit clear, age ${reserve.ageSlots} slots (limit ${MAX_RESERVE_STALENESS_SLOTS}) — executable right now`)
          : check(
              'reserve freshness',
              WARN,
              `not fresh: ${reason}. The executor will wait, and retry safely, until a refresh lands.`,
            ),
      );
      checks.push(
        check('supply APY', PASS, `${reserve.supplyAprBps} bps (${reserve.supplyAprPct}%), utilization ${reserve.utilizationPct}%`),
      );
      if (thresholdBps !== null) {
        checks.push(
          reserve.supplyAprBps > thresholdBps
            ? check('condition vs threshold', PASS, `${reserve.supplyAprBps} bps > ${thresholdBps} bps — condition is met`)
            : check(
                'condition vs threshold',
                FAIL,
                `${reserve.supplyAprBps} bps is NOT above ${thresholdBps} bps — the executor would never fire. Lower the threshold or wait.`,
              ),
        );
      }
    } catch (err) {
      checks.push(check('chain read', FAIL, err.message));
    }
  }

  // ---- 6. optional freshness sampling ------------------------------------
  // The 2026-08-01 measurement found the reserve fresh only ~13% of the time.
  // Sampling turns that from folklore into a number for *your* run, today.
  let sampling = null;
  if (sampleSeconds > 0 && config.rpcUrlPresent) {
    info(style.dim(`sampling reserve freshness for ${sampleSeconds}s...`));
    const rpc = new SolanaRpc({ timeoutMs: config.timeoutMs });
    const started = Date.now();
    const samples = [];
    while (Date.now() - started < sampleSeconds * 1000) {
      try {
        const snap = await readReserveSnapshot(rpc);
        samples.push({ ageSlots: snap.ageSlots, fresh: snap.fresh });
      } catch {
        /* transient RPC hiccup: keep sampling */
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    const eligible = samples.filter((s) => s.fresh).length;
    const pct = samples.length ? Math.round((eligible / samples.length) * 100) : 0;
    sampling = {
      seconds: sampleSeconds,
      samples: samples.length,
      eligible,
      eligiblePct: pct,
      medianAgeSlots: samples.length
        ? samples.map((s) => s.ageSlots).sort((a, b) => a - b)[Math.floor(samples.length / 2)]
        : null,
    };
    checks.push(
      check(
        'freshness over time',
        pct > 0 ? PASS : WARN,
        `${eligible}/${samples.length} samples eligible (${pct}%), median age ${sampling.medianAgeSlots} slots`,
      ),
    );
  }

  // ---- verdict -----------------------------------------------------------
  const failures = checks.filter((c) => c.status === FAIL);
  const warnings = checks.filter((c) => c.status === WARN);
  const verdict = failures.length === 0 ? 'GO' : 'NO-GO';

  if (isJsonMode()) {
    emitResult({ verdict, checks, reserve, sampling });
  } else {
    table(
      ['', 'check', 'detail'],
      checks.map((c) => [
        c.status === PASS ? style.green('PASS') : c.status === WARN ? style.yellow('WARN') : style.red('FAIL'),
        c.name,
        c.detail,
      ]),
    );
    info('');
    info(
      verdict === 'GO'
        ? `${style.green('GO')} — ${checks.length - warnings.length} checks clean${warnings.length ? `, ${warnings.length} warning(s)` : ''}`
        : `${style.red('NO-GO')} — ${failures.length} blocking failure(s)`,
    );
    if (verdict === 'GO') {
      info('');
      info(style.dim('Reminder: start `watch --execute` BEFORE finalize. On an empty database it'));
      info(style.dim('idles safely on "rows": [], so it can wait as long as you need.'));
    }
  }
  return verdict === 'GO' ? EXIT.OK : EXIT.FAILED;
}
