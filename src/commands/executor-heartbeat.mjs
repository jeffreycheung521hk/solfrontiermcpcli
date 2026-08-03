// Proof that an executor is running, before a human is asked to commit money.
//
// The 2026-08-01 attempt lost 0.2 USDC to ordering: the payment was made and
// only afterwards did anyone discover the executor had not been started. No
// amount of care from the operator prevents that reliably, because the person
// signing has no way to see the other process.
//
// The server now stamps a heartbeat file at the top of every execute cycle
// (bins/solfrontier-mcp/src/watch_heartbeat.rs). This reads it. The judgement
// is a pure function so the staleness boundary is testable without a clock,
// a file or a process.
import { readFile } from 'node:fs/promises';

/** Must match MAX_HEARTBEAT_AGE_MS in watch_heartbeat.rs. */
export const MAX_HEARTBEAT_AGE_MS = 75_000;
/** Must match MAX_HEARTBEAT_SKEW_MS in watch_heartbeat.rs. */
export const MAX_HEARTBEAT_SKEW_MS = 5_000;

export const HEARTBEAT_SUFFIX = '.executor-heartbeat.json';

export function heartbeatPathFor(dbPath) {
  return `${dbPath}${HEARTBEAT_SUFFIX}`;
}

/**
 * Judge a heartbeat that has already been loaded.
 *
 * Returns `{ live, reason, ageMs }`. `live` is true only when an executor
 * pinned to the expected wallet stamped the file recently enough.
 *
 * The wallet check runs FIRST, deliberately. A fresh heartbeat from an
 * executor pinned to a different controlled wallet looks entirely healthy
 * while proving nothing about the process that has to act on this payment.
 */
export function judgeHeartbeat({ heartbeat, expectedWallet, now }) {
  if (!heartbeat || typeof heartbeat !== 'object') {
    return { live: false, reason: 'unreadable', ageMs: null };
  }
  if (heartbeat.role !== 'watch_execute') {
    return { live: false, reason: 'wrong_role', ageMs: null };
  }
  if (heartbeat.controlled_wallet !== expectedWallet) {
    return { live: false, reason: 'wrong_wallet', ageMs: null };
  }
  const updatedAtMs = heartbeat.updated_at_ms;
  if (!Number.isFinite(updatedAtMs)) {
    return { live: false, reason: 'no_timestamp', ageMs: null };
  }
  const ageMs = now - updatedAtMs;
  if (ageMs < -MAX_HEARTBEAT_SKEW_MS) {
    return { live: false, reason: 'from_the_future', ageMs };
  }
  if (ageMs > MAX_HEARTBEAT_AGE_MS) {
    return { live: false, reason: 'stale', ageMs };
  }
  return { live: true, reason: 'live', ageMs };
}

/**
 * Load and judge in one step.
 *
 * A missing or malformed file is `unreadable`, never "probably fine". The
 * whole value of this check is that its failure mode is refusal.
 */
export async function checkExecutorHeartbeat({ dbPath, expectedWallet, now = Date.now() }) {
  const path = heartbeatPathFor(dbPath);
  let heartbeat = null;
  try {
    heartbeat = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return { live: false, reason: 'unreadable', ageMs: null, path };
  }
  return { ...judgeHeartbeat({ heartbeat, expectedWallet, now }), path };
}
