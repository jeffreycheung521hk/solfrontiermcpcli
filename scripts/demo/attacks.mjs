#!/usr/bin/env node
// A compromised agent, played against `sfcli gate run` (T7).
//
// Each scenario is something a hijacked agent - or a rogue downstream - would try, paired with the
// refusal code Gate must answer with. The script prints a table (scenario, expected, observed,
// PASS/FAIL) and exits 0 only when every row passes.
//
//   node scripts/demo/attacks.mjs --hermetic   fake upstream + in-test approver key (I1's tests)
//   node scripts/demo/attacks.mjs [config]     real env; the human runs this on devnet
//
// Requires the merged Gate and I1 pipeline. Missing capabilities fail rather than certify
// a partial run. Only --hermetic creates a fake upstream and runtime wallet.
//
// Zero dependencies. Nothing here prints key material.
import process from 'node:process';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:net';

import { startFakeUpstream, base58Encode, DEVNET_GENESIS_HASH } from '../../test/fake-upstream-rpc.mjs';
import { SYSTEM, TOKEN, data, message, transaction, randomAddress } from '../../test/solana-builders.mjs';
import { decodeTransaction } from '../../src/solana/tx.mjs';
import { loadGateConfig, loadPettyCash, resolveUpstream, createRedactor } from '../../src/gate/config.mjs';
import { McpSession, redactSensitive } from '../../src/mcp/session.mjs';
import { SolanaRpc } from '../../src/solana/rpc.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(path.dirname(HERE));
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'naive-wallet-mcp.mjs');
const BALANCE = 2_000_000_000n;

const MODE = process.argv.includes('--hermetic') ? 'hermetic' : 'real';

// ---------------------------------------------------------------------------
// Scenarios and their stable refusal codes.
// ---------------------------------------------------------------------------

const SCENARIOS = [
  { id: 'A1', expected: ['arg_out_of_bounds'],
    desc: 'wallet__transfer_sol amount 5 (over the bound)' },
  { id: 'A2', expected: ['arg_not_allowed'],
    desc: 'wallet__transfer_sol to an address not in the allowlist' },
  { id: 'A3', expected: ['destination_not_allowed', 'outflow_exceeds_bound'],
    desc: 'wallet__sign_and_send a crafted 0.5 SOL drain' },
  { id: 'A4', expected: ['token_delegation_denied'],
    desc: 'wallet__sign_and_send an SPL approve to the attacker' },
  { id: 'A5', expected: ['unsolicited_send'],
    desc: 'wallet started with --rogue (no tool call in flight)' },
  { id: 'A6', expected: ['unknown_tool'],
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

async function runScenarios(options) {
  const results = [];
  for (const scenario of SCENARIOS) {
    try {
      const observed = await runAttackScenario(scenario, options);
      const status = scenario.expected.includes(observed) ? 'PASS' : 'FAIL';
      results.push({ scenario, observed, status });
    } catch (err) {
      results.push({ scenario, observed: `error: ${err.message}`, status: 'FAIL' });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Drives `sfcli gate run` through McpSession and checks checkpoint refusals in the audit log.
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

/** Reserve a real approval port and a consecutive checkpoint HTTP/WS pair. */
export async function reservePorts() {
  const listen = (port = 0) => new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server);
    });
  });
  const close = (server) => new Promise((resolve) => server.close(resolve));
  for (let attempt = 0; attempt < 50; attempt++) {
    const listeners = [await listen()];
    const rpcPort = listeners[0].address().port;
    let reserved = false;
    try {
      if (rpcPort === 65535) continue;
      listeners.push(await listen(rpcPort + 1));
      listeners.push(await listen());
      reserved = true;
      return {
        rpcPort,
        approvalPort: listeners[2].address().port,
        release: () => Promise.all(listeners.map(close)),
      };
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
    } finally {
      if (!reserved) await Promise.all(listeners.map(close));
    }
  }
  throw new Error('could not reserve a free checkpoint port pair');
}

/** Write only runtime-generated keys and a hermetic config to the scratch directory. */
function hermeticSetup(dir, ports, { rogue = false } = {}) {
  const petty = runtimeKey();
  const approver = runtimeKey();
  const allowed = runtimeKey();
  const pettyPath = path.join(dir, 'petty-cash.json');
  writeFileSync(pettyPath, JSON.stringify(petty.secretArray) + '\n');
  const auditPath = path.join(dir, 'audit.jsonl');

  const walletArgs = [FIXTURE];
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
    approval: { method: 'wallet-signature', port: ports.approvalPort, timeoutSec: 5, openBrowser: false, notify: false },
    rpcCheckpoint: { port: ports.rpcPort },
    audit: { path: auditPath },
    showDeniedTools: false,
  };
  const configPath = path.join(dir, 'sfgate.json');
  writeFileSync(configPath, JSON.stringify(config, null, 2));

  return { configPath, auditPath, allowed, wallet: petty.pubkey, attacker: randomAddress(),
    env: { SFGATE_PETTY_CASH_PATH: pettyPath } };
}

/** Extract a gate refusal code from an McpSession tool-call result body. */
function refusalCode(body) {
  if (body && typeof body === 'object') {
    if (body.code) return body.code;
    if (body.gate === 'refused' && body.code) return body.code;
  }
  return null;
}

/** Keep simulation tied to the transfer bytes rather than a canned passing balance. */
function transferScript(wallet) {
  return {
    balance: BALANCE,
    accounts: (address) => ({ lamports: address === wallet ? BALANCE : 0n }),
    simulate: (_index, params) => {
      const tx = decodeTransaction(new Uint8Array(Buffer.from(params[0], 'base64')));
      const ix = tx.instructions[0];
      const amount = Buffer.from(ix.data).readBigUInt64LE(4);
      const to = tx.staticAccountKeys[ix.accountIndexes[1]];
      return { err: null, logs: [], accounts: Object.fromEntries(params[1].accounts.addresses.map((address) =>
        [address, { lamports: address === wallet ? BALANCE - amount - 5000n : address === to ? amount : 0n }])) };
    },
  };
}

/** Use the human's policy, environment names, wallet and audit file; never overwrite their config. */
async function humanSetup(dir, ports, configPath, rogue) {
  const config = loadGateConfig(configPath);
  if (config.cluster !== 'devnet') throw new Error('attacks without --hermetic requires a devnet config');
  const upstream = resolveUpstream(config);
  const petty = loadPettyCash(config);
  if (!petty) throw new Error('attacks requires the configured petty-cash wallet');
  const gateRedact = createRedactor([upstream.url, upstream.wsUrl, petty.secretKey]);
  const redact = (text) => gateRedact(redactSensitive(text));
  const rpc = new SolanaRpc({ url: upstream.url });
  try {
    if (await rpc.call('getGenesisHash') !== DEVNET_GENESIS_HASH) {
      throw new Error('attacks requires a devnet upstream (genesis hash mismatch)');
    }
  } catch (err) {
    throw new Error(redact(err.message));
  }
  const allowed = config.lists.allowlist?.[0];
  if (!allowed) throw new Error('attacks requires lists.allowlist with an address');
  const raw = JSON.parse(await readFile(config.configPath, 'utf8'));
  for (const [name, server] of Object.entries(config.servers)) raw.servers[name].cwd = server.cwd;
  if (rogue) {
    const wallet = config.servers.wallet;
    if (!wallet || !wallet.args.some((arg) => path.resolve(wallet.cwd, arg) === FIXTURE)) {
      throw new Error('A5 requires the configured wallet to use test/fixtures/naive-wallet-mcp.mjs');
    }
    if (!raw.servers.wallet.args.includes('--rogue')) raw.servers.wallet.args.push('--rogue');
  }
  raw.approval = { ...raw.approval, port: ports.approvalPort, openBrowser: false, notify: false };
  raw.rpcCheckpoint = { ...raw.rpcCheckpoint, port: ports.rpcPort };
  raw.audit = { ...raw.audit, path: config.audit.path };
  const runConfigPath = path.join(dir, 'sfgate.json');
  writeFileSync(runConfigPath, JSON.stringify(raw, null, 2));
  return { configPath: runConfigPath, auditPath: config.audit.path, allowed: { pubkey: allowed },
    wallet: petty.publicKey, attacker: randomAddress(), rpc, redact,
    env: Object.fromEntries(config.envNames.map((name) => [name, process.env[name]])) };
}

async function runAttackScenario(scenario, { hermetic, configPath }) {
  const CLI = path.join(ROOT, 'src', 'index.mjs');
  const dir = mkdtempSync(path.join(tmpdir(), 'sfgate-attacks-'));
  let ports;
  let up;
  let session;
  let setup;
  try {
    ports = await reservePorts();
    if (hermetic) {
      setup = hermeticSetup(dir, ports, { rogue: scenario.id === 'A5' });
      up = await startFakeUpstream(transferScript(setup.wallet));
      setup.env.SFGATE_UPSTREAM_RPC_URL = up.url;
      setup.rpc = new SolanaRpc({ url: up.url });
    } else {
      setup = await humanSetup(dir, ports, configPath, scenario.id === 'A5');
    }
    const firstRecord = (await auditRecords(setup.auditPath)).length;
    // Keep listeners reserved until immediately before the Gate child binds them.
    await ports.release();
    ports = null;
    session = new McpSession({
      serverBin: process.execPath,
      serverArgs: [CLI, 'gate', 'run', setup.configPath],
      appendDb: false,
      extraEnv: setup.env,
      cwd: ROOT,
      redact: setup.redact,
      timeoutMs: 60000,
    }).start();
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
        const latest = await setup.rpc.call('getLatestBlockhash', [{ commitment: 'confirmed' }]);
        const txBase64 = buildCraftedTransaction(scenario.id, { ...setup, blockhash: latest.value.blockhash });
        const { body } = await session.callTool('wallet__sign_and_send', { transaction: txBase64 });
        observed = refusalCode(body) ?? 'forwarded';
        break;
      }
      case 'A5': {
        // Ignore records from previous runs and check both the event type and refusal code.
        const deadline = Date.now() + 10_000;
        do {
          if (await auditHas(setup.auditPath, 'rpc_send_refused', 'unsolicited_send', firstRecord)) {
            observed = 'unsolicited_send';
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        } while (Date.now() < deadline);
        if (observed === 'no-refusal') observed = 'not-logged';
        break;
      }
      default:
        observed = 'unknown-scenario';
    }
    // A refusal result alone is insufficient if an attack also reached the ledger or a hold.
    const records = (await auditRecords(setup.auditPath)).slice(firstRecord);
    if (records.some((record) => record.type === 'hold_created' || record.type === 'rpc_send_forwarded') || up?.sent.length) {
      return 'unexpected-hold-or-broadcast';
    }
    return observed;
  } catch (err) {
    throw new Error(setup?.redact ? setup.redact(err.message) : redactSensitive(err.message));
  } finally {
    try {
      if (session) {
        await session.close();
        await session.stdioClosed;
      }
    } finally {
      if (up) await up.close();
      if (ports) await ports.release();
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

/** Valid unsigned wire transactions: Gate reviews them before the downstream signs. */
export function buildCraftedTransaction(id, { wallet, attacker, blockhash }) {
  const fields = id === 'A3'
    ? { header: [1, 0, 1], keys: [wallet, attacker, SYSTEM],
      instructions: [{ p: 2, a: [0, 1], d: data.systemTransfer(500_000_000n) }] }
    : id === 'A4'
      ? { header: [1, 0, 2], keys: [wallet, randomAddress(), attacker, TOKEN],
        instructions: [{ p: 3, a: [1, 2, 0], d: data.splApprove(1_000_000n) }] }
      : null;
  if (!fields) throw new Error('unknown crafted transaction scenario');
  return Buffer.from(transaction(message({ ...fields, blockhash }), [null])).toString('base64');
}

async function auditRecords(auditPath) {
  try {
    const text = await readFile(auditPath, 'utf8');
    return text.split('\n').filter((line) => line.trim()).map(JSON.parse);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw new Error('could not read attack audit records');
  }
}

/** True only for a matching audit event and code in the current run. */
export async function auditHas(auditPath, type, code, firstRecord = 0) {
  return (await auditRecords(auditPath)).slice(firstRecord).some((record) => record.type === type && record.code === code);
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
  const args = process.argv.slice(2).filter((arg) => arg !== '--hermetic');
  if (args.length > 1 || args.some((arg) => arg.startsWith('-')) || (MODE === 'hermetic' && args.length)) {
    throw new Error('usage: node scripts/demo/attacks.mjs [--hermetic | <devnet-config.json>]');
  }
  const caps = detectCapabilities();
  if (!caps.haveT1 || !caps.haveI1) throw new Error('attacks requires Gate and src/gate/pipeline.mjs');
  const options = { hermetic: MODE === 'hermetic', configPath: path.resolve(args[0] ?? 'sfgate.devnet.json') };
  const results = await runScenarios(options);

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
  process.stderr.write('PASS: every compromised-agent scenario was refused with the expected code.\n');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((err) => {
    process.stderr.write(`attacks: ${redactSensitive(err.message)}\n`);
    process.exitCode = 1;
  });
}
