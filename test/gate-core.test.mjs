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
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valueOf = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const rpcVar = valueOf('--rpc-var');
const walletVar = valueOf('--wallet-var');
const leak = valueOf('--leak-stderr');
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
