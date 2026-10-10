// Gate config: guardrails, validation, petty cash, upstream URL, redactor.
// Every key, address and URL here is generated at runtime (I9).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, randomBytes } from 'node:crypto';

import {
  loadGateConfig,
  resolveUpstream,
  loadPettyCash,
  walletValue,
  createRedactor,
  base58Encode,
  base58Decode,
} from '../src/gate/config.mjs';
import { ROOT } from './helpers.mjs';

const fake = (...parts) => parts.join('');

/** A Solana CLI keypair (64 numbers) from a runtime Ed25519 key. */
export function runtimeKeypair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const d = Buffer.from(privateKey.export({ format: 'jwk' }).d, 'base64url');
  const x = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  return { bytes: [...d, ...x], publicKey: base58Encode(x) };
}

const address = () => runtimeKeypair().publicKey;

let dir;
before(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'sfgate-config-'));
});
after(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
function writeConfig(obj) {
  const file = path.join(dir, `cfg-${++n}.json`);
  writeFileSync(file, typeof obj === 'string' ? obj : JSON.stringify(obj));
  return file;
}

function baseConfig(overrides = {}) {
  return {
    cluster: 'devnet',
    upstreamRpcEnv: 'SFGATE_UPSTREAM_RPC_URL',
    approver: address(),
    servers: { fake: { command: 'node', args: ['x.mjs'] } },
    ...overrides,
  };
}

const ENV = { SFGATE_UPSTREAM_RPC_URL: fake('https://rpc.example.test/?api-key=', 'k3y0123456789') };

const usage = (re) => (err) => err.exitCode === 2 && (!re || re.test(err.message));

describe('loadGateConfig', () => {
  test('a minimal config loads with defaults, frozen', () => {
    const cfg = loadGateConfig(writeConfig(baseConfig()), ENV);
    assert.equal(cfg.cluster, 'devnet');
    assert.equal(cfg.servers.fake.timeoutMs, 90000);
    assert.equal(cfg.servers.fake.cwd, dir);
    assert.equal(cfg.approval.timeoutSec, 40);
    assert.equal(cfg.audit.path, path.join(dir, 'sfgate-audit.devnet.jsonl'));
    assert.ok(Object.isFrozen(cfg) && Object.isFrozen(cfg.servers.fake.args));
    assert.ok(!JSON.stringify(cfg).includes('rpc.example.test'), 'the URL is never stored');
  });

  test('secret-like key at any depth -> exit 2 (GuardrailError)', () => {
    for (const cfg of [
      baseConfig({ privateKey: 'x' }),
      baseConfig({ servers: { fake: { command: 'node', env: { PRIVATE_KEY: 'x' } } } }),
      baseConfig({ tools: { 'fake.a': { mode: 'bound', args: { deep: { rpc_url: 1 } } } } }),
      baseConfig({ tx: { seedPhrase: 'x' } }),
      baseConfig({ lists: { apiKeys: [] } }),
      baseConfig({ _secret_note: 'comments are on disk too' }),
    ]) {
      assert.throws(() => loadGateConfig(writeConfig(cfg), ENV), (err) => err.exitCode === 2 && err.guardrail === true);
    }
  });

  test('values may NAME secret variables', () => {
    const cfg = baseConfig({
      pettyCash: { pathEnv: 'SFGATE_PETTY_CASH_PATH' },
      servers: { fake: { command: 'node', walletVar: 'PRIVATE_KEY', rpcVar: 'RPC_URL' } },
    });
    const loaded = loadGateConfig(writeConfig(cfg), { ...ENV, SFGATE_PETTY_CASH_PATH: 'x' });
    assert.equal(loaded.servers.fake.walletVar, 'PRIVATE_KEY');
    assert.deepEqual(loaded.envNames, ['SFGATE_UPSTREAM_RPC_URL', 'SFGATE_PETTY_CASH_PATH']);
  });

  test('unknown top-level key -> exit 2; unknown server key -> exit 2', () => {
    assert.throws(() => loadGateConfig(writeConfig(baseConfig({ extra: 1 })), ENV), usage(/unknown gate config key "extra"/));
    assert.throws(
      () => loadGateConfig(writeConfig(baseConfig({ servers: { fake: { command: 'node', shell: true } } })), ENV),
      usage(/servers\.fake\.shell/),
    );
  });

  test('_comment keys are ignored at every level', () => {
    const cfg = baseConfig({
      _comment: 'top',
      servers: { fake: { _comment: 'inner', command: 'node' } },
      tx: { _comment: 'tx', approval: 'always' },
    });
    const loaded = loadGateConfig(writeConfig(cfg), ENV);
    assert.equal(loaded._comment, undefined);
    assert.equal(loaded.servers.fake._comment, undefined);
    assert.deepEqual(loaded.tx, { approval: 'always' });
  });

  test('bad server name -> exit 2', () => {
    for (const name of ['Wallet', 'has_underscore', 'a'.repeat(17), 'dot.ted', '']) {
      const cfg = baseConfig({ servers: { [name]: { command: 'node' } } });
      assert.throws(() => loadGateConfig(writeConfig(cfg), ENV), usage(/server name/), name);
    }
  });

  test('gate server name is reserved so downstreams cannot shadow gate__status', () => {
    const cfg = baseConfig({ servers: { gate: { command: 'node' } } });
    assert.throws(() => loadGateConfig(writeConfig(cfg), ENV), usage(/server name "gate" is reserved/));
    // A different namespace that merely contains the word remains valid.
    const allowed = baseConfig({ servers: { 'my-gate': { command: 'node' } } });
    assert.ok(loadGateConfig(writeConfig(allowed), ENV).servers['my-gate']);
  });

  test('missing env var named by the config -> exit 2', () => {
    assert.throws(() => loadGateConfig(writeConfig(baseConfig()), {}), usage(/SFGATE_UPSTREAM_RPC_URL.*not set/));
    const cfg = baseConfig({ pettyCash: { pathEnv: 'SFGATE_PETTY_CASH_PATH' } });
    assert.throws(() => loadGateConfig(writeConfig(cfg), ENV), usage(/SFGATE_PETTY_CASH_PATH.*not set/));
  });

  test('timeoutMs below (approval.timeoutSec + 30) x 1000 -> exit 2', () => {
    const cfg = baseConfig({ servers: { fake: { command: 'node', timeoutMs: 69999 } } });
    assert.throws(() => loadGateConfig(writeConfig(cfg), ENV), usage(/timeoutMs/));
    const ok = baseConfig({ approval: { timeoutSec: 10 }, servers: { fake: { command: 'node', timeoutMs: 40000 } } });
    assert.equal(loadGateConfig(writeConfig(ok), ENV).servers.fake.timeoutMs, 40000);
    assert.throws(() => loadGateConfig(writeConfig(baseConfig({ approval: { timeoutSec: 61 } })), ENV), usage(/timeoutSec/));
  });

  test('cluster, approver, local-button, env collisions, placeholders', () => {
    const bad = [
      baseConfig({ cluster: 'testnet' }),
      baseConfig({ approver: 'not-base58-0OIl' }),
      baseConfig({ approver: base58Encode(randomBytes(31)) }),
      baseConfig({ cluster: 'mainnet-beta', approval: { method: 'local-button' } }),
      baseConfig({ servers: { fake: { command: 'node', env: { SFGATE_X: 'y' } } } }),
      baseConfig({ servers: { fake: { command: 'node', env: { SFGATE_UPSTREAM_RPC_URL: 'y' } } } }),
      baseConfig({ servers: { fake: { command: 'node', rpcVar: 'SFGATE_UPSTREAM_RPC_URL' } } }),
      baseConfig({ servers: { fake: { command: 'node', walletVar: 'PRIVATE_KEY' } } }), // no pettyCash
      baseConfig({ servers: { fake: { command: 'node', args: ['REPLACE_WITH_PATH'] } } }),
      baseConfig({ approver: 'REPLACE_WITH_YOUR_PHANTOM_APPROVER_ADDRESS' }),
      baseConfig({ servers: {} }),
    ];
    for (const cfg of bad) assert.throws(() => loadGateConfig(writeConfig(cfg), ENV), usage(), JSON.stringify(cfg));
    const lb = baseConfig({ approval: { method: 'local-button' } });
    assert.equal(loadGateConfig(writeConfig(lb), ENV).approval.method, 'local-button');
  });

  test('unparseable or missing file -> exit 2', () => {
    assert.throws(() => loadGateConfig(writeConfig('{not json'), ENV), usage(/cannot read gate config/));
    assert.throws(() => loadGateConfig(path.join(dir, 'nope.json'), ENV), usage(/file not found/));
  });

  test('relative cwd and audit.path resolve against the config directory', () => {
    const cfg = baseConfig({ servers: { fake: { command: 'node', cwd: 'sub' } }, audit: { path: './logs/a.jsonl' } });
    const loaded = loadGateConfig(writeConfig(cfg), ENV);
    assert.equal(loaded.servers.fake.cwd, path.join(dir, 'sub'));
    assert.equal(loaded.audit.path, path.join(dir, 'logs', 'a.jsonl'));
  });
});

describe('examples/sfgate.*.example.json', () => {
  for (const name of ['sfgate.devnet.example.json', 'sfgate.mainnet-jupiter.example.json']) {
    test(`${name}: placeholders fail, runtime values load`, () => {
      const text = readFileSync(path.join(ROOT, 'examples', name), 'utf8');
      const env = { ...ENV, SFGATE_PETTY_CASH_PATH: path.join(dir, 'pc.json') };
      assert.throws(() => loadGateConfig(writeConfig(text), env), usage(/placeholder/));
      const filled = text
        .replaceAll('REPLACE_WITH_YOUR_PHANTOM_APPROVER_ADDRESS', address())
        .replaceAll('REPLACE_WITH_AN_ADDRESS_YOU_OWN', address())
        .replaceAll('REPLACE_WITH_ABSOLUTE_PATH', dir.replaceAll('\\', '/'));
      assert.ok(!filled.includes('REPLACE_WITH_'), 'every placeholder replaced');
      const cfg = loadGateConfig(writeConfig(filled), env);
      assert.ok(['devnet', 'mainnet-beta'].includes(cfg.cluster));
      assert.ok(Object.keys(cfg.servers).length > 0);
    });
  }
});

describe('resolveUpstream', () => {
  const cfg = { upstreamRpcEnv: 'U', upstreamWsEnv: null };
  test('https derives wss; never stored', () => {
    const secretUrl = fake('https://rpc.example.test/v2/', 'abcdef0123456789abcdef');
    const up = resolveUpstream(cfg, { U: secretUrl });
    assert.equal(up.url, secretUrl);
    assert.ok(up.wsUrl.startsWith('wss://rpc.example.test/v2/'));
  });
  test('http allowed only on loopback; errors never contain the URL', () => {
    assert.ok(resolveUpstream(cfg, { U: 'http://127.0.0.1:8899' }).wsUrl.startsWith('ws://127.0.0.1:8899'));
    const remote = fake('http://rpc.example.test/', 'tok3n0123456789');
    assert.throws(() => resolveUpstream(cfg, { U: remote }), (err) => err.exitCode === 2 && !err.message.includes('tok3n'));
    assert.throws(() => resolveUpstream(cfg, { U: 'not a url tok3n0123' }), (err) => !err.message.includes('tok3n'));
    assert.throws(() => resolveUpstream(cfg, {}), usage());
  });
  test('explicit ws var must be wss (ws only on loopback)', () => {
    const c = { upstreamRpcEnv: 'U', upstreamWsEnv: 'W' };
    assert.throws(() => resolveUpstream(c, { U: 'https://a.test', W: 'ws://a.test' }), usage());
    assert.equal(resolveUpstream(c, { U: 'https://a.test', W: 'wss://b.test/x' }).wsUrl, 'wss://b.test/x');
  });
});

describe('loadPettyCash', () => {
  const cfg = { pettyCash: { pathEnv: 'PC' } };
  test('loads a Solana CLI keypair; secret hidden from JSON', () => {
    const kp = runtimeKeypair();
    const file = path.join(dir, 'kp.json');
    writeFileSync(file, JSON.stringify(kp.bytes));
    const pc = loadPettyCash(cfg, { PC: file });
    assert.equal(pc.publicKey, kp.publicKey);
    assert.deepEqual([...pc.secretKey], kp.bytes);
    assert.equal(JSON.stringify(pc), JSON.stringify({ publicKey: kp.publicKey }));
    assert.deepEqual(Object.keys(pc), ['publicKey']);
    assert.equal(walletValue(pc, 'json-array'), JSON.stringify(kp.bytes));
    assert.deepEqual([...base58Decode(walletValue(pc, 'base58-64'))], kp.bytes);
  });
  test('missing or malformed file -> exit 2, path not in the message', () => {
    const missing = path.join(dir, 'missing-keyfile.json');
    assert.throws(() => loadPettyCash(cfg, { PC: missing }), (e) => e.exitCode === 2 && !e.message.includes('missing-keyfile'));
    const kp = runtimeKeypair();
    const cases = ['{', JSON.stringify(kp.bytes.slice(0, 63)), JSON.stringify([...kp.bytes.slice(0, 63), 256])];
    const mismatched = [...kp.bytes];
    mismatched[40] ^= 1;
    cases.push(JSON.stringify(mismatched));
    for (const body of cases) {
      const file = path.join(dir, 'bad-keyfile.json');
      writeFileSync(file, body);
      assert.throws(() => loadPettyCash(cfg, { PC: file }), (e) => e.exitCode === 2 && !e.message.includes('bad-keyfile'));
    }
  });
});

describe('createRedactor', () => {
  test('upstream URL, derived ws URL and petty-cash secret are redacted in every form', () => {
    const apiKey = randomBytes(12).toString('hex');
    const url = fake('https://rpc.example.test/?api-key=', apiKey);
    const wsUrl = fake('wss://rpc.example.test/?api-key=', apiKey);
    const kp = runtimeKeypair();
    const secret = Uint8Array.from(kp.bytes);
    const redact = createRedactor([url, wsUrl, secret]);
    const lines = [
      `upstream failed: ${url}`,
      `ws ${wsUrl}`,
      `key only ${apiKey}`,
      `b58 ${base58Encode(secret)}`,
      `arr ${JSON.stringify(kp.bytes)}`,
      `spaced [${kp.bytes.join(', ')}]`,
      `hex ${Buffer.from(secret).toString('hex')}`,
      `seed ${base58Encode(secret.subarray(0, 32))}`,
      JSON.stringify({ gate: 'refused', hint: `retry ${url}` }),
    ];
    for (const line of lines) {
      const out = redact(line);
      assert.ok(out.includes('<redacted>'), line);
      assert.ok(!out.includes(apiKey) && !out.includes(base58Encode(secret)), out);
      assert.ok(!out.includes(kp.bytes.slice(0, 32).join(',')), out);
    }
    // The public key is not a secret.
    assert.equal(redact(`pub ${kp.publicKey}`), `pub ${kp.publicKey}`);
  });
  test('short values are ignored (no redaction storms)', () => {
    assert.equal(createRedactor(['abc', '', null])('abc def'), 'abc def');
  });
});

describe('base58', () => {
  test('round trips with leading zeros', () => {
    for (const bytes of [new Uint8Array([0, 0, 1, 2]), randomBytes(32), new Uint8Array(0)]) {
      assert.deepEqual([...base58Decode(base58Encode(bytes))], [...bytes]);
    }
    assert.equal(base58Encode(new Uint8Array(32)), '1'.repeat(32));
    assert.throws(() => base58Decode('0OIl'));
  });
});
