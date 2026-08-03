// Zero-fund demonstration driver.
//
// Runs the commands that read the real Solana mainnet and the real concluded
// MCP server, and NOTHING that can move money. Node rather than PowerShell on
// purpose: the historical Demo.ps1 lost time to ANSI-vs-UTF-8 decoding, $null
// marshalling and native-command quoting, none of which exist here.
//
// What this deliberately does NOT do, and why:
//
//   * It never passes --user-wallet. `flow --dry-run --user-wallet` performs a
//     REAL finalize: it writes a database row, starts the 180-second funding
//     clock and prints a genuinely signable URL. That is an acceptance, not a
//     demonstration, and it is gated behind the refund work.
//   * It never runs `watch`, with or without --execute.
//   * It never reads a keypair. The controlled wallet's key belongs to the
//     executor, which is a separate operator-launched process.
//
// The argv of every spawned command is checked against those rules immediately
// before spawning, so editing a stage cannot quietly turn this into a run that
// spends money.
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const CLI = path.join(ROOT, 'src', 'index.mjs');
const SERVER_REPO = path.join(path.dirname(ROOT), 'solfrontiermcpskeleton');

// Any of these appearing in a spawned argv aborts the run.
const FORBIDDEN = [/^--user-wallet$/, /^watch$/, /^--execute$/, /^--yes$/];

// The exit-code contract from src/cli/exit-codes.mjs. Stages assert the exact
// code, so "it refused" and "it crashed" can never be confused.
const EXIT_OK = 0;      // did what was asked
const EXIT_FAILED = 1;  // ran, and the answer is no

let failures = 0;

const color = process.env.NO_COLOR ? null : {
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};
const c = new Proxy({}, { get: (_, k) => (s) => (color ? color[k](s) : s) });

const timings = [];

function banner(n, title, proves) {
  console.log('');
  console.log(c.bold(`=== ${n}. ${title} ${'='.repeat(Math.max(0, 58 - title.length - String(n).length))}`));
  console.log(c.dim(`    proves: ${proves}`));
  console.log('');
}

/**
 * Spawn the CLI, streaming output, and time it. Never shell:true.
 *
 * `expect` is the exit code this stage is supposed to produce, and it is
 * checked for equality rather than for mere non-zero-ness. The first version of
 * this file used a boolean `expectFailure`, and when the entry-point path was
 * wrong every stage died with exit 1 -- so the two stages that were meant to
 * demonstrate a refusal reported themselves green while proving nothing at all.
 * A demonstration whose failure cases pass for the wrong reason is worse than
 * one with no failure cases.
 */
function runCli(args, { label, expect = EXIT_OK } = {}) {
  for (const arg of args) {
    for (const rule of FORBIDDEN) {
      if (rule.test(arg)) {
        console.error(c.red(`ABORT: "${arg}" is forbidden in a zero-fund demonstration.`));
        process.exit(2);
      }
    }
  }
  console.log(c.cyan(`$ sfcli ${args.join(' ')}`));
  console.log('');
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: ROOT, stdio: 'inherit' });
    child.on('close', (code) => {
      const ms = Date.now() - started;
      const ok = code === expect;
      timings.push({ label: label ?? args[0], ms, code, expect, ok });
      failures += ok ? 0 : 1;
      console.log('');
      console.log(
        ok ? c.green(`    [as expected] exit ${code} in ${(ms / 1000).toFixed(1)}s`)
          : c.red(`    [WRONG] exit ${code}, expected ${expect}, in ${(ms / 1000).toFixed(1)}s`),
      );
      resolve(code);
    });
  });
}

function sha256(file) {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

async function main() {
  const configPath = process.env.SFCLI_CONFIG ?? path.join(ROOT, 'sfcli.config.json');
  const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {};
  const serverBin = process.env.SFCLI_BIN ?? config.serverBin;
  const hasRpc = Boolean((process.env.SOLFRONTIER_RPC_URL ?? '').trim());
  const hasKeypair = Boolean((process.env.SOLFRONTIER_CONTROLLED_WALLET_KEYPAIR ?? '').trim());

  console.log(c.bold('solfrontier-cli - zero-fund demonstration'));
  console.log('');
  console.log('  This run reads mainnet and the concluded MCP server.');
  console.log('  It cannot move money: no wallet is passed, no keypair is read,');
  console.log('  no signing handoff is produced, and the executor is never started.');
  console.log('');

  // ---- preconditions ----------------------------------------------------
  const digest = serverBin ? sha256(serverBin) : null;
  console.log(c.dim(`  server binary : ${serverBin ?? '(not configured)'}`));
  console.log(c.dim(`  sha-256       : ${digest ?? '(unreadable)'}`));
  console.log(c.dim(`  scratch db    : ${config.dbPath ?? 'scratch/dev.db'}`));
  console.log(c.dim(`  rpc url set   : ${hasRpc ? 'yes (value never printed)' : 'NO - live stages will be skipped'}`));
  console.log(c.dim(`  keypair in env: ${hasKeypair ? 'YES' : 'no (correct for a demo)'}`));

  if (!serverBin || !digest) {
    console.error(c.red('\nNo readable server binary. Set serverBin in sfcli.config.json or SFCLI_BIN.'));
    process.exit(2);
  }
  if (hasKeypair) {
    // Refusing is the point: a demo shell holding the controlled wallet's key
    // is one typo away from being an execution shell.
    console.error(c.red('\nABORT: SOLFRONTIER_CONTROLLED_WALLET_KEYPAIR is set in this shell.'));
    console.error(c.dim('A demonstration must not run where the signing key is reachable. Use a clean shell.'));
    process.exit(2);
  }
  mkdirSync(path.join(ROOT, 'scratch'), { recursive: true });

  // ---- 1. the wire ------------------------------------------------------
  banner(1, 'the protocol works', 'MCP stdio handshake against the real server binary');
  await runCli(['tools', 'list']);

  // ---- 2. can it say yes? -----------------------------------------------
  if (hasRpc) {
    banner(2, 'preflight against live mainnet', 'real chain reads: reserve freshness, supply APY, slot clock');
    await runCli(['doctor', '--threshold-bps', '50']);

    // ---- 3. can it say no? ----------------------------------------------
    banner(3, 'a condition that cannot be met', 'the gate can refuse, which is the only reason a pass means anything');
    await runCli(['doctor', '--threshold-bps', '9999'], { label: 'doctor (impossible)', expect: EXIT_FAILED });

    // ---- 4. the ledger, re-derived --------------------------------------
    const acceptance = path.join(SERVER_REPO, 'docs', 'phase3b-2-mainnet-acceptance.en.md');
    if (existsSync(acceptance)) {
      banner(4, 'audit a published acceptance record', 'claims in the document re-derived from the chain, not trusted');
      await runCli(['audit', acceptance]);
    } else {
      console.log(c.dim(`\n(4 skipped: ${acceptance} not found)`));
    }

    // ---- 5. the funding sequence, up to the last safe step ---------------
    banner(5, 'the funding sequence, dry', 'preflight + propose + canonical draft hash, with no database row');
    console.log(c.dim('    Stops before finalize on purpose: finalize writes a row, starts the'));
    console.log(c.dim('    180s clock and emits a signable URL. Without --user-wallet it cannot.'));
    console.log('');
    await runCli(['flow', '--dry-run', '--amount', '0.2', '--threshold-bps', '1']);

    // ---- 6. refusing to propose ------------------------------------------
    banner(6, 'refusing to spend a window it cannot win', 'flow exits before proposing when the condition is impossible');
    await runCli(
      ['flow', '--dry-run', '--amount', '0.2', '--threshold-bps', '9999'],
      { label: 'flow (impossible)', expect: EXIT_FAILED },
    );
  } else {
    console.log(c.red('\nSOLFRONTIER_RPC_URL is not set; stages 2-6 need the chain and are skipped.'));
  }

  // ---- 7. what is proven without the chain ------------------------------
  banner(7, 'the offline suite', 'every deadline, proof and failure mode, with no network and no money');
  await runCli(['--version'], { label: 'version' });
  console.log(c.dim('    (run `npm test` for the full suite: 164 tests, all offline)'));

  // ---- summary -----------------------------------------------------------
  const total = timings.reduce((a, t) => a + t.ms, 0);
  console.log('');
  console.log(c.bold('=== summary ============================================================'));
  for (const t of timings) {
    const mark = t.ok ? '  ok ' : ' WRONG';
    console.log(`  ${mark} ${t.label.padEnd(22)} exit ${String(t.code).padEnd(3)} (want ${t.expect})  ${(t.ms / 1000).toFixed(1)}s`);
  }
  console.log(`       ${'TOTAL'.padEnd(22)}                  ${(total / 1000).toFixed(1)}s`);
  console.log('');
  console.log(c.dim('  No transaction was built, signed or broadcast. No funding row was created.'));
  console.log(c.dim('  See docs/DEMO.md for what each stage proves and what it does not.'));

  // The demonstration is itself a check, so it has to be able to fail. Exiting
  // 0 after a stage produced the wrong code would make this a slideshow.
  if (failures > 0) {
    console.log('');
    console.log(c.red(`  ${failures} stage(s) did not produce the expected exit code.`));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(c.red(`\ndemonstration failed: ${err.message}`));
  process.exit(1);
});
