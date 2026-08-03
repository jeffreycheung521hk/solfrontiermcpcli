// Hermetic end-to-end regression for the funding orchestration.
//
// Runs the real `flow` command against a fake MCP server and a fake Solana
// RPC on loopback: no network, no chain, no money. What it proves is the
// chain of custody the 2026-08-02 incident broke —
//
//     signature row -> selection -> fetch -> exact proof -> confirm_funding
//                   -> budget_reserved, reported honestly
//
// Where this stops: the executor (`watch --execute`) is a separate process
// owned by the server repository, and this CLI never executes anything. So
// the last link asserted here is whether a lease is still POSSIBLE, which is
// what flow reports. Simulating the executor itself would be theatre.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { startFakeRpc } from './fake-rpc-server.mjs';
import { CLI, ROOT } from './helpers.mjs';

const FIXTURE = JSON.parse(
  readFileSync(path.join(ROOT, 'scripts', 'demo', 'fixtures', 'funding-20260802.json'), 'utf8'),
);
const FAKE_SERVER = path.join(ROOT, 'test', 'fake-solfrontier-server.mjs');
const USER_WALLET = 'C4QQjzWxnJ5QFAbkzhQJ3wTzyX6nw1vyFvJwbPXJGPNW';

/** Run the real flow command against fakes; returns parsed --json output. */
async function runFlow({ rpcUrl, serverFlags = [], flowFlags = [] }) {
  const dir = await mkdtemp(path.join(tmpdir(), 'sfcli-orch-'));
  const configPath = path.join(dir, 'sfcli.config.json');
  await writeFile(configPath, JSON.stringify({
    serverBin: process.execPath,
    serverArgs: [FAKE_SERVER, ...serverFlags],
    dbPath: path.join(dir, 'scratch.db'),
  }));
  try {
    const result = await new Promise((resolve) => {
      execFile(process.execPath, [
        CLI, 'flow',
        '--amount', '0.2', '--threshold-bps', '88',
        '--user-wallet', USER_WALLET,
        '--yes', '--json', '--quiet', '--color', 'never',
        '--poll-ms', '250',
        ...flowFlags,
      ], {
        cwd: ROOT,
        // A hang here is a bug, not a slow test: fail fast with stderr rather
        // than stalling the suite for a whole funding window.
        timeout: 45_000,
        env: {
          ...process.env,
          SFCLI_CONFIG: configPath,
          SOLFRONTIER_RPC_URL: rpcUrl,
          NO_COLOR: '1',
        },
      }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }));
    });
    let body = null;
    try { body = JSON.parse(result.stdout); } catch { /* left null for the test to report */ }
    return { ...result, body };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A signature row/transaction pair derived from the real captured payload. */
function stagedPayment({ slot }) {
  const tx = JSON.parse(JSON.stringify(FIXTURE.transaction));
  tx.slot = slot;
  return { row: { ...FIXTURE.row, slot }, transaction: tx };
}

/**
 * Reveal a payment from the Nth getSignaturesForAddress call onward.
 *
 * Counting calls rather than sleeping keeps the staging deterministic: call 1
 * is always the baseline capture, so "visible from call 2" reliably means
 * "appeared after the baseline" without racing a wall clock.
 */
function revealFrom(nth, rows) {
  let call = 0;
  return () => (++call >= nth ? rows : []);
}

describe('funding orchestration, end to end', () => {
  // Most tests below need a funding window measured in seconds so they finish
  // quickly, which is shorter than the 120s approval cutoff -- so they declare
  // `--post-signing-ms 0` to isolate whichever gate they are actually testing.
  // The first test deliberately does NOT: it runs the real default end to end.
  const NO_CUTOFF = ['--post-signing-ms', '0'];

  test('a payment listed promptly is proven and confirmed, at the real cutoff', async () => {
    // Realistic window and the DERIVED post-signing budget, so the default
    // configuration is proven rather than only its relaxed variant. It still
    // finishes in about a second: the payment appears on the second poll.
    const slot = 1000;
    const payment = stagedPayment({ slot: 1010 });
    const rpc = await startFakeRpc({
      slot: () => slot,
      signatureRows: revealFrom(2, [payment.row]), // call 1 is the baseline
      transaction: (sig) => (sig === payment.row.signature ? payment.transaction : null),
    });
    try {
      const r = await runFlow({
        rpcUrl: rpc.url,
        serverFlags: ['--window-ms', '200000'],
        flowFlags: ['--reconcile-ms', '3000'],
      });
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);
      assert.equal(r.body.confirm.status, 'budget_reserved');
      assert.equal(r.body.signature, payment.row.signature);
      assert.equal(r.body.executable, true);
      assert.equal(r.body.runSuccess, true);
      assert.equal(r.body.proof.controlledDelta, '200000');
      assert.equal(r.body.proof.userDelta, '-200000');
      assert.match(r.stderr, /"type":"confirm\.ok"/);
    } finally {
      await rpc.close();
    }
  });

  test('the signing handoff is withheld once the approval cutoff has passed', async () => {
    // The window is far shorter than the post-signing budget, so there is no
    // safe moment to sign at all. The URL must never be shown -- on the
    // terminal or in the JSON. Printing it with a warning beside it would be
    // handing it over and then asking nicely.
    const rpc = await startFakeRpc({
      slot: () => 1000,
      signatureRows: () => [],
      transaction: () => null,
    });
    try {
      const r = await runFlow({
        rpcUrl: rpc.url,
        serverFlags: ['--window-ms', '5000'],
        flowFlags: ['--reconcile-ms', '1000'],
      });
      assert.notEqual(r.code, 0, 'withholding the handoff is a failed run');
      assert.equal(r.body?.status, 'handoff_withheld', `stderr: ${r.stderr}`);
      assert.equal(r.body.reason, 'approval_cutoff_passed');
      assert.match(r.stderr, /"type":"handoff\.withheld"/);
      // The whole point: the signable URL is gone from every output channel.
      const everything = `${r.stdout}\n${r.stderr}`;
      assert.ok(!everything.includes('#payload='), 'the signing URL must not be emitted anywhere');
      assert.equal(r.body.finalize.signing_page_url, null);
      assert.equal(r.body.finalize.funding_actionable, false);
      // And nothing was searched for, because nothing could have been signed.
      assert.ok(!r.stderr.includes('"type":"detect.found"'));
    } finally {
      await rpc.close();
    }
  });

  test('a payment past the WatchRule SLOT deadline does not exit green', async () => {
    // Our wall clock says there is plenty of time; the slot clock -- which this
    // client cannot evaluate for itself -- says the executor can never lease it.
    // The server's verdict has to win.
    const payment = stagedPayment({ slot: 1010 });
    const rpc = await startFakeRpc({
      slot: () => 1000,
      signatureRows: revealFrom(2, [payment.row]),
      transaction: (sig) => (sig === payment.row.signature ? payment.transaction : null),
    });
    try {
      const r = await runFlow({
        rpcUrl: rpc.url,
        serverFlags: ['--window-ms', '200000', '--slot-expired'],
        flowFlags: ['--reconcile-ms', '3000'],
      });
      assert.equal(r.body?.confirm?.status, 'budget_reserved', `stderr: ${r.stderr}`);
      assert.equal(r.body.recorded, true, 'the payment still has to be recorded');
      assert.equal(r.body.runSuccess, false);
      assert.notEqual(r.code, 0, 'a passed slot deadline must not exit 0');
      assert.match(r.stderr, /"type":"confirm\.recorded_but_expired"/);
      assert.ok(!r.stderr.includes('"type":"confirm.ok"'));
    } finally {
      await rpc.close();
    }
  });

  test('a server that omits the slot fields yields unverified, not success', async () => {
    // expired_at_funding_slot is false when no slot was observed, which is
    // indistinguishable from a genuine pass. Absence of evidence is not a
    // green light.
    const payment = stagedPayment({ slot: 1010 });
    const rpc = await startFakeRpc({
      slot: () => 1000,
      signatureRows: revealFrom(2, [payment.row]),
      transaction: (sig) => (sig === payment.row.signature ? payment.transaction : null),
    });
    try {
      const r = await runFlow({
        rpcUrl: rpc.url,
        serverFlags: ['--window-ms', '200000', '--no-tx-slot'],
        flowFlags: ['--reconcile-ms', '3000'],
      });
      assert.equal(r.body?.confirm?.status, 'budget_reserved', `stderr: ${r.stderr}`);
      assert.equal(r.body.outcome, 'budget_reserved_unverified');
      assert.equal(r.body.runSuccess, false);
      assert.notEqual(r.code, 0);
      assert.match(r.stderr, /"type":"confirm\.recorded_but_unverified"/);
    } finally {
      await rpc.close();
    }
  });

  test('a payment the RPC lists only after the cutoff is still recorded', async () => {
    // The 2026-08-02 shape. The money is on chain and on time; the RPC is
    // slow. A client that stops at the cutoff loses it.
    const slot = 2000;
    const payment = stagedPayment({ slot: 2010 });
    // The window is 1500 ms and polling is every 250 ms, so revealing the
    // payment from the 15th call onward puts it firmly past the cutoff while
    // still inside the reconciliation window.
    const rpc = await startFakeRpc({
      slot: () => slot,
      signatureRows: revealFrom(15, [payment.row]),
      transaction: (sig) => (sig === payment.row.signature ? payment.transaction : null),
    });
    try {
      const r = await runFlow({
        rpcUrl: rpc.url,
        serverFlags: ['--window-ms', '1500'],
        flowFlags: ['--reconcile-ms', '20000', ...NO_CUTOFF],
      });
      assert.equal(r.body?.confirm?.status, 'budget_reserved', `stderr: ${r.stderr}`);
      // Recorded -- the chain and the ledger must agree -- but the deadline
      // has passed, so the run did NOT succeed. This is exactly the state
      // both stranded amounts are in.
      assert.equal(r.body.recorded, true);
      assert.equal(r.body.executable, false);
      assert.equal(r.body.runSuccess, false);
      // A non-zero exit is the part automation actually reads. Exiting 0
      // here would show a green light over permanently stranded money.
      assert.notEqual(r.code, 0, 'an unexecutable outcome must not exit 0');
      // --quiet suppresses the human commentary, so assert on the structured
      // event stream, which is what an audit would read anyway.
      assert.match(r.stderr, /"type":"detect\.cutoff_passed"/);
      assert.match(r.stderr, /"type":"confirm\.recorded_but_expired"/);
      assert.ok(!r.stderr.includes('"type":"confirm.ok"'), 'must not emit a success event');
    } finally {
      await rpc.close();
    }
  });

  test('an unrelated transaction on the same account is never confirmed', async () => {
    // A wrong signature would be rejected by the server, but the damage is
    // that the client stops looking. It must keep searching instead.
    let slot = 3000;
    const decoy = stagedPayment({ slot: 3010 });
    decoy.row.signature = 'DecoySignature1111111111111111111111111111111111111111111111111111111111111111111111111';
    decoy.transaction.transaction.message.instructions =
      decoy.transaction.transaction.message.instructions.filter((i) => i.programId !== 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
    const rpc = await startFakeRpc({
      slot: () => slot,
      signatureRows: () => [decoy.row],
      transaction: () => decoy.transaction,
    });
    try {
      const r = await runFlow({
        rpcUrl: rpc.url,
        serverFlags: ['--window-ms', '1500'],
        flowFlags: ['--reconcile-ms', '1500', ...NO_CUTOFF],
      });
      assert.equal(r.code, 1);
      assert.equal(r.body?.status, 'no_signature_detected');
      assert.ok(!JSON.stringify(r.body).includes('budget_reserved'));
    } finally {
      await rpc.close();
    }
  });

  test('a payment older than the intent is refused as a replay', async () => {
    // Same memo, same amount, same payer -- but it happened before this
    // intent existed. Deterministic intent ids make this a real hazard.
    let slot = 5000;
    const old = stagedPayment({ slot: 4000 }); // below the floor captured at start
    const rpc = await startFakeRpc({
      slot: () => slot,
      signatureRows: () => [old.row],
      transaction: () => old.transaction,
    });
    try {
      const r = await runFlow({
        rpcUrl: rpc.url,
        serverFlags: ['--window-ms', '1500'],
        flowFlags: ['--reconcile-ms', '1500', ...NO_CUTOFF],
      });
      assert.equal(r.code, 1, 'an old payment must not satisfy a new intent');
      assert.equal(r.body?.status, 'no_signature_detected');
    } finally {
      await rpc.close();
    }
  });

  test('a still-confirming payment is retried with the same signature', async () => {
    const slot = 6000;
    const payment = stagedPayment({ slot: 6010 });
    const rpc = await startFakeRpc({
      slot: () => slot,
      // Must not exist at baseline capture, or it is correctly excluded as a
      // pre-run transaction and never considered again.
      signatureRows: revealFrom(2, [payment.row]),
      transaction: () => payment.transaction,
    });
    try {
      const r = await runFlow({
        rpcUrl: rpc.url,
        serverFlags: ['--confirm-fails', '2', '--window-ms', '15000'],
        flowFlags: ['--reconcile-ms', '3000', ...NO_CUTOFF],
      });
      assert.equal(r.body?.confirm?.status, 'budget_reserved', `stderr: ${r.stderr}`);
      assert.equal(r.body.confirm.confirm_call_count, 3, 'should have retried the same signature twice');
      assert.equal(r.body.signature, payment.row.signature);
    } finally {
      await rpc.close();
    }
  });
});
