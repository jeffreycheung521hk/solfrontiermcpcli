// Hermetic tests for the naive wallet fixture (T7). No network, no real keys: a runtime-generated
// Ed25519 key, the fixture driven over stdio, and test/fake-upstream-rpc.mjs standing in for the
// cluster. Binds port 0 (parallel-safe).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import path from 'node:path';
import process from 'node:process';
import { generateKeyPairSync, createPublicKey, verify as edVerify } from 'node:crypto';

import { ROOT } from './helpers.mjs';
import { startFakeUpstream, base58Encode, base58Decode } from './fake-upstream-rpc.mjs';

const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'naive-wallet-mcp.mjs');

/** A runtime Ed25519 key as { pubkey (base58), secretBase58 (64-byte base58), seed32, pub32 }. */
function runtimeKey() {
  const { privateKey } = generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' });
  const seed32 = new Uint8Array(Buffer.from(jwk.d, 'base64url'));
  const pub32 = new Uint8Array(Buffer.from(jwk.x, 'base64url'));
  const secret64 = new Uint8Array(64);
  secret64.set(seed32, 0);
  secret64.set(pub32, 32);
  return { pubkey: base58Encode(pub32), secretBase58: base58Encode(secret64), seed32, pub32 };
}

/** Ed25519 public KeyObject from 32 raw bytes. */
function publicKeyFromBytes(pub32) {
  return createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(pub32).toString('base64url') },
    format: 'jwk',
  });
}

/** Read a compact-u16 at offset; returns [value, nextOffset]. */
function readCompactU16(bytes, offset) {
  let value = 0;
  let shift = 0;
  let i = offset;
  for (;;) {
    const b = bytes[i++];
    value |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  return [value, i];
}

/** Decode a legacy wire transaction into its signature, message, and System-transfer fields. */
function decodeWireTransaction(bytes) {
  let [sigCount, off] = readCompactU16(bytes, 0);
  const signatures = [];
  for (let s = 0; s < sigCount; s++) {
    signatures.push(bytes.subarray(off, off + 64));
    off += 64;
  }
  const messageStart = off;
  const messageBytes = bytes.subarray(messageStart);

  // header (3), keys
  let p = messageStart + 3;
  let keyCount;
  [keyCount, p] = readCompactU16(bytes, p);
  const keys = [];
  for (let k = 0; k < keyCount; k++) {
    keys.push(base58Encode(bytes.subarray(p, p + 32)));
    p += 32;
  }
  const blockhash = base58Encode(bytes.subarray(p, p + 32));
  p += 32;
  let ixCount;
  [ixCount, p] = readCompactU16(bytes, p);
  const programIdIndex = bytes[p++];
  let accCount;
  [accCount, p] = readCompactU16(bytes, p);
  const accountIndexes = [];
  for (let a = 0; a < accCount; a++) accountIndexes.push(bytes[p++]);
  let dataLen;
  [dataLen, p] = readCompactU16(bytes, p);
  const data = bytes.subarray(p, p + dataLen);
  const view = Buffer.from(data);
  const tag = view.readUInt32LE(0);
  const lamports = view.readBigUInt64LE(4);

  return {
    signatures,
    messageBytes,
    keys,
    blockhash,
    ixCount,
    program: keys[programIdIndex],
    from: keys[accountIndexes[0]],
    to: keys[accountIndexes[1]],
    tag,
    lamports,
  };
}

/** Spawn the fixture and expose a line-oriented JSON-RPC client over its stdio. */
function spawnWallet({ rpcUrl, secretBase58, args = [], cluster = 'devnet' } = {}) {
  const child = spawn(process.execPath, [FIXTURE, ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      RPC_URL: rpcUrl,
      PRIVATE_KEY: secretBase58 ?? '',
      CLUSTER: cluster,
    },
  });
  let stdout = '';
  let stderr = '';
  const stdoutLines = [];
  const pending = new Map();
  let nextId = 1;
  const decoder = new StringDecoder('utf8');
  let buffer = '';

  child.stdout.on('data', (c) => {
    const s = decoder.write(c);
    stdout += s;
    buffer += s;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      stdoutLines.push(line);
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });

  function request(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 20_000);
      pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  return {
    child,
    request,
    get stdout() { return stdout; },
    get stderr() { return stderr; },
    get stdoutLines() { return stdoutLines; },
    close: () => new Promise((resolve) => {
      child.once('exit', resolve);
      child.stdin.end();
      setTimeout(() => { try { child.kill(); } catch {} }, 500);
    }),
  };
}

describe('naive wallet fixture', () => {
  test('imports nothing from src/', () => {
    const src = readFileSync(FIXTURE, 'utf8');
    // No import or dynamic import that reaches into src/.
    assert.ok(!/from\s+['"][^'"]*\/src\//.test(src), 'static import from src/ found');
    assert.ok(!/import\(\s*['"][^'"]*\/src\//.test(src), 'dynamic import from src/ found');
    assert.ok(!/\.\.\/src\//.test(src), 'relative path into src/ found');
  });

  test('transfer_sol builds a transaction whose signature verifies, with the right lamports and destination', async () => {
    const key = runtimeKey();
    const dest = runtimeKey().pubkey;
    const up = await startFakeUpstream({ balance: 2_000_000_000n });
    const w = spawnWallet({ rpcUrl: up.url, secretBase58: key.secretBase58 });
    try {
      await w.request('initialize', {});
      const res = await w.request('tools/call', { name: 'transfer_sol', arguments: { to: dest, amount: 0.001 } });
      assert.equal(res.result.isError, false, w.stderr);
      const body = JSON.parse(res.result.content[0].text);
      assert.ok(body.signature, 'a signature is returned');

      // The fake upstream recorded exactly one sendTransaction, base64-encoded.
      const sends = up.calls.filter((c) => c.method === 'sendTransaction');
      assert.equal(sends.length, 1);
      assert.equal(up.sent.length, 1);
      assert.equal(up.sent[0].encoding, 'base64');

      const decoded = decodeWireTransaction(up.sent[0].bytes);
      assert.equal(decoded.from, key.pubkey, 'fee payer is the wallet');
      assert.equal(decoded.to, dest, 'destination matches');
      assert.equal(decoded.tag, 2, 'System transfer tag');
      assert.equal(decoded.lamports, 1_000_000n, '0.001 SOL in lamports');

      // The returned signature is the first signature, and it verifies over the message bytes.
      assert.equal(base58Encode(decoded.signatures[0]), body.signature);
      const ok = edVerify(null, Buffer.from(decoded.messageBytes), publicKeyFromBytes(key.pub32), decoded.signatures[0]);
      assert.ok(ok, 'signature verifies under the wallet public key');
    } finally {
      await w.close();
      await up.close();
    }
  });

  test('sign_and_send signs and forwards exactly the given message bytes', async () => {
    const key = runtimeKey();
    const up = await startFakeUpstream({});
    const w = spawnWallet({ rpcUrl: up.url, secretBase58: key.secretBase58 });
    try {
      await w.request('initialize', {});
      // A plausible legacy wire tx: one (zeroed) signature slot, then an arbitrary message body.
      const messageBody = Buffer.from('sfgate sign_and_send exact-bytes probe payload 0123456789');
      const wire = Buffer.concat([Buffer.from([1]), Buffer.alloc(64), messageBody]);
      const res = await w.request('tools/call', { name: 'sign_and_send', arguments: { transaction: wire.toString('base64') } });
      assert.equal(res.result.isError, false, w.stderr);

      assert.equal(up.sent.length, 1);
      const bytes = up.sent[0].bytes;
      const [sigCount, off] = readCompactU16(bytes, 0);
      assert.equal(sigCount, 1);
      const forwardedMessage = bytes.subarray(off + sigCount * 64);
      assert.deepEqual(Buffer.from(forwardedMessage), messageBody, 'message bytes forwarded unchanged');

      // Slot-0 signature verifies over the message body under the wallet key.
      const sig = bytes.subarray(off, off + 64);
      assert.ok(edVerify(null, messageBody, publicKeyFromBytes(key.pub32), sig), 'fee-payer signature valid');
    } finally {
      await w.close();
      await up.close();
    }
  });

  test('token_info returns the demo prop text (and never signs or sends)', async () => {
    const key = runtimeKey();
    const up = await startFakeUpstream({});
    const w = spawnWallet({ rpcUrl: up.url, secretBase58: key.secretBase58 });
    try {
      await w.request('initialize', {});
      const res = await w.request('tools/call', { name: 'token_info', arguments: { mint: 'So11111111111111111111111111111111111111112' } });
      const body = JSON.parse(res.result.content[0].text);
      assert.match(body.text, /IMPORTANT SYSTEM NOTE/);
      assert.equal(up.sent.length, 0, 'token_info sends nothing');
    } finally {
      await w.close();
      await up.close();
    }
  });

  test('a JSON-RPC error from the RPC comes back as an isError tool result', async () => {
    const key = runtimeKey();
    const up = await startFakeUpstream({ errors: { getLatestBlockhash: { code: -32005, message: 'node is behind' } } });
    const w = spawnWallet({ rpcUrl: up.url, secretBase58: key.secretBase58 });
    try {
      await w.request('initialize', {});
      const res = await w.request('tools/call', { name: 'transfer_sol', arguments: { to: runtimeKey().pubkey, amount: 0.001 } });
      assert.equal(res.result.isError, true);
      const body = JSON.parse(res.result.content[0].text);
      assert.match(body.error, /node is behind/);
      assert.equal(up.sent.length, 0, 'nothing forwarded on error');
    } finally {
      await w.close();
      await up.close();
    }
  });

  test('--rogue attempts exactly one send and logs only to stderr', { timeout: 20_000 }, async () => {
    const key = runtimeKey();
    const up = await startFakeUpstream({ balance: 1_000_000_000n });
    const w = spawnWallet({ rpcUrl: up.url, secretBase58: key.secretBase58, args: ['--rogue'] });
    try {
      // The rogue fires 5s after start; wait past that, with no tool call in flight.
      await new Promise((r) => setTimeout(r, 7000));
      const sends = up.calls.filter((c) => c.method === 'sendTransaction');
      assert.equal(sends.length, 1, 'exactly one unsolicited send attempt');
      assert.equal(w.stdoutLines.length, 0, 'the rogue writes no MCP frames to stdout');
      assert.match(w.stderr, /rogue/i, 'the attempt is logged to stderr');
    } finally {
      await w.close();
      await up.close();
    }
  });

  test('no key material is printed to stdout or stderr (pubkey only)', async () => {
    const key = runtimeKey();
    const up = await startFakeUpstream({ balance: 1_000_000_000n });
    const w = spawnWallet({ rpcUrl: up.url, secretBase58: key.secretBase58 });
    try {
      await w.request('initialize', {});
      await w.request('tools/call', { name: 'get_balance', arguments: {} });
      // The base58 secret, and the raw JSON-array seed, must appear nowhere.
      assert.ok(!w.stdout.includes(key.secretBase58), 'secret base58 absent from stdout');
      assert.ok(!w.stderr.includes(key.secretBase58), 'secret base58 absent from stderr');
      const seedArray = JSON.stringify(Array.from(key.seed32));
      assert.ok(!w.stdout.includes(seedArray), 'seed array absent from stdout');
      assert.ok(!w.stderr.includes(seedArray), 'seed array absent from stderr');
      // The public key is fine to log.
      assert.ok(w.stderr.includes(key.pubkey), 'the public key is logged (expected)');
    } finally {
      await w.close();
      await up.close();
    }
  });
});
