// I1-B: attack vectors and both harness modes, with runtime keys and loopback RPC only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ROOT } from './helpers.mjs';
import { keypair, randomAddress, SYSTEM, TOKEN } from './solana-builders.mjs';
import { startFakeUpstream, FAKE_BLOCKHASH, DEVNET_GENESIS_HASH } from './fake-upstream-rpc.mjs';
import { decodeTransaction, resolveAccountKeys } from '../src/solana/tx.mjs';
import { describeInstructions } from '../src/solana/instructions.mjs';
import { verifyChainText } from '../src/gate/audit-log.mjs';
import { auditHas, buildCraftedTransaction } from '../scripts/demo/attacks.mjs';

const exec = promisify(execFile);
const ATTACKS = path.join(ROOT, 'scripts', 'demo', 'attacks.mjs');

function vector(id) {
  const setup = { wallet: keypair().address, attacker: randomAddress(), blockhash: FAKE_BLOCKHASH };
  const decoded = decodeTransaction(new Uint8Array(Buffer.from(buildCraftedTransaction(id, setup), 'base64')));
  return { setup, decoded, ix: describeInstructions(decoded, resolveAccountKeys(decoded, new Map()))[0] };
}

test('A3 is a valid unsigned 0.5 SOL transfer from the reviewed wallet to the attacker', () => {
  const { setup, decoded, ix } = vector('A3');
  assert.equal(decoded.staticAccountKeys[0], setup.wallet);
  assert.equal(decoded.recentBlockhash, FAKE_BLOCKHASH);
  assert.ok(decoded.signatures[0].every((byte) => byte === 0));
  assert.equal(ix.programId, SYSTEM);
  assert.equal(ix.kind, 'transfer');
  assert.equal(ix.source, setup.wallet);
  assert.equal(ix.destination, setup.attacker);
  assert.equal(ix.lamports, 500_000_000n);
});

test('A4 is a valid SPL approve with the reviewed wallet as authority', () => {
  const { setup, ix } = vector('A4');
  assert.equal(ix.programId, TOKEN);
  assert.equal(ix.kind, 'approve');
  assert.equal(ix.authority, setup.wallet);
  assert.equal(ix.delegate, setup.attacker);
  assert.equal(ix.amount, 1_000_000n);
});

test('A5 requires rpc_send_refused plus unsolicited_send in this run', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sfgate-attack-audit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'audit.jsonl');
  writeFileSync(file, [
    { type: 'rpc_send_refused', code: 'unsolicited_send' },
    { type: 'unsolicited_send' },
    { type: 'rpc_send_refused', code: 'tx_decode_failed' },
  ].map(JSON.stringify).join('\n') + '\n');
  assert.equal(await auditHas(file, 'rpc_send_refused', 'unsolicited_send', 1), false);
  writeFileSync(file, readFileSync(file, 'utf8') + JSON.stringify({ type: 'rpc_send_refused', code: 'unsolicited_send' }) + '\n');
  assert.equal(await auditHas(file, 'rpc_send_refused', 'unsolicited_send', 1), true);
});

test('hermetic attack command completes six PASS rows without skips', { timeout: 30_000 }, async () => {
  const { stdout, stderr } = await exec(process.execPath, [ATTACKS, '--hermetic'], { cwd: ROOT, timeout: 25_000 });
  assert.equal(stdout, '');
  assert.match(stderr, /6 passed, 0 failed, 0 skipped/);
  assert.equal(stderr.split('\n').filter((line) => /^A[1-6]\s.*\sPASS\s*$/.test(line)).length, 6);
});

test('human mode uses supplied config, custom env names and its upstream/audit without changing the file',
  { timeout: 30_000 }, async (t) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sfgate-human-config-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const wallet = keypair();
    const jwk = wallet.privateKey.export({ format: 'jwk' });
    const walletPath = path.join(dir, 'wallet.json');
    writeFileSync(walletPath, JSON.stringify([...Buffer.from(jwk.d, 'base64url'), ...Buffer.from(jwk.x, 'base64url')]));
    const up = await startFakeUpstream({
      balance: 2_000_000_000n,
      accounts: (address) => ({ lamports: address === wallet.address ? 2_000_000_000n : 0n }),
      simulate: (_index, params) => ({ err: null, logs: [], accounts: Object.fromEntries(
        params[1].accounts.addresses.map((address) => [address, {
          lamports: address === wallet.address ? 1_499_995_000n : 500_000_000n,
        }]),
      ) }),
    });
    t.after(() => up.close());
    const audit = path.join(dir, 'human-audit.jsonl');
    const configPath = path.join(dir, 'human.json');
    const config = {
      cluster: 'devnet', upstreamRpcEnv: 'ATTACK_RPC_ENDPOINT', pettyCash: { pathEnv: 'ATTACK_WALLET_FILE' },
      approver: keypair().address,
      servers: { wallet: { command: 'node', cwd: ROOT, args: ['test/fixtures/naive-wallet-mcp.mjs'],
        rpcVar: 'RPC_URL', walletVar: 'PRIVATE_KEY', timeoutMs: 40_000 } },
      lists: { allowlist: [randomAddress()] },
      tools: {
        'wallet.transfer_sol': { mode: 'bound', args: { to: { type: 'string', in: '@allowlist' },
          amount: { type: 'number', gte: 0, lte: 0.05 } } },
        'wallet.sign_and_send': { mode: 'bound', txArg: 'transaction', txArgEncoding: 'base64' }, '*': 'deny',
      },
      tx: { programs: [SYSTEM, TOKEN], maxOutflow: { SOL: 0.05 }, destinations: '@allowlist',
        denyTokenDelegation: true, approval: 'always' },
      approval: { method: 'wallet-signature', timeoutSec: 5, openBrowser: false, notify: false },
      audit: { path: 'human-audit.jsonl' },
    };
    const original = JSON.stringify(config);
    writeFileSync(configPath, original);
    const { stdout, stderr } = await exec(process.execPath, [ATTACKS, configPath], {
      cwd: ROOT, timeout: 25_000,
      env: { ...process.env, ATTACK_RPC_ENDPOINT: up.url, ATTACK_WALLET_FILE: walletPath },
    });
    assert.equal(stdout, '');
    assert.match(stderr, /6 passed, 0 failed, 0 skipped/);
    assert.ok(up.calls.some((call) => call.method === 'getGenesisHash'));
    assert.ok(up.calls.some((call) => call.method === 'simulateTransaction'));
    assert.ok(up.calls.some((call) => call.method === 'getLatestBlockhash'));
    assert.equal(up.sent.length, 0);
    assert.equal(readFileSync(configPath, 'utf8'), original);
    const log = readFileSync(audit, 'utf8');
    assert.equal(verifyChainText(log).ok, true);
    const records = log.trim().split('\n').map(JSON.parse);
    assert.equal(records.filter((record) => record.type === 'gate_start').length, 6);
    assert.ok(records.some((record) => record.type === 'rpc_send_refused' && record.code === 'unsolicited_send'));
    assert.equal(records.some((record) => record.type === 'hold_created'), false);
    assert.equal(stderr.includes(up.url), false);
  });
