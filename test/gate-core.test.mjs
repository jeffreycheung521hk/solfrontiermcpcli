// Gate core: session additions, downstreams, host server, and the full
// host -> gate -> downstream stdio round trip.
//
// The env-echo downstream below is written to a temp dir at runtime rather
// than checked in: test/fixtures/ belongs to another card, and a fixture that
// only reports env NAMES (never values) is small enough to live here.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { PassThrough } from 'node:stream';
import { createHash, generateKeyPairSync } from 'node:crypto';

import { McpSession, stripChildEnv } from '../src/mcp/session.mjs';
import { CLI, FAKE, ROOT } from './helpers.mjs';

// Reports what it was given without ever echoing a value that could be a
// secret: env names, execPath, cwd, the rpc var's value (Gate's own
// checkpoint URL, never the real upstream), and only sha256 + length of the
// wallet var.
export const ENV_ECHO_SOURCE = `
import process from 'node:process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valueOf = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const rpcVar = valueOf('--rpc-var');
const walletVar = valueOf('--wallet-var');
const leak = valueOf('--leak-stderr');
if (valueOf('--marker')) writeFileSync(valueOf('--marker'), 'started');
if (has('--fail-start')) { process.stderr.write('boom: cannot start\\n'); process.exit(7); }
if (leak) process.stderr.write('leaking ' + process.env[leak] + '\\n');
let pendingAsk = null;
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }
function report() {
  const w = walletVar ? process.env[walletVar] : undefined;
  return {
    envNames: Object.keys(process.env).sort(),
    execPath: process.execPath,
    cwd: process.cwd(),
    argv,
    marker: valueOf('--marker') ?? null,
    rpc: rpcVar ? process.env[rpcVar] ?? null : null,
    wallet: w === undefined ? null : { sha256: createHash('sha256').update(w).digest('hex'), length: w.length },
  };
}
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.method === undefined && pendingAsk && msg.id === 'ask-1') {
      const id = pendingAsk; pendingAsk = null;
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(msg) }] } });
      continue;
    }
    if (msg.id === undefined) continue;
    if (msg.method === 'initialize') {
      send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'env-echo', version: '0' } } });
    } else if (msg.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: msg.id, result: { tools: [
        { name: 'env_report', description: 'env names', inputSchema: { type: 'object' } },
        { name: 'leak', description: 'prints a var to stderr and returns it', inputSchema: { type: 'object' } },
        { name: 'client_reply', description: 'asks the client something', inputSchema: { type: 'object' } },
        { name: 'bad name!', description: 'invalid', inputSchema: { type: 'object' } },
      ] } });
    } else if (msg.method === 'tools/call') {
      const name = msg.params?.name;
      if (name === 'env_report') {
        send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(report()) }] } });
      } else if (name === 'leak') {
        const v = process.env[msg.params?.arguments?.name] ?? '';
        process.stderr.write('leak: ' + v + '\\n');
        send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'value=' + v }] } });
      } else if (name === 'client_reply' && has('--ask-client')) {
        pendingAsk = msg.id;
        send({ jsonrpc: '2.0', id: 'ask-1', method: 'sampling/createMessage', params: {} });
      } else {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'unknown tool' } });
      }
    } else {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } });
    }
  }
});
`;

const fake = (...parts) => parts.join('');

let dir;
let ENV_ECHO;
before(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'sfgate-core-'));
  ENV_ECHO = path.join(dir, 'env-echo.mjs');
  writeFileSync(ENV_ECHO, ENV_ECHO_SOURCE);
});
after(() => rmSync(dir, { recursive: true, force: true }));

function textOf(result) {
  return (result?.content ?? []).map((c) => c.text ?? '').join('');
}

describe('McpSession additions', () => {
  test('defaults are unchanged: --db is appended and env is sanitized', async () => {
    const s = new McpSession({ serverBin: process.execPath, serverArgs: [ENV_ECHO], dbPath: path.join(dir, 'x.db') });
    assert.equal(s.appendDb, true);
    const env = s.childEnv({ PATH: '/bin', MY_API_KEY: fake('sk', '_live_0123456789') });
    assert.deepEqual(Object.keys(env), ['PATH']);
    s.start();
    try {
      await s.initialize();
      const report = JSON.parse(textOf(await s.callToolRaw('env_report', {})));
      assert.deepEqual(report.argv.slice(-2), ['--db', path.join(dir, 'x.db')]);
    } finally {
      await s.close();
    }
  });

  test('appendDb false, stripEnv, extraEnv and cwd reach the child', async () => {
    const prev = process.env.SFGATE_TEST_HIDDEN;
    process.env.SFGATE_TEST_HIDDEN = 'hidden-value';
    process.env.GATE_NAMED_VAR = 'also-hidden';
    const s = new McpSession({
      serverBin: process.execPath,
      serverArgs: [ENV_ECHO, '--rpc-var', 'RPC_URL'],
      appendDb: false,
      stripEnv: [/^SFGATE_/i, 'gate_named_var'],
      extraEnv: { RPC_URL: 'http://127.0.0.1:9', PRIVATE_KEY: 'injected' },
      cwd: dir,
    }).start();
    try {
      await s.initialize();
      const report = JSON.parse(textOf(await s.callToolRaw('env_report', {})));
      assert.ok(!report.argv.includes('--db'));
      assert.ok(!report.envNames.includes('SFGATE_TEST_HIDDEN'));
      assert.ok(!report.envNames.includes('GATE_NAMED_VAR'));
      assert.ok(report.envNames.includes('PRIVATE_KEY'), 'explicit injection wins over the blocklist');
      assert.equal(report.rpc, 'http://127.0.0.1:9');
      assert.equal(path.resolve(report.cwd), path.resolve(dir));
    } finally {
      await s.close();
      if (prev === undefined) delete process.env.SFGATE_TEST_HIDDEN;
      else process.env.SFGATE_TEST_HIDDEN = prev;
      delete process.env.GATE_NAMED_VAR;
    }
  });

  test('stripChildEnv matches names case-insensitively and RegExps', () => {
    const out = stripChildEnv({ A: '1', b_x: '2', SFGATE_Y: '3', keep: '4' }, ['a', 'B_X', /^sfgate_/i]);
    assert.deepEqual(out, { keep: '4' });
  });

  test('callToolRaw returns the raw result and throws TransportError on a JSON-RPC error', async () => {
    const s = new McpSession({ serverBin: process.execPath, serverArgs: [FAKE], appendDb: false }).start();
    try {
      await s.initialize();
      const result = await s.callToolRaw('echo_tool', { text: 'hi' });
      assert.equal(result.isError, false);
      assert.equal(JSON.parse(result.content[0].text).echoed.text, 'hi');
    } finally {
      await s.close();
    }
    const bad = new McpSession({ serverBin: process.execPath, serverArgs: [FAKE, '--rpc-error'], appendDb: false }).start();
    try {
      await bad.initialize();
      await assert.rejects(bad.callToolRaw('echo_tool', { text: 'hi' }), (err) => err.exitCode === 3);
    } finally {
      await bad.close();
    }
  });

  test('a server->client request is answered with -32601 instead of hanging', async () => {
    const s = new McpSession({ serverBin: process.execPath, serverArgs: [ENV_ECHO, '--ask-client'], appendDb: false }).start();
    try {
      await s.initialize();
      const reply = JSON.parse(textOf(await s.callToolRaw('client_reply', {}, { timeoutMs: 5000 })));
      assert.equal(reply.id, 'ask-1');
      assert.equal(reply.error.code, -32601);
    } finally {
      await s.close();
    }
  });
});

// --- host server --------------------------------------------------------

import { createHostServer } from '../src/gate/host-server.mjs';
import { startDownstreams, splitToolName, downstreamEnv } from '../src/gate/downstreams.mjs';
import { loadGateConfig, loadPettyCash, base58Encode, walletValue } from '../src/gate/config.mjs';
import { AuditLog, verifyChainText } from '../src/gate/audit-log.mjs';
import { LineFramer } from '../src/mcp/framing.mjs';

function hostHarness(handlers) {
  const input = new PassThrough();
  const output = new PassThrough();
  const framer = new LineFramer();
  const lines = [];
  const waiters = [];
  output.on('data', (chunk) => {
    for (const line of framer.push(chunk)) {
      lines.push(line);
      const msg = JSON.parse(line);
      for (const w of waiters.splice(0)) w.check(msg) || waiters.push(w);
    }
  });
  const server = createHostServer({ input, output, handlers, version: '9.9.9' });
  const responseTo = (id, ms = 3000) =>
    new Promise((resolve, reject) => {
      const found = lines.map((l) => JSON.parse(l)).find((m) => m.id === id);
      if (found) return resolve(found);
      const timer = setTimeout(() => reject(new Error(`no response to ${id}`)), ms);
      waiters.push({ check: (m) => (m.id === id ? (clearTimeout(timer), resolve(m), true) : false) });
    });
  const send = (obj) => input.write(typeof obj === 'string' ? `${obj}\n` : `${JSON.stringify(obj)}\n`);
  return { input, output, lines, server, responseTo, send };
}

describe('host server', () => {
  const handlers = {
    listTools: async () => [{ name: 'x__y', inputSchema: { type: 'object' } }],
    callTool: async ({ name, args, signal }) => {
      if (name === 'slow') {
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, 2000);
          signal.addEventListener('abort', () => (clearTimeout(t), reject(new Error('aborted'))));
        });
      }
      if (name === 'boom') throw new Error('kaboom');
      return { content: [{ type: 'text', text: JSON.stringify({ name, args }) }] };
    },
  };

  test('initialize echoes a supported protocol version, else 2025-06-18', async () => {
    const h = hostHarness(handlers);
    h.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
    h.send({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
    const a = await h.responseTo(1);
    const b = await h.responseTo(2);
    assert.equal(a.result.protocolVersion, '2025-03-26');
    assert.equal(b.result.protocolVersion, '2025-06-18');
    assert.deepEqual(a.result.capabilities, { tools: { listChanged: false } });
    assert.deepEqual(a.result.serverInfo, { name: 'solfrontier-gate', version: '9.9.9' });
    h.input.end();
    await h.server.closed;
  });

  test('ping -> {}; unknown method -> -32601; empty lists; notifications get nothing', async () => {
    const h = hostHarness(handlers);
    h.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    h.send({ jsonrpc: '2.0', id: 'p', method: 'ping' });
    h.send({ jsonrpc: '2.0', id: 'u', method: 'server/discover' });
    h.send({ jsonrpc: '2.0', id: 'r', method: 'resources/list' });
    h.send({ jsonrpc: '2.0', id: 'rt', method: 'resources/templates/list' });
    h.send({ jsonrpc: '2.0', id: 'pr', method: 'prompts/list' });
    h.send({ jsonrpc: '2.0', id: 't', method: 'tools/list' });
    assert.deepEqual((await h.responseTo('p')).result, {});
    assert.equal((await h.responseTo('u')).error.code, -32601);
    assert.deepEqual((await h.responseTo('r')).result, { resources: [] });
    assert.deepEqual((await h.responseTo('rt')).result, { resourceTemplates: [] });
    assert.deepEqual((await h.responseTo('pr')).result, { prompts: [] });
    assert.equal((await h.responseTo('t')).result.tools[0].name, 'x__y');
    assert.equal(h.lines.length, 6, 'the notification produced no frame');
    h.input.end();
    await h.server.closed;
  });

  test('malformed line -> -32700 with id null, and the server keeps going', async () => {
    const h = hostHarness(handlers);
    h.send('{this is not json');
    h.send('[{"jsonrpc":"2.0","id":5,"method":"ping"}]');
    h.send({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: {} });
    h.send({ jsonrpc: '2.0', id: 7, method: 'ping' });
    await h.responseTo(7);
    const msgs = h.lines.map((l) => JSON.parse(l));
    assert.deepEqual(msgs[0], { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    assert.equal(msgs[1].error.code, -32600);
    assert.equal(msgs.find((m) => m.id === 6).error.code, -32602);
    h.input.end();
    await h.server.closed;
  });

  test('calls run concurrently; a cancelled request gets no response', async () => {
    const h = hostHarness(handlers);
    h.send({ jsonrpc: '2.0', id: 'slow-1', method: 'tools/call', params: { name: 'slow', arguments: {} } });
    h.send({ jsonrpc: '2.0', id: 'fast', method: 'tools/call', params: { name: 'quick', arguments: { a: 1 } } });
    const fast = await h.responseTo('fast');
    assert.deepEqual(JSON.parse(fast.result.content[0].text), { name: 'quick', args: { a: 1 } });
    h.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'slow-1', reason: 'user' } });
    h.send({ jsonrpc: '2.0', id: 'boom', method: 'tools/call', params: { name: 'boom' } });
    assert.equal((await h.responseTo('boom')).error.code, -32603);
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(!h.lines.some((l) => JSON.parse(l).id === 'slow-1'), 'cancelled request was answered');
    assert.equal(h.server.inFlight(), 0);
    h.input.end();
    await h.server.closed;
  });
});

// --- downstreams ---------------------------------------------------------

function runtimeKeypair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const d = Buffer.from(privateKey.export({ format: 'jwk' }).d, 'base64url');
  const x = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  return { bytes: [...d, ...x], publicKey: base58Encode(x) };
}

let cfgN = 0;
function writeGateConfig(servers, extra = {}) {
  const file = path.join(dir, `gate-${++cfgN}.json`);
  writeFileSync(
    file,
    JSON.stringify({
      _comment: 'test config',
      cluster: 'devnet',
      upstreamRpcEnv: 'SFGATE_UPSTREAM_RPC_URL',
      pettyCash: { pathEnv: 'SFGATE_PETTY_CASH_PATH' },
      approver: runtimeKeypair().publicKey,
      servers,
      audit: { path: `./audit-${cfgN}.jsonl` },
      ...extra,
    }),
  );
  return file;
}

function gateEnv() {
  const kp = runtimeKeypair();
  const kpFile = path.join(dir, `petty-${cfgN}-${kp.publicKey.slice(0, 6)}.json`);
  writeFileSync(kpFile, JSON.stringify(kp.bytes));
  const apiKey = createHash('sha256').update(kp.publicKey).digest('hex').slice(0, 24);
  return {
    kp,
    kpFile,
    url: ['https://rpc.example.test/?api-key=', apiKey].join(''),
    apiKey,
  };
}

describe('downstreams', () => {
  test('env: rpcVar, walletVar, no SFGATE_*, no config-named var, no blocked var; node = execPath', async () => {
    const g = gateEnv();
    const env = {
      SFGATE_UPSTREAM_RPC_URL: g.url,
      SFGATE_PETTY_CASH_PATH: g.kpFile,
    };
    const file = writeGateConfig({
      echo: {
        command: 'node',
        args: [ENV_ECHO, '--rpc-var', 'RPC_URL', '--wallet-var', 'PRIVATE_KEY'],
        rpcVar: 'RPC_URL',
        walletVar: 'PRIVATE_KEY',
        env: { CLUSTER: 'devnet' },
      },
      json: {
        command: 'node',
        args: [ENV_ECHO, '--rpc-var', 'SOLANA_RPC_URL', '--wallet-var', 'WALLET_JSON'],
        rpcVar: 'SOLANA_RPC_URL',
        walletVar: 'WALLET_JSON',
        walletFormat: 'json-array',
      },
    });
    const config = loadGateConfig(file, env);
    const pettyCash = loadPettyCash(config, env);
    // The parent env the children inherit from: decoys of every kind.
    const saved = { ...process.env };
    Object.assign(process.env, env, {
      SFGATE_DECOY: 'decoy-value-123',
      MY_API_KEY: ['sk', '_live_0123456789abcdef'].join(''),
      SOLFRONTIER_CONTROLLED_WALLET_KEYPAIR: path.join(dir, 'k.json'),
    });
    let ds;
    try {
      for (const checkpointUrl of [null, 'http://127.0.0.1:18899']) {
        ds = startDownstreams(config, { checkpointUrl, pettyCash, log: () => {} });
        await ds.ready;
        for (const [server, rpcName, walletName, format] of [
          ['echo', 'RPC_URL', 'PRIVATE_KEY', 'base58-64'],
          ['json', 'SOLANA_RPC_URL', 'WALLET_JSON', 'json-array'],
        ]) {
          const report = JSON.parse(textOf(await ds.call(server, 'env_report', {})));
          assert.equal(report.rpc, checkpointUrl ? `${checkpointUrl}/s/${server}` : 'http://127.0.0.1:9');
          const expected = walletValue(pettyCash, format);
          assert.deepEqual(report.wallet, {
            sha256: createHash('sha256').update(expected).digest('hex'),
            length: expected.length,
          });
          assert.ok(report.envNames.includes(rpcName) && report.envNames.includes(walletName));
          assert.ok(!report.envNames.some((k) => /^SFGATE_/i.test(k)), report.envNames.join(','));
          for (const blocked of ['MY_API_KEY', 'SOLFRONTIER_CONTROLLED_WALLET_KEYPAIR', ...config.envNames]) {
            assert.ok(!report.envNames.includes(blocked), `${blocked} reached the downstream`);
          }
          assert.equal(report.execPath, process.execPath);
          assert.equal(path.resolve(report.cwd), path.resolve(dir));
          assert.ok(!report.argv.includes('--db'));
        }
        await ds.close();
      }
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });

  test('a downstream that fails to start is recorded; the others keep working', async () => {
    const file = writeGateConfig(
      {
        bad: { command: 'node', args: [ENV_ECHO, '--fail-start'] },
        good: { command: 'node', args: [FAKE] },
      },
      { pettyCash: undefined },
    );
    const config = loadGateConfig(file, { SFGATE_UPSTREAM_RPC_URL: 'https://a.test' });
    const audit = AuditLog.open(config.audit.path);
    const logged = [];
    const ds = startDownstreams(config, { audit, log: (l) => logged.push(l) });
    await ds.ready;
    const status = Object.fromEntries(ds.status().map((s) => [s.server, s]));
    assert.equal(status.bad.state, 'failed');
    assert.equal(status.good.state, 'ready');
    assert.deepEqual(ds.list().map((t) => t.name).sort(), ['good__echo_tool', 'good__strict_tool']);
    const result = await ds.call('good', 'echo_tool', { text: 'still works' });
    assert.equal(JSON.parse(result.content[0].text).echoed.text, 'still works');
    await assert.rejects(ds.call('bad', 'env_report', {}), /not available/);
    await assert.rejects(ds.call('good', 'unlisted', {}), /did not list/);
    assert.ok(logged.some((l) => l.includes('boom: cannot start')), 'stderr tail is shown to the human');
    const text = readFileSync(config.audit.path, 'utf8');
    assert.ok(verifyChainText(text).ok);
    const types = text.trim().split('\n').map((l) => JSON.parse(l).type).sort();
    assert.deepEqual(types, ['downstream_failed', 'downstream_ready']);
    assert.ok(!text.includes('boom: cannot start'), 'server free text stays out of the audit log');
    await ds.close();
  });

  test('tool names that are not host-safe are skipped; splitToolName', async () => {
    const file = writeGateConfig({ e: { command: 'node', args: [ENV_ECHO] } }, { pettyCash: undefined });
    const config = loadGateConfig(file, { SFGATE_UPSTREAM_RPC_URL: 'https://a.test' });
    const ds = startDownstreams(config, { log: () => {} });
    await ds.ready;
    assert.deepEqual(ds.list().map((t) => t.name).sort(), ['e__client_reply', 'e__env_report', 'e__leak']);
    await ds.close();
    assert.deepEqual(splitToolName('my-srv__do__it'), { server: 'my-srv', tool: 'do__it' });
    assert.equal(splitToolName('__x'), null);
    assert.equal(splitToolName('plain'), null);
    assert.throws(() => downstreamEnv('w', { env: {}, walletVar: 'K', walletFormat: 'base58-64' }, {}), /no petty-cash/);
  });
});

// --- gate run, end to end --------------------------------------------------

function startGate(configPath, env, extraArgs = []) {
  const child = spawn(process.execPath, [CLI, 'gate', 'run', configPath, ...extraArgs], {
    cwd: ROOT,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const framer = new LineFramer();
  const stdoutLines = [];
  const waiters = new Map();
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => (stderr += d));
  child.stdout.on('data', (chunk) => {
    for (const line of framer.push(chunk)) {
      stdoutLines.push(line);
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      waiters.get(msg.id)?.(msg);
    }
  });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  let nextId = 1;
  return {
    child,
    stdoutLines,
    get stderr() {
      return stderr;
    },
    exited,
    request(method, params, ms = 15000) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${method} timed out; stderr:\n${stderr}`)), ms);
        waiters.set(id, (msg) => (clearTimeout(timer), resolve(msg)));
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    },
    async stop() {
      child.stdin.end();
      return exited;
    },
  };
}

function baseEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const k of Object.keys(env)) if (/^SFGATE_/i.test(k) && !(k in extra)) delete env[k];
  return env;
}

describe('gate run (stdio round trip)', () => {
  test('host -> gate -> fake server: initialize, tools/list, tools/call verbatim; stdout is pure JSON-RPC', async () => {
    const g = gateEnv();
    // T2: default deny (I1); this round trip is about forwarding, so pass both tools.
    const file = writeGateConfig({ fake: { command: 'node', args: [FAKE, '--noisy-stderr'] } }, { tools: { 'fake.*': 'pass' } });
    const env = baseEnv({ SFGATE_UPSTREAM_RPC_URL: g.url, SFGATE_PETTY_CASH_PATH: g.kpFile });
    const gate = startGate(file, env);

    const init = await gate.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    assert.equal(init.result.serverInfo.name, 'solfrontier-gate');
    gate.notify('notifications/initialized', {});

    const list = await gate.request('tools/list', {});
    const names = list.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['fake__echo_tool', 'fake__strict_tool', 'gate__status']);

    // What the fake server returns when called directly, for comparison.
    const direct = new McpSession({ serverBin: process.execPath, serverArgs: [FAKE], appendDb: false }).start();
    await direct.initialize();
    const expected = await direct.callToolRaw('echo_tool', { text: 'hello', count: 2 });
    await direct.close();

    const call = await gate.request('tools/call', { name: 'fake__echo_tool', arguments: { text: 'hello', count: 2 } });
    assert.deepEqual(call.result, expected, 'result forwarded verbatim');

    const status = await gate.request('tools/call', { name: 'gate__status', arguments: {} });
    assert.equal(status.result.structuredContent.wallet, g.kp.publicKey);
    assert.equal(status.result.structuredContent.downstreams[0].state, 'ready');

    const unknown = await gate.request('tools/call', { name: 'fake__nope', arguments: {} });
    assert.equal(unknown.result.isError, true);
    assert.equal(unknown.result.structuredContent.code, 'unknown_tool');

    const ping = await gate.request('ping', {});
    assert.deepEqual(ping.result, {});

    assert.equal(await gate.stop(), 0, gate.stderr);

    // I10: every stdout line is a JSON-RPC frame.
    assert.ok(gate.stdoutLines.length >= 6);
    for (const line of gate.stdoutLines) {
      const msg = JSON.parse(line);
      assert.equal(msg.jsonrpc, '2.0', line);
      assert.ok('result' in msg || 'error' in msg, line);
    }
    assert.ok(!gate.stderr.includes(g.apiKey));

    const auditText = readFileSync(path.join(dir, `audit-${cfgN}.jsonl`), 'utf8');
    const verified = verifyChainText(auditText);
    assert.ok(verified.ok, JSON.stringify(verified));
    const records = auditText.trim().split('\n').map((l) => JSON.parse(l));
    const types = records.map((r) => r.type);
    assert.equal(types[0], 'gate_start');
    assert.equal(types.at(-1), 'gate_stop');
    for (const t of ['downstream_ready', 'tool_list', 'tool_call', 'tool_result']) assert.ok(types.includes(t), t);
    const fwd = records.find((r) => r.type === 'tool_call' && r.tool === 'fake__echo_tool');
    const res = records.find((r) => r.type === 'tool_result' && r.callId === fwd.callId);
    assert.equal(res.resultSha256, createHash('sha256').update(JSON.stringify(expected)).digest('hex'));
    assert.ok(records.indexOf(fwd) < records.indexOf(res), 'log, then act');
    assert.ok(!auditText.includes(g.apiKey) && !auditText.includes(g.kpFile));
  });

  test('secrets that reach stderr or a tool result come out redacted', async () => {
    const g = gateEnv();
    const wsUrl = g.url.replace('https://', 'wss://');
    const file = writeGateConfig({
      echo: {
        command: 'node',
        args: [ENV_ECHO],
        walletVar: 'PRIVATE_KEY',
        // Test-only: hand the downstream copies of Gate's secrets so it can leak them.
        env: { LEAK_URL: g.url, LEAK_WS: wsUrl },
      },
    }, { tools: { 'echo.leak': 'pass' } });
    const env = baseEnv({ SFGATE_UPSTREAM_RPC_URL: g.url, SFGATE_PETTY_CASH_PATH: g.kpFile });
    // --verbose echoes downstream stderr, which is where a leak would show.
    const gate = startGate(file, env, ['--verbose']);
    await gate.request('initialize', { protocolVersion: '2025-06-18' });
    const secretB58 = base58Encode(Uint8Array.from(g.kp.bytes));
    const texts = [];
    try {
      for (const name of ['LEAK_URL', 'LEAK_WS', 'PRIVATE_KEY']) {
        const res = await gate.request('tools/call', { name: 'echo__leak', arguments: { name } });
        texts.push(res.result.content[0].text);
      }
    } finally {
      assert.equal(await gate.stop(), 0);
    }
    for (const text of texts) assert.match(text, /^value=<[A-Za-z_-]*redacted>$/);
    const leakLines = gate.stderr.split('\n').filter((l) => l.includes('leak: '));
    assert.equal(leakLines.length, 3, gate.stderr);
    for (const line of leakLines) assert.match(line, /leak: <[A-Za-z_-]*redacted>$/);
    const all = gate.stderr + gate.stdoutLines.join('\n') + readFileSync(path.join(dir, `audit-${cfgN}.jsonl`), 'utf8');
    assert.ok(!all.includes(g.apiKey), 'api key leaked');
    assert.ok(!all.includes(secretB58), 'petty-cash secret leaked');
  });

  test('missing env var named by the config -> exit 2, clear stderr, no child spawned', async () => {
    const g = gateEnv();
    const marker = path.join(dir, `marker-${Date.now()}`);
    const file = writeGateConfig({ e: { command: 'node', args: [ENV_ECHO, '--marker', marker] } });
    const gate = startGate(file, baseEnv({ SFGATE_UPSTREAM_RPC_URL: g.url })); // no petty-cash var
    assert.equal(await gate.stop(), 2);
    assert.match(gate.stderr, /SFGATE_PETTY_CASH_PATH.*not set/);
    assert.equal(gate.stdoutLines.length, 0);
    assert.ok(!existsSync(marker), 'a downstream was spawned');
  });

  test('exit 2 before spawning: guardrail, missing petty-cash file, timeoutMs, broken audit log', async () => {
    const g = gateEnv();
    const marker = path.join(dir, `marker2-${Date.now()}`);
    const server = { command: 'node', args: [ENV_ECHO, '--marker', marker] };
    const env = baseEnv({ SFGATE_UPSTREAM_RPC_URL: g.url, SFGATE_PETTY_CASH_PATH: g.kpFile });

    const cases = [
      [writeGateConfig({ e: { ...server, env: { nested: 'x' } } }, { tx: { deep: { privateKey: 1 } } }), env, /privateKey/],
      [writeGateConfig({ e: server }, { surprise: true }), env, /unknown gate config key/],
      [writeGateConfig({ Bad_Name: server }), env, /server name/],
      [writeGateConfig({ e: { ...server, walletVar: 'PRIVATE_KEY' } }), { ...env, SFGATE_PETTY_CASH_PATH: path.join(dir, 'absent.json') }, /petty-cash.*does not exist/],
      [writeGateConfig({ e: { ...server, timeoutMs: 1000 } }), env, /timeoutMs/],
    ];
    const brokenCfg = writeGateConfig({ e: server });
    const brokenLog = path.join(dir, `audit-${cfgN}.jsonl`);
    const log = AuditLog.open(brokenLog);
    log.append('gate_start', {});
    log.append('gate_stop', {});
    writeFileSync(brokenLog, readFileSync(brokenLog, 'utf8').replace('gate_stop', 'gate_stip'));
    cases.push([brokenCfg, env, /line 2/]);

    for (const [file, e, re] of cases) {
      const gate = startGate(file, e);
      assert.equal(await gate.stop(), 2, gate.stderr);
      assert.match(gate.stderr, re);
      assert.equal(gate.stdoutLines.length, 0);
      assert.ok(!gate.stderr.includes(g.apiKey));
    }
    assert.ok(!existsSync(marker), 'a downstream was spawned');
  });
});
