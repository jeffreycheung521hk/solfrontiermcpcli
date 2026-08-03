// The gate that would have prevented the 2026-08-01 loss.
//
// That attempt paid 0.2 USDC and only afterwards discovered the executor had
// never been started. The person signing cannot see the other process, so the
// client checks for them -- and the check is only worth having if its failure
// mode is refusal.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  judgeHeartbeat,
  checkExecutorHeartbeat,
  heartbeatPathFor,
  MAX_HEARTBEAT_AGE_MS,
  MAX_HEARTBEAT_SKEW_MS,
} from '../src/commands/executor-heartbeat.mjs';

const WALLET = 'BPfDMmeMBmCbMC1rWh7hwigMBoKGBrKwXxSeUu9hhs5L';
const OTHER = 'C4QQjzWxnJ5QFAbkzhQJ3wTzyX6nw1vyFvJwbPXJGPNW';

const beat = (over = {}) => ({
  role: 'watch_execute',
  controlled_wallet: WALLET,
  updated_at_ms: 1_000_000,
  ...over,
});

describe('executor liveness', () => {
  test('a recent heartbeat from the pinned wallet is live', () => {
    const v = judgeHeartbeat({ heartbeat: beat(), expectedWallet: WALLET, now: 1_030_000 });
    assert.equal(v.live, true);
    assert.equal(v.ageMs, 30_000);
  });

  test('the staleness boundary is exclusive, and matches the server constant', () => {
    const at = judgeHeartbeat({
      heartbeat: beat(), expectedWallet: WALLET, now: 1_000_000 + MAX_HEARTBEAT_AGE_MS,
    });
    assert.equal(at.live, true);
    const past = judgeHeartbeat({
      heartbeat: beat(), expectedWallet: WALLET, now: 1_000_000 + MAX_HEARTBEAT_AGE_MS + 1,
    });
    assert.equal(past.live, false);
    assert.equal(past.reason, 'stale');
  });

  test('a heartbeat for a different controlled wallet proves nothing', () => {
    // Checked before staleness on purpose: a FRESH heartbeat from the wrong
    // executor looks entirely healthy while saying nothing about the process
    // that has to act on this payment.
    const v = judgeHeartbeat({
      heartbeat: beat({ controlled_wallet: OTHER }), expectedWallet: WALLET, now: 1_000_000,
    });
    assert.equal(v.live, false);
    assert.equal(v.reason, 'wrong_wallet');
  });

  test('a timestamp beyond tolerated skew is refused', () => {
    const ok = judgeHeartbeat({
      heartbeat: beat(), expectedWallet: WALLET, now: 1_000_000 - MAX_HEARTBEAT_SKEW_MS,
    });
    assert.equal(ok.live, true, 'small clock skew is tolerated');
    const bad = judgeHeartbeat({
      heartbeat: beat(), expectedWallet: WALLET, now: 1_000_000 - MAX_HEARTBEAT_SKEW_MS - 1,
    });
    assert.equal(bad.live, false);
    assert.equal(bad.reason, 'from_the_future');
  });

  test('anything malformed is refused rather than assumed fine', () => {
    for (const [heartbeat, reason] of [
      [null, 'unreadable'],
      ['not an object', 'unreadable'],
      [beat({ role: 'something_else' }), 'wrong_role'],
      [beat({ updated_at_ms: 'soon' }), 'no_timestamp'],
      [beat({ updated_at_ms: undefined }), 'no_timestamp'],
    ]) {
      const v = judgeHeartbeat({ heartbeat, expectedWallet: WALLET, now: 1_000_000 });
      assert.equal(v.live, false, `${JSON.stringify(heartbeat)} must not be live`);
      assert.equal(v.reason, reason);
    }
  });

  test('a missing file is unreadable, which is a refusal', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'sfcli-hb-'));
    try {
      const v = await checkExecutorHeartbeat({
        dbPath: path.join(dir, 'nothing.db'), expectedWallet: WALLET,
      });
      assert.equal(v.live, false);
      assert.equal(v.reason, 'unreadable');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a real file written by the server shape is read and judged', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'sfcli-hb-'));
    try {
      const dbPath = path.join(dir, 'scratch.db');
      await writeFile(
        heartbeatPathFor(dbPath),
        JSON.stringify({ ...beat({ updated_at_ms: Date.now() }), db_path: dbPath }),
      );
      const v = await checkExecutorHeartbeat({ dbPath, expectedWallet: WALLET });
      assert.equal(v.live, true, `reason: ${v.reason}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
