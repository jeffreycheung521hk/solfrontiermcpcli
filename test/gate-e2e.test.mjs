// I1-A: the actual host -> Gate child -> naive wallet -> loopback checkpoint
// path, with runtime approval signatures and a fake ledger. No live cluster.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { CLI, ROOT } from './helpers.mjs';
import { SYSTEM, MEMO, data, message, transaction, rpcAccount } from './solana-builders.mjs';
import { startFakeUpstream, base58Encode, FAKE_BLOCKHASH } from './fake-upstream-rpc.mjs';
import { decodeTransaction, messageSha256 } from '../src/solana/tx.mjs';
import { verifyChainText } from '../src/gate/audit-log.mjs';
import { LineFramer } from '../src/mcp/framing.mjs';
import { HoldQueue } from '../src/gate/holds.mjs';
import { createPipeline, summarizeResult } from '../src/gate/pipeline.mjs';
import { compileToolPolicy } from '../src/gate/tool-policy.mjs';
import { compileTxPolicy } from '../src/gate/tx-policy.mjs';
import { holdView } from '../src/gate/approval-server.mjs';

const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'naive-wallet-mcp.mjs');
const BALANCE = 2_000_000_000n;

function runtimeKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const seed = Buffer.from(privateKey.export({ format: 'jwk' }).d, 'base64url');
  const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  return { privateKey, address: base58Encode(pub), bytes: [...seed, ...pub] };
}

function listen(port = 0) {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

const closeListener = (server) => new Promise((resolve) => server.close(resolve));

// Gate configs intentionally reject 0. Reserve an ephemeral TCP port and its
// successor, then release immediately before the Gate child binds HTTP + WS.
async function reservePorts() {
  for (let attempt = 0; attempt < 50; attempt++) {
    const rpc = await listen();
    const rpcPort = rpc.address().port;
    let ws;
    let approval;
    try {
      if (rpcPort === 65535) continue;
      ws = await listen(rpcPort + 1);
      approval = await listen();
      return {
        rpcPort,
        approvalPort: approval.address().port,
        release: () => Promise.all([rpc, ws, approval].map(closeListener)),
      };
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
    } finally {
      // A successful reservation stays open until release() above.
      if (!approval) {
        await closeListener(rpc);
        if (ws) await closeListener(ws);
      }
    }
  }
  throw new Error('could not reserve a free checkpoint port pair');
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const value = await check();
    if (value) return value;
    await pause(20);
  } while (Date.now() < deadline);
  throw new Error(`timed out waiting for ${label}`);
}

function spawnCli(args, env) {
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  const finished = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  return { child, finished, get stdout() { return stdout; }, get stderr() { return stderr; } };
}

function hostClient(proc) {
  const frames = [];
  const malformed = [];
  const framer = new LineFramer();
  const pending = new Map();
  let nextId = 1;
  proc.child.stdout.on('data', (chunk) => {
    for (const line of framer.push(chunk)) {
      let frame;
      try { frame = JSON.parse(line); } catch { malformed.push(line); continue; }
      frames.push(frame);
      const waiter = pending.get(frame.id);
      if (waiter) { pending.delete(frame.id); waiter.resolve(frame); }
    }
  });
  proc.finished.then(({ code }) => {
    for (const waiter of pending.values()) waiter.reject(new Error(`Gate exited ${code}: ${proc.stderr}`));
    pending.clear();
  });
  function send(frame) {
    proc.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`);
  }
  function request(method, params) {
    const id = nextId++;
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Gate ${method} timed out: ${proc.stderr}`));
      }, 15_000);
      pending.set(id, {
        resolve: (frame) => { clearTimeout(timer); resolve(frame); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
    });
    send({ id, method, params });
    return { id, response };
  }
  const call = (name, args = {}) => request('tools/call', { name, arguments: args });
  return { frames, malformed, framer, send, request, call };
}

function resultBody(frame) {
  assert.ok(!frame.error, JSON.stringify(frame));
  return frame.result.structuredContent ?? JSON.parse(frame.result.content[0].text);
}

// Simulated balances reflect the actual transfer under review, including a
// fee. A drain therefore trips maxOutflow instead of passing a canned review.
function transferScript(wallet) {
  return {
    balance: BALANCE,
    accounts: (address) => ({ lamports: address === wallet.address ? BALANCE : 0n }),
    simulate: (_index, params) => {
      const tx = decodeTransaction(new Uint8Array(Buffer.from(params[0], 'base64')));
      const ix = tx.instructions[0];
      const amount = Buffer.from(ix.data).readBigUInt64LE(4);
      const to = tx.staticAccountKeys[ix.accountIndexes[1]];
      return {
        err: null,
        logs: [],
        accounts: Object.fromEntries(params[1].accounts.addresses.map((address) => [address, {
          lamports: address === wallet.address ? BALANCE - amount - 5000n : address === to ? amount : 0n,
        }])),
      };
    },
  };
}

async function startGate(t, { timeoutSec = 5, rogue = false, bindFailure = null } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'sfgate-e2e-'));
  const wallet = runtimeKey();
  const approver = runtimeKey();
  const destination = runtimeKey().address;
  const upstream = await startFakeUpstream(transferScript(wallet));
  const ports = await reservePorts();
  const logPath = path.join(dir, 'audit.jsonl');
  const walletPath = path.join(dir, 'wallet.json');
  const configPath = path.join(dir, 'gate.json');
  writeFileSync(walletPath, JSON.stringify(wallet.bytes));
  writeFileSync(configPath, JSON.stringify({
    cluster: 'localnet',
    upstreamRpcEnv: 'SFGATE_UPSTREAM_RPC_URL',
    pettyCash: { pathEnv: 'SFGATE_PETTY_CASH_PATH' },
    approver: approver.address,
    servers: {
      wallet: {
        command: 'node', args: [FIXTURE, ...(rogue ? ['--rogue'] : [])], cwd: ROOT,
        rpcVar: 'RPC_URL', walletVar: 'PRIVATE_KEY', env: { CLUSTER: 'localnet' },
        timeoutMs: (timeoutSec + 30) * 1000,
      },
    },
    lists: { allowlist: [destination] },
    tools: {
      'wallet.get_balance': 'pass',
      'wallet.transfer_sol': { mode: 'bound', args: {
        to: { type: 'string', in: '@allowlist' }, amount: { type: 'number', gte: 0, lte: 0.05 },
      } },
      'wallet.sign_and_send': { mode: 'bound', txArg: 'transaction', txArgEncoding: 'base64' },
      '*': 'deny',
    },
    tx: {
      programs: [SYSTEM], unknownProgram: 'deny', maxOutflow: { SOL: 0.05 },
      unknownMintOutflow: 'deny', destinations: '@allowlist',
      denyTokenDelegation: true, denyLegacyTokenTransfer: true, approval: 'always',
    },
    approval: { method: 'wallet-signature', port: ports.approvalPort, timeoutSec, notify: false, openBrowser: false },
    rpcCheckpoint: { port: ports.rpcPort },
    audit: { path: logPath },
  }));
  await ports.release();
  const blockedPort = bindFailure === 'approval' ? ports.approvalPort :
    bindFailure === 'checkpoint' ? ports.rpcPort : bindFailure === 'websocket' ? ports.rpcPort + 1 : null;
  const blocker = blockedPort ? await listen(blockedPort) : null;
  const proc = spawnCli(['gate', 'run', configPath], {
    SFGATE_UPSTREAM_RPC_URL: upstream.url,
    SFGATE_PETTY_CASH_PATH: walletPath,
  });
  const host = hostClient(proc);
  let closed = false;
  async function stop() {
    if (closed) return;
    closed = true;
    const timer = setTimeout(() => proc.child.kill(), 3000);
    proc.child.stdin.end();
    let result;
    try { result = await proc.finished; } finally { clearTimeout(timer); }
    if (!bindFailure) {
      assert.equal(result.code, 0, proc.stderr);
      assert.equal(result.signal, null, 'Gate must shut down without the kill fallback');
    }
  }
  t.after(async () => {
    try { await stop(); } finally {
      if (blocker) await closeListener(blocker);
      await upstream.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  const approvalUrl = `http://127.0.0.1:${ports.approvalPort}`;
  function records() {
    return existsSync(logPath) ? readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  }
  async function pendingHolds() {
    const res = await fetch(`${approvalUrl}/api/holds`, { signal: AbortSignal.timeout(3000) });
    assert.equal(res.status, 200);
    return (await res.json()).holds;
  }
  async function waitHold(predicate = () => true) {
    return until(async () => (await pendingHolds()).find(predicate), 'pending approval hold');
  }
  async function approve(hold, key = approver) {
    const signature = sign(null, Buffer.from(hold.approvalMessage), key.privateKey);
    const res = await fetch(`${approvalUrl}/api/holds/${hold.id}/approve`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: approvalUrl },
      body: JSON.stringify({ publicKey: key.address, signature: signature.toString('base64') }),
      signal: AbortSignal.timeout(3000),
    });
    return { status: res.status, body: await res.json(), signature };
  }
  if (!bindFailure) {
    const initialized = await host.request('initialize', { protocolVersion: '2025-06-18' }).response;
    assert.equal(initialized.result.serverInfo.name, 'solfrontier-gate');
    const tools = (await host.request('tools/list').response).result.tools;
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [
      'gate__status', 'wallet__get_balance', 'wallet__sign_and_send', 'wallet__transfer_sol',
    ]);
  }
  return {
    child: proc.child, finished: proc.finished,
    get stdout() { return proc.stdout; }, get stderr() { return proc.stderr; },
    host, wallet, approver, destination, upstream, logPath, records, pendingHolds, waitHold, approve, stop, approvalUrl, blockedPort,
    approvalPort: ports.approvalPort, rpcPort: ports.rpcPort,
  };
}

function transferBytes(wallet, destination, lamports, signed = false) {
  const bytes = message({
    header: [1, 0, 1], keys: [wallet.address, destination, SYSTEM], blockhash: FAKE_BLOCKHASH,
    instructions: [{ p: 2, a: [0, 1], d: data.systemTransfer(lamports) }],
  });
  return transaction(bytes, [signed ? wallet : null]);
}

function assertRefused(frame, code) {
  assert.equal(frame.result.isError, true, JSON.stringify(frame));
  const body = resultBody(frame);
  // The naive wallet returns checkpoint failures verbatim as an error string;
  // direct tool-policy and tool-argument refusals have the structured code.
  if (body.code) assert.equal(body.code, code);
  else assert.match(body.error, new RegExp(`rpc error -32099:.*${code}`));
}

async function auditCli(gate) {
  const proc = spawnCli(['audit', '--log', gate.logPath, '--commitment', 'confirmed', '--json'], {
    SFGATE_UPSTREAM_RPC_URL: gate.upstream.url,
  });
  proc.child.stdin.end();
  const { code } = await proc.finished;
  assert.equal(code, 0, proc.stderr + proc.stdout);
  const report = JSON.parse(proc.stdout);
  assert.equal(report.verdict, 'VERIFIED');
  assert.deepEqual(report.counts, { passed: 2, failed: 0, unverified: 0 });
  assert.equal(report.results.find((row) => row.signature)?.status, 'PASS');
  return report;
}

describe('Gate pipeline hermetic E2E', () => {
  test('allowlisted transfer holds once, approves exact message, sends once and audits the actual log', { timeout: 20_000 }, async (t) => {
    const gate = await startGate(t);
    const balance = await gate.host.call('wallet__get_balance').response;
    assert.equal(resultBody(balance).lamports, BALANCE.toString());
    const denied = await gate.host.call('wallet__transfer_sol', { to: gate.destination, amount: 5 }).response;
    assertRefused(denied, 'arg_out_of_bounds');
    const call = gate.host.call('wallet__transfer_sol', { to: gate.destination, amount: 0.001 });
    const hold = await gate.waitHold();
    assert.equal(hold.kind, 'rpc-send');
    assert.equal(gate.upstream.sent.length, 0, 'holding must precede any broadcast');
    const status = resultBody(await gate.host.call('gate__status').response);
    assert.equal(status.approvalUrl, gate.approvalUrl);
    assert.equal(status.pendingHolds.length, 1);
    assert.equal(status.pendingHolds[0].id, hold.id);
    assert.equal(status.pendingHolds[0].summaryLine, hold.summaryLine);
    assert.ok(status.pendingHolds[0].secondsLeft > 0 && status.pendingHolds[0].secondsLeft <= 5);
    const approval = await gate.approve(hold);
    assert.equal(approval.status, 200, JSON.stringify(approval.body));
    const frame = await call.response;
    assert.equal(frame.result.isError, false, JSON.stringify(frame));
    const { signature } = resultBody(frame);
    assert.equal(gate.upstream.sent.length, 1);
    assert.equal(gate.upstream.calls.filter((row) => row.method === 'sendTransaction').length, 1);
    assert.equal(signature, gate.upstream.sent[0].signature);
    const expectedHash = messageSha256(decodeTransaction(gate.upstream.sent[0].bytes));
    assert.equal(expectedHash, hold.messageSha256);
    await gate.stop();
    const records = gate.records();
    assert.equal(records.at(-1).type, 'gate_stop');
    for (const port of [gate.approvalPort, gate.rpcPort, gate.rpcPort + 1]) {
      const listener = await listen(port);
      await closeListener(listener);
    }
    const toolCall = records.find((row) => row.type === 'tool_call' && row.requestId === call.id);
    assert.equal(toolCall.decision, 'bound');
    assert.ok(records.some((row) => row.type === 'tool_call' && row.decision === 'deny'));
    assert.ok(records.some((row) => row.type === 'tool_call' && row.decision === 'pass'));
    const created = records.find((row) => row.type === 'hold_created' && row.holdId === hold.id);
    const approved = records.find((row) => row.type === 'hold_approved' && row.holdId === hold.id);
    assert.equal(created.messageSha256, expectedHash);
    assert.equal(created.approvalMessage, hold.approvalMessage);
    assert.equal(created.approvalMessage.split('\n').length, 6);
    assert.ok(created.parentIds.includes(toolCall.callId));
    assert.equal(approved.messageSha256, expectedHash);
    assert.equal(approved.publicKey, gate.approver.address);
    assert.equal(approved.signature, base58Encode(approval.signature));
    assert.equal(approved.method, 'wallet-signature');
    assert.equal(created.sendId, approved.sendId);
    const flow = records.filter((row) => row.callId === toolCall.callId || row.sendId === created.sendId || row.holdId === hold.id);
    assert.deepEqual(flow.map((row) => row.type), [
      'tool_call', 'tx_review', 'hold_created', 'hold_approved', 'rpc_send_forwarded', 'tool_result',
    ]);
    const forwarded = flow.find((row) => row.type === 'rpc_send_forwarded');
    assert.equal(forwarded.signature, signature);
    assert.equal(flow.at(-1).signature, signature);
    assert.equal(verifyChainText(readFileSync(gate.logPath, 'utf8')).ok, true);
    const report = await auditCli(gate);
    assert.equal(report.results.find((row) => row.signature)?.observedMessageSha256, expectedHash);
    assert.ok(gate.upstream.calls.some((row) => row.method === 'getTransaction'));
    assert.deepEqual(gate.host.malformed, [], 'stdout contains only JSON-RPC frames');
    assert.equal(gate.host.framer.pending, '');
    for (const output of [gate.stdout, gate.stderr, readFileSync(gate.logPath, 'utf8')]) {
      assert.ok(!output.includes(base58Encode(gate.wallet.bytes)), 'petty-cash secret never leaves memory');
      assert.ok(!output.includes(gate.upstream.url), 'upstream URL stays private');
    }
  });

  test('sign_and_send drain is refused during tool-argument review before any hold or send', async (t) => {
    const gate = await startGate(t);
    const bytes = transferBytes(gate.wallet, runtimeKey().address, 1_800_000_000n);
    const frame = await gate.host.call('wallet__sign_and_send', { transaction: Buffer.from(bytes).toString('base64') }).response;
    assert.equal(frame.result.isError, true);
    const refusal = resultBody(frame);
    assert.ok(refusal.violations.some((row) => row.code === 'outflow_exceeds_bound'));
    assert.equal(gate.upstream.sent.length, 0);
    assert.equal(gate.upstream.calls.filter((row) => row.method === 'sendTransaction').length, 0);
    assert.equal(gate.records().filter((row) => row.type === 'hold_created').length, 0);
    assert.equal((await gate.pendingHolds()).length, 0);
  });

  test('approval timeout expires the checkpoint hold and forwards nothing', { timeout: 10_000 }, async (t) => {
    const gate = await startGate(t, { timeoutSec: 2 });
    const call = gate.host.call('wallet__transfer_sol', { to: gate.destination, amount: 0.001 });
    const hold = await gate.waitHold();
    assertRefused(await call.response, 'approval_timeout');
    assert.equal(gate.upstream.sent.length, 0);
    const records = gate.records();
    assert.ok(records.some((row) => row.type === 'hold_expired' && row.holdId === hold.id));
    assert.ok(records.some((row) => row.type === 'rpc_send_refused' && row.code === 'approval_timeout'));
    assert.equal((await gate.pendingHolds()).length, 0);
  });

  test('a wrong approver stays pending until timeout and never broadcasts', { timeout: 10_000 }, async (t) => {
    const gate = await startGate(t, { timeoutSec: 2 });
    const call = gate.host.call('wallet__transfer_sol', { to: gate.destination, amount: 0.001 });
    const hold = await gate.waitHold();
    const wrong = await gate.approve(hold, runtimeKey());
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.error, 'bad_signature');
    assert.equal((await gate.pendingHolds())[0].id, hold.id);
    assertRefused(await call.response, 'approval_timeout');
    assert.equal(gate.upstream.sent.length, 0);
    assert.ok(gate.records().some((row) => row.type === 'hold_expired' && row.holdId === hold.id));
    assert.ok(!gate.records().some((row) => row.type === 'hold_approved'));
  });

  test('a --rogue wallet send with no host call is refused before review', { timeout: 12_000 }, async (t) => {
    const gate = await startGate(t, { rogue: true });
    const refused = await until(() => gate.records().find((row) => row.type === 'rpc_send_refused' && row.code === 'unsolicited_send'), 'rogue refusal', 8000);
    assert.equal(refused.server, 'wallet');
    assert.equal(gate.upstream.sent.length, 0);
    assert.equal(gate.records().filter((row) => row.type === 'tx_review' || row.type === 'hold_created').length, 0);
  });

  test('host cancellation settles its checkpoint hold, rejects late approval and sends nothing', async (t) => {
    const gate = await startGate(t);
    const requestId = 'cancel-transfer';
    gate.host.send({ id: requestId, method: 'tools/call', params: {
      name: 'wallet__transfer_sol', arguments: { to: gate.destination, amount: 0.001 },
    } });
    const hold = await gate.waitHold();
    gate.host.send({ method: 'notifications/cancelled', params: { requestId, reason: 'user cancelled' } });
    const cancelled = await until(() => gate.records().find((row) => row.type === 'hold_cancelled' && row.holdId === hold.id), 'hold cancellation');
    assert.equal(cancelled.holdId, hold.id);
    const late = await gate.approve(hold);
    assert.equal(late.status, 409);
    assert.equal(late.body.error, 'already_decided');
    await until(() => gate.records().find((row) => row.type === 'rpc_send_refused'), 'checkpoint cancellation refusal');
    const status = resultBody(await gate.host.call('gate__status').response);
    assert.deepEqual(status.pendingHolds, []);
    assert.equal(gate.upstream.sent.length, 0);
    assert.ok(!gate.host.frames.some((frame) => frame.id === requestId), 'MCP cancelled requests get no response');
    assert.ok(!gate.records().some((row) => row.type === 'rpc_send_forwarded'));
  });

  test('a safe tool argument is approved before downstream signing, then reviewed and approved at the checkpoint', { timeout: 20_000 }, async (t) => {
    const gate = await startGate(t);
    const bytes = transferBytes(gate.wallet, gate.destination, 1_000_000n);
    const expectedHash = createHash('sha256').update(Buffer.from(bytes).subarray(65)).digest('hex');
    const call = gate.host.call('wallet__sign_and_send', { transaction: Buffer.from(bytes).toString('base64') });
    const argumentHold = await gate.waitHold();
    assert.equal(argumentHold.kind, 'tool-arg');
    assert.equal(argumentHold.messageSha256, expectedHash);
    assert.equal(gate.records().filter((row) => row.type === 'tx_review').length, 1);
    assert.equal(gate.upstream.sent.length, 0);
    assert.equal((await gate.approve(argumentHold)).status, 200);
    const checkpointHold = await gate.waitHold((hold) => hold.id !== argumentHold.id);
    assert.equal(checkpointHold.kind, 'rpc-send');
    assert.equal(checkpointHold.messageSha256, expectedHash, 'signing changes no approved message byte');
    assert.equal(gate.upstream.sent.length, 0);
    assert.equal((await gate.approve(checkpointHold)).status, 200);
    assert.equal((await call.response).result.isError, false);
    assert.equal(gate.upstream.sent.length, 1);
    await gate.stop();
    await auditCli(gate);
  });

  for (const listener of ['approval', 'checkpoint', 'websocket']) {
    test(`an occupied ${listener} port exits 2 and identifies the port`, { timeout: 10_000 }, async (t) => {
      const gate = await startGate(t, { bindFailure: listener });
      const { code } = await gate.finished;
      assert.equal(code, 2, gate.stderr);
      assert.match(gate.stderr, new RegExp(`\\b${gate.blockedPort}\\b`));
      assert.equal(gate.stdout, '');
      assert.equal(gate.upstream.sent.length, 0);
      assert.ok(!gate.records().some((row) => row.type === 'downstream_ready'));
    });
  }
});

test('fake ledger returns accepted wire bytes but preserves explicit transaction nulls and results', async (t) => {
  const wallet = runtimeKey();
  const bytes = transferBytes(wallet, runtimeKey().address, 1_000_000n, true);
  const signature = base58Encode(decodeTransaction(bytes).signatures[0]);
  for (const scripted of [undefined, null, { slot: 42, meta: { err: null }, transaction: ['scripted', 'base64'] }]) {
    const script = scripted === undefined ? {} : { transactions: { [signature]: scripted } };
    const upstream = await startFakeUpstream(script);
    t.after(() => upstream.close());
    async function rpc(method, params) {
      const res = await fetch(upstream.url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      return (await res.json()).result;
    }
    assert.equal(await rpc('sendTransaction', [Buffer.from(bytes).toString('base64'), { encoding: 'base64' }]), signature);
    const found = await rpc('getTransaction', [signature, { encoding: 'base64' }]);
    if (scripted !== undefined) assert.deepEqual(found, scripted);
    else {
      assert.equal(found.meta.err, null);
      assert.deepEqual(Buffer.from(found.transaction[0], 'base64'), Buffer.from(bytes));
      assert.equal(found.transaction[1], 'base64');
    }
    assert.equal(await rpc('getTransaction', [base58Encode(sign(null, Buffer.from('unknown'), wallet.privateKey))]), null);
  }
});

// Controlled RPC promises cover cancellation at the await boundaries that a
// child-process test cannot reliably hit. Both the queue and review are real.
function pipelineHarness(t, { pauseReview = false, toolArgument = false, memo = false, notifyEnabled = false, openBrowser = false } = {}) {
  const wallet = runtimeKey();
  const approver = runtimeKey();
  const destination = runtimeKey().address;
  const memoSecret = base58Encode(wallet.bytes);
  const bytes = memo ? transaction(message({
    header: [1, 0, 2], keys: [wallet.address, destination, SYSTEM, MEMO], blockhash: FAKE_BLOCKHASH,
    instructions: [
      { p: 2, a: [0, 1], d: data.systemTransfer(1_000_000n) },
      { p: 3, a: [], d: data.memo(`test-only memo ${memoSecret}`) },
    ],
  }), [wallet]) : transferBytes(wallet, destination, 1_000_000n, true);
  const hostController = new AbortController();
  const rpcController = new AbortController();
  const records = [];
  const notifications = [];
  const holds = new HoldQueue({ approver: approver.address });
  const config = {
    cluster: 'localnet', lists: { allowlist: [destination] },
    tools: { 'wallet.transfer_sol': toolArgument ? { mode: 'bound', txArg: 'transaction', txArgEncoding: 'base64' } : 'pass' },
    tx: {
      programs: [SYSTEM, MEMO], unknownProgram: 'deny', maxOutflow: { SOL: 0.05 },
      unknownMintOutflow: 'deny', destinations: '@allowlist',
      denyTokenDelegation: true, denyLegacyTokenTransfer: true, approval: 'always',
    },
    approval: { timeoutSec: 5, notify: notifyEnabled, openBrowser },
    servers: { wallet: { timeoutMs: 35_000 } },
  };
  let enterReview;
  const reviewEntered = new Promise((resolve) => { enterReview = resolve; });
  let continueReview;
  const reviewBarrier = pauseReview ? new Promise((resolve) => { continueReview = resolve; }) : Promise.resolve();
  const script = transferScript(wallet);
  const account = (value) => rpcAccount({ ...value, lamports: Number(value.lamports) });
  const rpc = {
    async call(method, params) {
      if (method === 'getTokenAccountsByOwner') return { value: [] };
      if (method === 'getMultipleAccounts') return { value: params[0].map((address) => account(script.accounts(address))) };
      if (method === 'simulateTransaction') {
        enterReview();
        await reviewBarrier;
        const post = script.simulate(0, params);
        return { value: { ...post, accounts: params[1].accounts.addresses.map((address) => account(post.accounts[address])) } };
      }
      throw new Error(`unmocked RPC ${method}`);
    },
  };
  let pipeline;
  let sendDecision;
  let downstreamCalls = 0;
  const downstreams = {
    ready: Promise.resolve(),
    list: () => [{ name: 'wallet__transfer_sol', server: 'wallet', tool: 'transfer_sol' }],
    async call() {
      downstreamCalls++;
      sendDecision = await pipeline.onRpcSend(bytes, { server: 'wallet', requestId: 9, signal: rpcController.signal });
      return { content: [{ type: 'text', text: JSON.stringify(sendDecision) }], isError: !sendDecision.forward };
    },
  };
  pipeline = createPipeline({
    config, getDownstreams: () => downstreams,
    audit: { append: (type, fields) => records.push({ type, ...fields }) },
    pettyCash: { publicKey: wallet.address }, policy: compileToolPolicy(config),
    txPolicy: compileTxPolicy(config.tx, config.lists), rpc, holds,
    approvalUrl: 'http://127.0.0.1:1',
    redact: (text) => text.replaceAll(memoSecret, '[scrubbed]'),
    notify: (options) => notifications.push(options),
  });
  t.after(async () => {
    hostController.abort();
    rpcController.abort();
    continueReview?.();
    await pipeline.close();
  });
  const run = () => pipeline.onToolCall({
    name: 'wallet__transfer_sol',
    args: toolArgument ? { transaction: Buffer.from(bytes).toString('base64') } : {},
    requestId: 1, signal: hostController.signal,
  });
  function approve(hold) {
    holds.approve(hold.id, {
      publicKey: approver.address,
      signature: sign(null, Buffer.from(hold.approvalMessage), approver.privateKey),
      method: 'wallet-signature',
    });
  }
  return {
    pipeline, records, holds, hostController, rpcController, reviewEntered, continueReview, run, approve, memoSecret, notifications,
    get sendDecision() { return sendDecision; }, get downstreamCalls() { return downstreamCalls; },
  };
}

test('result signatures come only from the documented parsed JSON fields and the exact result is hashed', () => {
  const key = runtimeKey();
  const signature = base58Encode(sign(null, Buffer.from('result signature probe'), key.privateKey));
  for (const name of ['signature', 'transactionId', 'txid', 'tx']) {
    const result = { content: [{ type: 'text', text: JSON.stringify({ nested: [{ [name]: signature }] }) }], isError: false };
    assert.deepEqual(summarizeResult(result), {
      resultSha256: createHash('sha256').update(JSON.stringify(result)).digest('hex'),
      isError: false, signature,
    });
  }
  for (const length of [86, 87, 88, 89, 90]) {
    const signatureText = '2'.repeat(length);
    const result = { content: [{ type: 'text', text: JSON.stringify({ signature: signatureText }) }] };
    assert.equal(summarizeResult(result).signature, signatureText);
  }
  assert.equal(summarizeResult({ structuredContent: { transactionId: signature }, isError: true }).signature, signature);
  for (const text of [
    `sent successfully: ${signature}`,
    JSON.stringify({ note: signature }),
    JSON.stringify({ signature: '2'.repeat(85) }),
    JSON.stringify({ signature: '2'.repeat(91) }),
    JSON.stringify({ signature: '0'.repeat(88) }),
    '{not-json',
  ]) {
    assert.ok(!('signature' in summarizeResult({ content: [{ type: 'text', text }] })), text);
  }
});

test('a runtime secret echoed in a memo is scrubbed from reviews, holds and approval HTTP views', async (t) => {
  const harness = pipelineHarness(t, { memo: true });
  const work = harness.run();
  const hold = await until(() => harness.holds.listPending()[0], 'redacted review hold');
  const review = harness.records.find((row) => row.type === 'tx_review');
  assert.ok(review.instructions.some((ix) => ix.kind === 'memo' && ix.text.includes('[scrubbed]')));
  for (const value of [review, hold, holdView(hold), harness.records]) {
    assert.ok(!JSON.stringify(value).includes(harness.memoSecret));
  }
  assert.match(hold.approvalMessage, new RegExp(hold.review.messageSha256));
  harness.hostController.abort();
  await work;
  assert.equal(harness.sendDecision.forward, false);
});

test('new holds dispatch the configured notification and browser options exactly once', async (t) => {
  for (const [notifyEnabled, openBrowser] of [[false, false], [true, false], [false, true], [true, true]]) {
    const harness = pipelineHarness(t, { notifyEnabled, openBrowser });
    const work = harness.run();
    const hold = await until(() => harness.holds.listPending()[0], 'notification hold');
    assert.deepEqual(harness.notifications, notifyEnabled || openBrowser ? [{
      body: hold.review.summaryLine,
      url: 'http://127.0.0.1:1',
      enabled: true,
      openUrl: openBrowser,
    }] : []);
    harness.hostController.abort();
    await work;
  }
});

for (const toolArgument of [false, true]) {
  test(`cancelling during ${toolArgument ? 'tool-argument' : 'checkpoint'} review creates no approvable orphan`, { timeout: 5000 }, async (t) => {
    const harness = pipelineHarness(t, { pauseReview: true, toolArgument });
    const work = harness.run();
    await harness.reviewEntered;
    harness.hostController.abort();
    harness.continueReview();
    const result = await work;
    assert.equal(result.isError, true);
    assert.deepEqual(harness.holds.listPending(), []);
    assert.ok(!harness.records.some((row) => row.type === 'hold_created'));
    assert.ok(!harness.records.some((row) => row.type === 'rpc_send_forwarded'));
    if (toolArgument) {
      assert.equal(harness.downstreamCalls, 0);
      assert.equal(JSON.parse(result.content[0].text).code, 'approval_rejected');
    } else {
      assert.equal(harness.sendDecision.forward, false);
      assert.equal(harness.sendDecision.data.reason, 'cancelled');
    }
  });
}

for (const source of ['host', 'checkpoint']) {
  test(`${source} abort immediately after a valid approval refuses the send`, async (t) => {
    const harness = pipelineHarness(t);
    const work = harness.run();
    const hold = await until(() => harness.holds.listPending()[0], 'direct pipeline hold');
    // approve() settles the queue synchronously; abort in the same turn before
    // its promise continuation can return a forwarding decision to T5.
    harness.approve(hold);
    (source === 'host' ? harness.hostController : harness.rpcController).abort();
    await work;
    assert.equal(harness.sendDecision.forward, false);
    assert.equal(harness.sendDecision.code, -32099);
    assert.equal(harness.sendDecision.data.code, 'approval_rejected');
    assert.equal(harness.sendDecision.data.reason, 'cancelled');
    assert.ok(harness.records.some((row) => row.type === 'hold_approved'));
    assert.ok(harness.records.some((row) => row.type === 'rpc_send_refused'));
    assert.ok(!harness.records.some((row) => row.type === 'rpc_send_forwarded'));
    assert.deepEqual(harness.holds.listPending(), []);
  });
}
