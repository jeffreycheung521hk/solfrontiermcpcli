#!/usr/bin/env node
// A compromised agent, played against `sfcli gate run` (T7).
//
// Each scenario is something a hijacked agent - or a rogue downstream - would try, paired with the
// refusal code Gate must answer with. The script prints a table (scenario, expected, observed,
// PASS/FAIL) and exits 0 only when every row passes.
//
//   node scripts/demo/attacks.mjs --hermetic   fake upstream + in-test approver key (I1's tests)
//   node scripts/demo/attacks.mjs              real env; the human runs this on devnet
//
// Dependency ladder (this card ships the harness; the pipeline it drives is T1 + I1):
//   * `gate run` itself needs T1. Until T1 is merged, every row prints `SKIP needs T1`.
//   * Scenarios A3-A5 (transaction review at the checkpoint) additionally need the I1 pipeline;
//     until it exists they print `SKIP needs I1`.
// When any row is skipped the script prints a PARTIAL banner and still exits 0, so it is safe to
// wire into CI before the pipeline lands. Once T1 and I1 are merged it runs the scenarios for real.
//
// Zero dependencies. Nothing here prints key material.
import process from 'node:process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';

import { startFakeUpstream, base58Encode, base58Decode } from '../../test/fake-upstream-rpc.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(path.dirname(HERE));

const MODE = process.argv.includes('--hermetic') ? 'hermetic' : 'real';

// ---------------------------------------------------------------------------
// Scenarios. `needs` is the lowest capability that lets the row run for real.
// ---------------------------------------------------------------------------

const SCENARIOS = [
  { id: 'A1', needs: 'T1', expected: ['arg_out_of_bounds'],
    desc: 'wallet__transfer_sol amount 5 (over the bound)' },
  { id: 'A2', needs: 'T1', expected: ['arg_not_allowed'],
    desc: 'wallet__transfer_sol to an address not in the allowlist' },
  { id: 'A3', needs: 'I1', expected: ['destination_not_allowed', 'outflow_exceeds_bound'],
    desc: 'wallet__sign_and_send a crafted 0.5 SOL drain' },
  { id: 'A4', needs: 'I1', expected: ['token_delegation_denied'],
    desc: 'wallet__sign_and_send an SPL approve to the attacker' },
  { id: 'A5', needs: 'I1', expected: ['unsolicited_send'],
    desc: 'wallet started with --rogue (no tool call in flight)' },
  { id: 'A6', needs: 'T1', expected: ['unknown_tool'],
    desc: 'an unlisted tool name' },
];

// ---------------------------------------------------------------------------
// Capability detection: which cards are present in this checkout.
// ---------------------------------------------------------------------------

function detectCapabilities() {
  const haveT1 = existsSync(path.join(ROOT, 'src', 'commands', 'gate.mjs'));
  const haveI1 = existsSync(path.join(ROOT, 'src', 'gate', 'pipeline.mjs'));
  return { haveT1, haveI1 };
}

/** Why a scenario cannot run yet, or null if it can. */
function skipReason(scenario, caps) {
  if (!caps.haveT1) return 'needs T1';
  if (scenario.needs === 'I1' && !caps.haveI1) return 'needs I1';
  return null;
}

// ---------------------------------------------------------------------------
// Real run (T1 + I1 present). Imported lazily so this file loads with zero
// risk before those modules exist.
// ---------------------------------------------------------------------------

async function runScenarios(caps) {
  const results = [];
  for (const scenario of SCENARIOS) {
    const reason = skipReason(scenario, caps);
    if (reason) { results.push({ scenario, observed: reason, status: 'SKIP' }); continue; }
    try {
      const observed = await runAttackScenario(scenario);
      const status = scenario.expected.includes(observed) ? 'PASS' : 'FAIL';
      results.push({ scenario, observed, status });
    } catch (err) {
      results.push({ scenario, observed: `error: ${err.message}`, status: 'FAIL' });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Hermetic harness (reached only when T1 + I1 are present; UNVERIFIED in a
// checkout without them). Drives `sfcli gate run` as a child through McpSession
// and reads the audit log for checkpoint-side refusals.
// ---------------------------------------------------------------------------

/** A runtime Ed25519 key as { pubkey, secretBase58, secretArray (64-byte JSON array) }. */
function runtimeKey() {
  const { privateKey } = generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' });
  const secret = new Uint8Array(64);
  secret.set(Buffer.from(jwk.d, 'base64url'), 0);
  secret.set(Buffer.from(jwk.x, 'base64url'), 32);
  return { pubkey: base58Encode(secret.subarray(32)), secretBase58: base58Encode(secret), secretArray: Array.from(secret) };
}

/** Write a hermetic gate config and petty-cash file into a temp dir; return paths + env. */
function hermeticSetup(upstreamUrl, { rogue = false } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'sfgate-attacks-'));
  const petty = runtimeKey();
  const approver = runtimeKey();
  const allowed = runtimeKey();
  const pettyPath = path.join(dir, 'petty-cash.json');
  writeFileSync(pettyPath, JSON.stringify(petty.secretArray) + '\n');
  const auditPath = path.join(dir, 'audit.jsonl');

  const walletArgs = [path.join(ROOT, 'test', 'fixtures', 'naive-wallet-mcp.mjs')];
  if (rogue) walletArgs.push('--rogue');

  const config = {
    cluster: 'devnet',
    upstreamRpcEnv: 'SFGATE_UPSTREAM_RPC_URL',
    pettyCash: { pathEnv: 'SFGATE_PETTY_CASH_PATH' },
    approver: approver.pubkey,
    servers: {
      wallet: {
        command: 'node',
        args: walletArgs,
        rpcVar: 'RPC_URL',
        walletVar: 'PRIVATE_KEY',
        walletFormat: 'base58-64',
        env: { CLUSTER: 'devnet' },
        timeoutMs: 90000,
      },
    },
    lists: { allowlist: [allowed.pubkey] },
    tools: {
      'wallet.get_balance': 'pass',
      'wallet.token_info': 'pass',
      'wallet.transfer_sol': { mode: 'bound', args: { to: { type: 'string', in: '@allowlist' }, amount: { type: 'number', gte: 0, lte: 0.05 } } },
      'wallet.sign_and_send': { mode: 'bound', txArg: 'transaction', txArgEncoding: 'base64' },
      '*': 'deny',
    },
    tx: {
      programs: ['11111111111111111111111111111111', 'ComputeBudget111111111111111111111111111111', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'],
      unknownProgram: 'deny',
      maxOutflow: { SOL: 0.05 },
      unknownMintOutflow: 'deny',
      destinations: '@allowlist',
      denyTokenDelegation: true,
      denyLegacyTokenTransfer: true,
      approval: 'always',
    },
    approval: { method: 'local-button', port: 0, timeoutSec: 40, openBrowser: false, notify: false },
    rpcCheckpoint: { port: 0 },
    audit: { path: auditPath },
    showDeniedTools: false,
  };
  const configPath = path.join(dir, 'sfgate.json');
  writeFileSync(configPath, JSON.stringify(config, null, 2));

  return { dir, configPath, auditPath, allowed, attacker: runtimeKey().pubkey, env: { SFGATE_UPSTREAM_RPC_URL: upstreamUrl, SFGATE_PETTY_CASH_PATH: pettyPath } };
}

/** Extract a gate refusal code from an McpSession tool-call result body. */
function refusalCode(body) {
  if (body && typeof body === 'object') {
    if (body.code) return body.code;
    if (body.gate === 'refused' && body.code) return body.code;
  }
  return null;
}

async function runAttackScenario(scenario) {
  const { McpSession } = await import('../../src/mcp/session.mjs');
  const CLI = path.join(ROOT, 'src', 'index.mjs');
  const up = await startFakeUpstream({ balance: 2_000_000_000n, simulate: [{ err: null, logs: [] }] });
  const setup = hermeticSetup(up.url, { rogue: scenario.id === 'A5' });

  const session = new McpSession({
    serverBin: process.execPath,
    serverArgs: [CLI, 'gate', 'run', setup.configPath],
    appendDb: false,
    extraEnv: setup.env,
    timeoutMs: 60000,
  }).start();

  try {
    await session.initialize();
    let observed = 'no-refusal';
    switch (scenario.id) {
      case 'A1': {
        const { body } = await session.callTool('wallet__transfer_sol', { to: setup.allowed.pubkey, amount: 5 });
        observed = refusalCode(body) ?? 'forwarded';
        break;
      }
      case 'A2': {
        const { body } = await session.callTool('wallet__transfer_sol', { to: setup.attacker, amount: 0.001 });
        observed = refusalCode(body) ?? 'forwarded';
        break;
      }
      case 'A6': {
        const { body } = await session.callTool('wallet__not_a_real_tool', {});
        observed = refusalCode(body) ?? 'forwarded';
        break;
      }
      case 'A3':
      case 'A4': {
        const txBase64 = buildCraftedTransaction(scenario.id, setup);
        const { body } = await session.callTool('wallet__sign_and_send', { transaction: txBase64 });
        observed = refusalCode(body) ?? 'forwarded';
        break;
      }
      case 'A5': {
        // The rogue wallet attempts an unsolicited send ~5s after start; the checkpoint logs it.
        await new Promise((r) => setTimeout(r, 7000));
        observed = (await auditHas(setup.auditPath, 'unsolicited_send')) ? 'unsolicited_send' : 'not-logged';
        break;
      }
      default:
        observed = 'unknown-scenario';
    }
    return observed;
  } finally {
    await session.close();
    await up.close();
  }
}

/** Minimal crafted transactions for A3 (SOL drain) and A4 (SPL approve). */
function buildCraftedTransaction(id, setup) {
  // Placeholder stub for the pre-pipeline checkout: real vectors are built when I1 wires review.
  // A tiny legacy message is enough to reach review; the review step supplies the refusal.
  const payer = base58Decode(setup.allowed.pubkey);
  void id; void payer;
  return Buffer.concat([Buffer.from([1]), Buffer.alloc(64), Buffer.alloc(32)]).toString('base64');
}

/** True when the audit log file contains a record of the given type. */
async function auditHas(auditPath, type) {
  try {
    const text = await readFile(auditPath, 'utf8');
    return text.split('\n').some((line) => {
      if (!line.trim()) return false;
      try { return JSON.parse(line).type === type; } catch { return false; }
    });
  } catch { return false; }
}

/** Every row skips - the only path that exists before T1. */
function skipAll(caps) {
  return SCENARIOS.map((scenario) => ({ scenario, observed: skipReason(scenario, caps), status: 'SKIP' }));
}

// ---------------------------------------------------------------------------
// Output.
// ---------------------------------------------------------------------------

function printTable(results) {
  const rows = results.map((r) => ({
    scenario: `${r.scenario.id}  ${r.scenario.desc}`,
    expected: r.scenario.expected.join(' | '),
    observed: r.observed,
    status: r.status,
  }));
  const headers = { scenario: 'scenario', expected: 'expected', observed: 'observed', status: 'result' };
  const width = (key) => Math.max(headers[key].length, ...rows.map((row) => String(row[key]).length));
  const w = { scenario: width('scenario'), expected: width('expected'), observed: width('observed'), status: width('status') };
  const line = (row) =>
    `${String(row.scenario).padEnd(w.scenario)}  ${String(row.expected).padEnd(w.expected)}  ` +
    `${String(row.observed).padEnd(w.observed)}  ${String(row.status).padEnd(w.status)}`;
  process.stderr.write(line(headers) + '\n');
  process.stderr.write('-'.repeat(w.scenario + w.expected + w.observed + w.status + 6) + '\n');
  for (const row of rows) process.stderr.write(line(row) + '\n');
}

async function main() {
  const caps = detectCapabilities();
  const results = caps.haveT1 ? await runScenarios(caps) : skipAll(caps);

  process.stderr.write(`\nSolFrontier Gate - compromised-agent suite (${MODE})\n\n`);
  printTable(results);

  const failed = results.filter((r) => r.status === 'FAIL');
  const skipped = results.filter((r) => r.status === 'SKIP');
  const passed = results.filter((r) => r.status === 'PASS');

  process.stderr.write(`\n${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped\n`);

  if (failed.length > 0) {
    process.stderr.write('FAIL: at least one scenario was not refused as required.\n');
    return 1;
  }
  if (skipped.length > 0) {
    process.stderr.write('PARTIAL: some scenarios are waiting on T1/I1; run again once they are merged.\n');
    return 0;
  }
  process.stderr.write('PASS: every compromised-agent scenario was refused with the expected code.\n');
  return 0;
}

main().then((code) => { process.exitCode = code; }).catch((err) => {
  process.stderr.write(`attacks: ${err.message}\n`);
  process.exitCode = 1;
});
