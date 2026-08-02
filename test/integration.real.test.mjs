// Integration tests against the real solfrontier-mcp binary.
//
// Opt in explicitly:   SFCLI_REAL=1 npm run test:real
//
// If the gate is closed these tests FAIL rather than silently pass, so a CI
// job that forgets to set the variable cannot report a false green. That is
// the opposite of the usual skip-and-exit-0 pattern, on purpose.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { CLI, ROOT } from './helpers.mjs';

const enabled = process.env.SFCLI_REAL === '1';
const serverBin = process.env.SFCLI_BIN ?? '';

let dir;
let configPath;

function run(args, { env = {} } = {}) {
  return new Promise((resolve) => {
    const childEnv = { ...process.env, SFCLI_CONFIG: configPath, NO_COLOR: '1', ...env };
    delete childEnv.SOLFRONTIER_RPC_URL; // force the documented config_missing paths
    execFile(process.execPath, [CLI, ...args], { cwd: ROOT, env: childEnv }, (error, stdout, stderr) =>
      resolve({ code: error?.code ?? 0, stdout, stderr }),
    );
  });
}

describe('real server integration', { skip: enabled ? false : 'set SFCLI_REAL=1 (and SFCLI_BIN) to run' }, () => {
  before(async () => {
    assert.ok(serverBin, 'SFCLI_BIN must point at the solfrontier-mcp binary');
    assert.ok(existsSync(serverBin), `binary not found: ${serverBin}`);
    dir = await mkdtemp(path.join(tmpdir(), 'sfcli-real-'));
    const db = path.join(dir, 'integration.db');
    await writeFile(db, '');
    configPath = path.join(dir, 'sfcli.config.json');
    await writeFile(configPath, JSON.stringify({ serverBin, dbPath: db }));
  });

  after(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test('handshake exposes exactly the six known tools', async () => {
    const r = await run(['tools', 'list']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.stdout.trim().split(/\r?\n/).sort(), [
      'confirm_funding',
      'finalize_intent',
      'get_intent_status',
      'get_position',
      'get_quote',
      'propose_intent',
    ]);
  });

  test('tools describe returns a real input schema', async () => {
    const r = await run(['tools', 'describe', 'get_quote', '--json']);
    assert.equal(r.code, 0);
    const schema = JSON.parse(r.stdout).inputSchema;
    assert.deepEqual(schema.required.sort(), ['amount', 'input_mint', 'output_mint', 'slippage_bps']);
  });

  test('status on a fresh database answers not_found with exit 1', async () => {
    const r = await run(['status', '--ref', '5a000000400d0300000000009a62dace', '--json']);
    assert.equal(r.code, 1);
    assert.equal(JSON.parse(r.stdout).status, 'not_found');
  });

  test('position without an RPC endpoint degrades to sanitized config_missing', async () => {
    const r = await run(['position', '--wallet', 'BPfDMmeMBmCbMC1rWh7hwigMBoKGBrKwXxSeUu9hhs5L', '--json']);
    assert.equal(r.code, 1);
    const body = JSON.parse(r.stdout);
    assert.equal(body.status, 'config_missing');
    assert.ok(!JSON.stringify(body).includes('http'), 'no endpoint may leak into the result');
  });

  test('propose_intent is pure: no row, no writes, 64-hex hash', async () => {
    const r = await run(['propose', '--amount', '0.2', '--threshold-bps', '90', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const body = JSON.parse(r.stdout);
    assert.equal(body.status, 'ok');
    assert.equal(body.persistence.db_row_exists, false);
    assert.equal(body.side_effects.database_writes, 0);
    assert.equal(body.side_effects.signatures, 0);
    assert.match(body.draft_hash, /^[0-9a-f]{64}$/);
  });

  test('the same parameters always produce the same draft hash', async () => {
    const a = await run(['propose', '--amount', '0.2', '--threshold-bps', '90', '--json']);
    const b = await run(['propose', '--amount', '0.2', '--threshold-bps', '90', '--json']);
    assert.equal(JSON.parse(a.stdout).draft_hash, JSON.parse(b.stdout).draft_hash);
    // ...but the single-use draft id must differ every time.
    assert.notEqual(JSON.parse(a.stdout).draft_id, JSON.parse(b.stdout).draft_id);
  });

  test('a different message changes the draft hash (it is bound in)', async () => {
    const a = await run(['propose', '--amount', '0.2', '--threshold-bps', '90', '--json']);
    const b = await run(['propose', '--amount', '0.2', '--threshold-bps', '90', '--message', 'different', '--json']);
    assert.notEqual(JSON.parse(a.stdout).draft_hash, JSON.parse(b.stdout).draft_hash);
  });

  test('confirm_funding fails closed on a signature that proves nothing', async () => {
    const r = await run(['confirm', '--intent-id', 'deadbeef', '--tx-signature', '1'.repeat(88), '--json']);
    assert.equal(r.code, 1);
    assert.notEqual(JSON.parse(r.stdout).status, 'budget_reserved');
  });

  test('doctor reports on the real server without an RPC endpoint', async () => {
    const r = await run(['doctor', '--json']);
    // No RPC configured: warnings are expected, blocking failures are not.
    const report = JSON.parse(r.stdout);
    assert.ok(['GO', 'NO-GO'].includes(report.verdict));
    const handshake = report.checks.find((c) => c.name === 'MCP handshake');
    assert.equal(handshake.status, 'pass', JSON.stringify(handshake));
  });
});
