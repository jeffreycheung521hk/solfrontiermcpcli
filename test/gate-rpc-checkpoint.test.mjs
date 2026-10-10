// The loopback RPC checkpoint (SPEC §5.7, card T5).
//
// Everything here runs against loopback fakes: an in-test upstream that
// records the exact bytes it receives, and plain node:http clients that can
// set the headers a browser or a rebinding attack would. No fixed ports:
// test files run in parallel, so each checkpoint takes a free (port, port + 1)
// pair found at runtime and retries on EADDRINUSE.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import net from 'node:net';
import { randomBytes } from 'node:crypto';

import {
  startRpcCheckpoint,
  RPC_SEND_REFUSED,
  RPC_METHOD_DENIED,
  RPC_UPSTREAM_FAILED,
} from '../src/gate/rpc-checkpoint.mjs';

// A path and query shaped like a provider URL with a key in it. The marker is
// what the I4 assertions look for; it is not, and is not shaped like, a secret.
const UPSTREAM_PATH = '/v2/upstream-marker-path?api-key=upstream-marker-token';

function listenOn(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port, host: '127.0.0.1' }, () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

function closeQuietly(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

async function freePort() {
  const probe = net.createServer();
  const port = await listenOn(probe);
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/** startRpcCheckpoint on a free (port, port + 1) pair, retrying on EADDRINUSE. */
async function startCheckpoint(opts) {
  for (let attempt = 0; attempt < 25; attempt++) {
    const port = await freePort();
    if (port > 65534) continue;
    try {
      const cp = await startRpcCheckpoint({ ...opts, port });
      return { ...cp, port };
    } catch (err) {
      if (err.code === 'EADDRINUSE') continue;
      throw err;
    }
  }
  throw new Error('could not find a free port pair');
}

// The fake upstream answers with deliberately odd spacing and key order, so
// "verbatim" can only pass if the bytes really are passed through.
function defaultReply(bodyText) {
  const one = (c) => `{ "result" : {"value":42, "echo":${JSON.stringify(c.method)}},"jsonrpc":"2.0", "id" :${JSON.stringify(c.id ?? null)} }`;
  const parsed = JSON.parse(bodyText);
  return { body: Array.isArray(parsed) ? `[ ${parsed.map(one).join(' ,\n')} ]` : one(parsed) };
}

/** A loopback upstream that records every request body, byte for byte. */
async function fakeUpstream(reply = defaultReply) {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ body, url: req.url, headers: req.headers });
      const out = reply(body, req);
      res.writeHead(out.status ?? 200, { 'content-type': out.type ?? 'application/json', ...(out.headers ?? {}) });
      res.end(out.body);
    });
  });
  const port = await listenOn(server);
  return {
    url: `http://127.0.0.1:${port}${UPSTREAM_PATH}`,
    requests,
    close: () => closeQuietly(server),
  };
}

/** A raw HTTP request to the checkpoint; `headers` may override Host/Origin. */
function send(port, { path = '/', method = 'POST', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port,
      path,
      method,
      agent: false,
      headers: { 'content-type': 'application/json', ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const rpc = (id, method, params = []) => ({ jsonrpc: '2.0', id, method, params });

/** Upstream + checkpoint, torn down together. */
async function harness({ reply, onSend = async () => ({ forward: false, code: RPC_SEND_REFUSED, message: 'refused in test', data: {} }), ...rest } = {}) {
  const upstream = await fakeUpstream(reply);
  const sends = [];
  const cp = await startCheckpoint({
    upstreamUrl: upstream.url,
    onSend: async (bytes, meta) => { sends.push({ bytes, meta }); return onSend(bytes, meta); },
    ...rest,
  });
  return {
    upstream,
    cp,
    sends,
    post: (path, body, headers) => send(cp.port, { path, body, headers }),
    close: async () => { await cp.close(); await upstream.close(); },
  };
}

describe('reads pass through verbatim', () => {
  for (const path of ['/', '/s/wallet']) {
    test(`POST ${path}: upstream gets the request bytes, client gets the upstream bytes`, async () => {
      const h = await harness();
      try {
        const body = JSON.stringify(rpc(7, 'getBalance', ['11111111111111111111111111111111', { commitment: 'confirmed' }]));
        const res = await h.post(path, body);
        assert.equal(res.status, 200);
        assert.equal(h.upstream.requests.length, 1);
        assert.equal(h.upstream.requests[0].body, body);
        // The upstream's own path and query are used, not the client's path.
        assert.equal(h.upstream.requests[0].url, UPSTREAM_PATH);
        assert.equal(res.text, defaultReply(body).body);
        assert.equal(h.sends.length, 0);
      } finally {
        await h.close();
      }
    });
  }

  test('a batch of reads goes up as one request and comes back verbatim', async () => {
    const h = await harness();
    try {
      const body = JSON.stringify([rpc(1, 'getSlot'), rpc('two', 'getLatestBlockhash', [{ commitment: 'finalized' }])]);
      const res = await h.post('/s/wallet', body);
      assert.equal(h.upstream.requests.length, 1);
      assert.equal(h.upstream.requests[0].body, body);
      assert.equal(res.text, defaultReply(body).body);
    } finally {
      await h.close();
    }
  });

  test('GET /health answers ok without touching upstream', async () => {
    const h = await harness();
    try {
      const res = await send(h.cp.port, { path: '/health', method: 'GET' });
      assert.equal(res.status, 200);
      assert.equal(res.text, 'ok');
      assert.equal(h.upstream.requests.length, 0);
    } finally {
      await h.close();
    }
  });
});

describe('routing', () => {
  test('a bad server name in the path is 404 and reaches nothing', async () => {
    const h = await harness();
    try {
      const body = JSON.stringify(rpc(1, 'getSlot'));
      for (const path of ['/s/Wallet', '/s/', '/s/a_b', '/s/abcdefghijklmnopq', '/s/wallet/x', '/s/wallet/', '/x', '/s/..%2f', '//s/wallet']) {
        const res = await h.post(path, body);
        assert.equal(res.status, 404, path);
      }
      assert.equal(h.upstream.requests.length, 0);
    } finally {
      await h.close();
    }
  });

  test('only POST is accepted on RPC paths', async () => {
    const h = await harness();
    try {
      for (const method of ['GET', 'PUT', 'DELETE', 'OPTIONS']) {
        const res = await send(h.cp.port, { path: '/s/wallet', method });
        assert.equal(res.status, 405, method);
      }
      assert.equal(h.upstream.requests.length, 0);
    } finally {
      await h.close();
    }
  });
});

describe('I11: loopback only', () => {
  test('a wrong Host is 403', async () => {
    const h = await harness();
    try {
      const body = JSON.stringify(rpc(1, 'getSlot'));
      for (const host of ['evil.example', `evil.example:${h.cp.port}`, `127.0.0.1:${h.cp.port + 5}`, '127.0.0.1', `0.0.0.0:${h.cp.port}`]) {
        const res = await h.post('/', body, { host });
        assert.equal(res.status, 403, host);
      }
      assert.equal(h.upstream.requests.length, 0);
    } finally {
      await h.close();
    }
  });

  test('localhost:<port> is accepted as a Host', async () => {
    const h = await harness();
    try {
      const res = await h.post('/', JSON.stringify(rpc(1, 'getSlot')), { host: `localhost:${h.cp.port}` });
      assert.equal(res.status, 200);
    } finally {
      await h.close();
    }
  });

  test('a foreign Origin is 403; the checkpoint\'s own origin is not', async () => {
    const h = await harness();
    try {
      const body = JSON.stringify(rpc(1, 'getSlot'));
      for (const origin of ['https://evil.example', 'null', `http://127.0.0.1:${h.cp.port + 1}`, `https://127.0.0.1:${h.cp.port}`, '']) {
        const res = await h.post('/', body, { origin });
        assert.equal(res.status, 403, JSON.stringify(origin));
      }
      assert.equal(h.upstream.requests.length, 0);
      const own = await h.post('/', body, { origin: `http://127.0.0.1:${h.cp.port}` });
      assert.equal(own.status, 200);
    } finally {
      await h.close();
    }
  });
});

describe('JSON-RPC handling', () => {
  test('non-JSON is -32700', async () => {
    const h = await harness();
    try {
      const res = await h.post('/', '{"jsonrpc":"2.0",');
      assert.equal(JSON.parse(res.text).error.code, -32700);
      assert.equal(h.upstream.requests.length, 0);
    } finally {
      await h.close();
    }
  });

  test('an empty batch and a call without a method are -32600', async () => {
    const h = await harness();
    try {
      assert.equal(JSON.parse((await h.post('/', '[]')).text).error.code, -32600);
      const single = JSON.parse((await h.post('/', JSON.stringify({ jsonrpc: '2.0', id: 4 }))).text);
      assert.deepEqual([single.id, single.error.code], [4, -32600]);
      assert.equal(h.upstream.requests.length, 0);
    } finally {
      await h.close();
    }
  });

  test('a body over 2 MB is refused with 413', async () => {
    const h = await harness();
    try {
      const big = JSON.stringify(rpc(1, 'getSlot', ['x'.repeat(2 * 1024 * 1024)]));
      const res = await h.post('/', big);
      assert.equal(res.status, 413);
      assert.equal(h.upstream.requests.length, 0);
    } finally {
      await h.close();
    }
  });

  test('sendBundle is -32098 and never reaches upstream', async () => {
    const h = await harness();
    try {
      const res = JSON.parse((await h.post('/s/wallet', JSON.stringify(rpc(9, 'sendBundle', [['AAAA']])))).text);
      assert.equal(res.id, 9);
      assert.equal(res.error.code, RPC_METHOD_DENIED);
      assert.match(res.error.message, /^SolFrontier Gate: /);
      assert.equal(h.upstream.requests.length, 0);
    } finally {
      await h.close();
    }
  });

  test('send-shaped methods are refused even when not listed (I1)', async () => {
    const h = await harness({ deniedMethods: [] });
    try {
      for (const method of ['sendBundle', 'SendTransaction', 'sendtransaction', ' sendTransaction', 'sendRawTransaction']) {
        const res = JSON.parse((await h.post('/', JSON.stringify(rpc(1, method, ['AAAA'])))).text);
        assert.equal(res.error.code, RPC_METHOD_DENIED, method);
      }
      assert.equal(h.upstream.requests.length, 0);
      assert.equal(h.sends.length, 0);
    } finally {
      await h.close();
    }
  });

  test('a configured denied method is refused', async () => {
    const h = await harness({ deniedMethods: ['requestAirdrop'] });
    try {
      const res = JSON.parse((await h.post('/', JSON.stringify(rpc(1, 'requestAirdrop', ['x', 1])))).text);
      assert.equal(res.error.code, RPC_METHOD_DENIED);
      assert.equal(h.upstream.requests.length, 0);
    } finally {
      await h.close();
    }
  });

  test('the request goes up as the parsed object, so a duplicate key cannot hide a send', async () => {
    // JSON.parse keeps the last "method"; an upstream parser that keeps the
    // first would see a send. Gate forwards what it checked, not the raw bytes.
    const h = await harness();
    try {
      const raw = '{"jsonrpc":"2.0","id":1,"method":"sendTransaction","params":["AAAA"],"method":"getBalance"}';
      await h.post('/', raw);
      assert.equal(h.upstream.requests.length, 1);
      const forwarded = h.upstream.requests[0].body;
      assert.equal(forwarded, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: ['AAAA'] }));
      assert.doesNotMatch(forwarded, /sendTransaction/);
    } finally {
      await h.close();
    }
  });
});

describe('upstream failure (I4: the URL never appears)', () => {
  function assertNoUpstreamUrl(text, url) {
    for (const fragment of [url, url.replace(/^http:\/\//, ''), 'upstream-marker-path', 'upstream-marker-token']) {
      assert.ok(!text.includes(fragment), `response leaks ${fragment}: ${text}`);
    }
  }

  test('upstream down ⇒ -32097 with a fixed message, for reads and batches', async () => {
    const deadPort = await freePort();
    const upstreamUrl = `http://127.0.0.1:${deadPort}${UPSTREAM_PATH}`;
    const lines = [];
    const cp = await startCheckpoint({ upstreamUrl, onSend: async () => ({ forward: true }), logger: (l) => lines.push(l) });
    try {
      const one = await send(cp.port, { path: '/s/wallet', body: JSON.stringify(rpc(3, 'getSlot')) });
      const parsed = JSON.parse(one.text);
      assert.equal(parsed.id, 3);
      assert.equal(parsed.error.code, RPC_UPSTREAM_FAILED);
      assert.equal(parsed.error.message, 'SolFrontier Gate: upstream RPC unavailable');
      assertNoUpstreamUrl(one.text, upstreamUrl);

      const batch = await send(cp.port, { body: JSON.stringify([rpc(1, 'getSlot'), rpc(2, 'getBalance', ['x'])]) });
      assert.deepEqual(JSON.parse(batch.text).map((r) => [r.id, r.error.code]), [[1, RPC_UPSTREAM_FAILED], [2, RPC_UPSTREAM_FAILED]]);
      assertNoUpstreamUrl(batch.text, upstreamUrl);

      assert.ok(lines.length > 0);
      for (const line of lines) assertNoUpstreamUrl(line, upstreamUrl);
    } finally {
      await cp.close();
    }
  });

  test('non-2xx, non-JSON and redirects are upstream failures too', async () => {
    const replies = [
      () => ({ status: 500, body: '{"error":"boom"}' }),
      () => ({ status: 429, body: 'slow down' }),
      () => ({ body: '<html>not json</html>', type: 'text/html' }),
      () => ({ status: 307, body: '', headers: { location: 'http://127.0.0.1:9/elsewhere' } }),
    ];
    for (const reply of replies) {
      const h = await harness({ reply });
      try {
        const res = await h.post('/', JSON.stringify(rpc(5, 'getSlot')));
        const parsed = JSON.parse(res.text);
        assert.equal(parsed.error.code, RPC_UPSTREAM_FAILED);
        assertNoUpstreamUrl(res.text, h.upstream.url);
        assert.equal(h.upstream.requests.length, 1, 'the redirect is not followed');
      } finally {
        await h.close();
      }
    }
  });

  test('an upstream body that echoes the URL is redacted', async () => {
    let url = '';
    const h = await harness({ reply: (b) => ({ body: JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(b).id, error: { code: -32000, message: `bad key at ${url}` } }) }) });
    url = h.upstream.url;
    try {
      const res = await h.post('/', JSON.stringify(rpc(1, 'getSlot')));
      assertNoUpstreamUrl(res.text, url);
      assert.equal(JSON.parse(res.text).error.code, -32000);
    } finally {
      await h.close();
    }
  });

  test('a malformed upstream URL is rejected without echoing it', async () => {
    const bad = 'htp:/not a url?api-key=upstream-marker-token';
    await assert.rejects(startRpcCheckpoint({ upstreamUrl: bad, port: 20000, onSend: async () => ({}) }), (err) => {
      assert.ok(!err.message.includes('upstream-marker-token'));
      assert.ok(!String(err.stack).includes('upstream-marker-token'));
      return true;
    });
  });
});

// An independent base58 encoder (BigInt, not the module's byte loop), so the
// two implementations check each other.
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

/** Transaction-shaped test bytes: random, with leading zeros for base58's sake. */
function txBytes(length = 300) {
  const bytes = randomBytes(length);
  bytes[0] = 0;
  bytes[1] = 0;
  return new Uint8Array(bytes);
}

const forward = async () => ({ forward: true });

describe('sendTransaction', () => {
  test('the test encoder agrees with known base58 vectors', () => {
    assert.equal(base58(new Uint8Array(32)), '11111111111111111111111111111111');
    assert.equal(base58(new TextEncoder().encode('Hello World!')), '2NEpo7TZRRrLZSi2U');
  });

  test('base64 and base58 hand onSend identical bytes', async () => {
    const h = await harness({ onSend: forward });
    try {
      const bytes = txBytes();
      const b64 = Buffer.from(bytes).toString('base64');
      await h.post('/s/wallet', JSON.stringify(rpc(1, 'sendTransaction', [b64, { encoding: 'base64', skipPreflight: true }])));
      await h.post('/s/wallet', JSON.stringify(rpc(2, 'sendTransaction', [base58(bytes)])));
      await h.post('/s/wallet', JSON.stringify(rpc(3, 'sendTransaction', [base58(bytes), { encoding: 'base58' }])));
      await h.post('/s/wallet', JSON.stringify(rpc(4, 'sendTransaction', [base58(bytes), null])));
      await h.post('/s/wallet', JSON.stringify(rpc(5, 'sendTransaction', [base58(bytes), { encoding: null }])));
      assert.equal(h.sends.length, 5);
      for (const s of h.sends) {
        assert.ok(s.bytes instanceof Uint8Array);
        assert.deepEqual([...s.bytes], [...bytes]);
      }
      assert.deepEqual(h.sends.map((s) => s.meta.encoding), ['base64', 'base58', 'base58', 'base58', 'base58']);
      assert.deepEqual(h.sends.map((s) => s.meta.requestId), [1, 2, 3, 4, 5]);
      assert.deepEqual(h.sends[0].meta.params, [b64, { encoding: 'base64', skipPreflight: true }]);
    } finally {
      await h.close();
    }
  });

  test('onSend receives server "wallet" for /s/wallet and null for /', async () => {
    const h = await harness();
    try {
      const body = JSON.stringify(rpc(1, 'sendTransaction', [base58(txBytes())]));
      await h.post('/s/wallet', body);
      await h.post('/', body);
      await h.post('/s/jup-2', body);
      assert.deepEqual(h.sends.map((s) => s.meta.server), ['wallet', null, 'jup-2']);
    } finally {
      await h.close();
    }
  });

  test('forward ⇒ upstream receives the original request; its answer comes back verbatim', async () => {
    const h = await harness({ onSend: forward });
    try {
      const body = JSON.stringify(rpc('send-1', 'sendTransaction', [Buffer.from(txBytes()).toString('base64'), { encoding: 'base64', maxRetries: 0 }]));
      const res = await h.post('/s/wallet', body);
      assert.equal(h.upstream.requests.length, 1);
      assert.equal(h.upstream.requests[0].body, body);
      assert.equal(res.text, defaultReply(body).body);
    } finally {
      await h.close();
    }
  });

  test('refuse ⇒ -32099 with the reason and data; upstream receives nothing', async () => {
    const h = await harness({
      onSend: async () => ({ forward: false, code: -32099, message: 'approval_rejected', data: { gate: 'refused', code: 'approval_rejected' } }),
    });
    try {
      const res = JSON.parse((await h.post('/s/wallet', JSON.stringify(rpc(11, 'sendTransaction', [base58(txBytes())])))).text);
      assert.equal(res.id, 11);
      assert.deepEqual(res.error, {
        code: RPC_SEND_REFUSED,
        message: 'SolFrontier Gate: approval_rejected',
        data: { gate: 'refused', code: 'approval_rejected' },
      });
      assert.equal(h.sends.length, 1);
      assert.equal(h.upstream.requests.length, 0);
    } finally {
      await h.close();
    }
  });

  test('onSend throwing, or answering anything but { forward: true }, refuses (I7)', async () => {
    const answers = [
      async () => { throw new Error('pipeline exploded'); },
      async () => undefined,
      async () => null,
      async () => ({}),
      async () => ({ forward: 'true' }),
      async () => ({ forward: 1 }),
      async () => ({ forward: false }),
      async () => ({ forward: false, message: 'x', data: { big: 10n } }),
    ];
    for (const onSend of answers) {
      const h = await harness({ onSend });
      try {
        const res = JSON.parse((await h.post('/s/wallet', JSON.stringify(rpc(1, 'sendTransaction', [base58(txBytes())])))).text);
        assert.equal(res.error.code, RPC_SEND_REFUSED, String(onSend));
        assert.match(res.error.message, /^SolFrontier Gate: /);
        assert.equal(h.upstream.requests.length, 0, String(onSend));
      } finally {
        await h.close();
      }
    }
  });

  test('an undecodable transaction is -32602 and never reaches onSend', async () => {
    // Fixed bytes, so every case below is deterministic: leading zeros, and a
    // run that encodes to '////++++' so the URL-safe spelling really differs.
    const good = Uint8Array.from({ length: 64 }, (_, i) => (i * 37 + 11) & 0xff);
    good.set([0, 0], 0);
    good.set([0xff, 0xff, 0xff, 0xfb, 0xef, 0xbe], 9);
    const b64 = Buffer.from(good).toString('base64');
    assert.match(b64, /\/\/\/\/\+\+\+\+/);
    const cases = [
      ['0OIl', undefined], // not in the base58 alphabet
      [base58(good), { encoding: 'base64' }], // base58 text labelled base64
      [b64.replace(/=+$/, ''), { encoding: 'base64' }], // unpadded
      [`${b64.slice(0, 8)}*${b64.slice(8)}`, { encoding: 'base64' }], // junk Node would skip
      [b64.replace(/\+/g, '-').replace(/\//g, '_').padEnd(b64.length, '='), { encoding: 'base64' }], // URL-safe alphabet
      [b64, { encoding: 'binary' }], // the RPC's deprecated alias: not guessed at
      [b64, { encoding: 'json' }],
      [b64, { encoding: 'Base64' }],
      ['', undefined],
      [42, undefined],
      ['1'.repeat(5000), undefined], // over the length cap
      [b64, 'base64'], // config that is not an object
    ];
    const h = await harness({ onSend: forward });
    try {
      for (const [tx, config] of cases) {
        const params = config === undefined ? [tx] : [tx, config];
        const res = JSON.parse((await h.post('/', JSON.stringify(rpc(1, 'sendTransaction', params)))).text);
        assert.equal(res.error?.code, -32602, JSON.stringify(params).slice(0, 80));
        assert.equal(res.error.data.code, 'tx_decode_failed');
      }
      for (const params of [undefined, [], {}, { transaction: b64 }, [b64, { encoding: 'base64' }, 'extra']]) {
        const call = { jsonrpc: '2.0', id: 1, method: 'sendTransaction' };
        if (params !== undefined) call.params = params;
        const res = JSON.parse((await h.post('/', JSON.stringify(call))).text);
        assert.equal(res.error?.code, -32602, JSON.stringify(params));
      }
      assert.equal(h.sends.length, 0);
      assert.equal(h.upstream.requests.length, 0);
    } finally {
      await h.close();
    }
  });

  test('onSend tampering with what it is handed does not change what goes upstream', async () => {
    const h = await harness({
      onSend: async (bytes, meta) => {
        bytes.fill(7);
        meta.params[0] = 'tampered';
        return { forward: true };
      },
    });
    try {
      const body = JSON.stringify(rpc(1, 'sendTransaction', [base58(txBytes())]));
      await h.post('/', body);
      assert.equal(h.upstream.requests[0].body, body);
    } finally {
      await h.close();
    }
  });

  test('upstream down while forwarding a send ⇒ -32097, URL nowhere', async () => {
    const deadPort = await freePort();
    const upstreamUrl = `http://127.0.0.1:${deadPort}${UPSTREAM_PATH}`;
    const cp = await startCheckpoint({ upstreamUrl, onSend: forward });
    try {
      const res = await send(cp.port, { path: '/s/wallet', body: JSON.stringify(rpc(2, 'sendTransaction', [base58(txBytes())])) });
      assert.equal(JSON.parse(res.text).error.code, RPC_UPSTREAM_FAILED);
      assert.ok(!res.text.includes(upstreamUrl));
      assert.ok(!res.text.includes('upstream-marker'));
    } finally {
      await cp.close();
    }
  });

  test('meta.signal aborts when the client hangs up', async () => {
    let seen;
    const aborted = new Promise((resolve) => {
      seen = (signal) => signal.addEventListener('abort', resolve, { once: true });
    });
    const h = await harness({ onSend: async (bytes, meta) => { seen(meta.signal); await aborted; return { forward: false, message: 'gone', data: {} }; } });
    try {
      const req = request({ host: '127.0.0.1', port: h.cp.port, path: '/s/wallet', method: 'POST', agent: false });
      req.on('error', () => {});
      req.end(JSON.stringify(rpc(1, 'sendTransaction', [base58(txBytes())])));
      while (h.sends.length === 0) await new Promise((r) => setTimeout(r, 5));
      assert.equal(h.sends[0].meta.signal.aborted, false);
      req.destroy();
      await aborted;
      assert.equal(h.sends[0].meta.signal.aborted, true);
      assert.equal(h.upstream.requests.length, 0);
    } finally {
      await h.close();
    }
  });

  test('a send approved after close() is not forwarded', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const h = await harness({ onSend: async () => { await gate; return { forward: true }; } });
    try {
      const pending = h.post('/s/wallet', JSON.stringify(rpc(1, 'sendTransaction', [base58(txBytes())]))).catch(() => null);
      while (h.sends.length === 0) await new Promise((r) => setTimeout(r, 5));
      await h.cp.close();
      assert.equal(h.sends[0].meta.signal.aborted, true);
      release();
      await pending;
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(h.upstream.requests.length, 0);
    } finally {
      await h.close();
    }
  });
});

describe('batches', () => {
  test('a read and a refused send: read answered, send refused, ids preserved', async () => {
    const h = await harness();
    try {
      const read = rpc('r-1', 'getBalance', ['11111111111111111111111111111111']);
      const sendCall = rpc(77, 'sendTransaction', [base58(txBytes())]);
      const res = JSON.parse((await h.post('/s/wallet', JSON.stringify([read, sendCall]))).text);
      assert.equal(res.length, 2);
      assert.equal(res[0].id, 'r-1');
      assert.deepEqual(res[0].result, { value: 42, echo: 'getBalance' });
      assert.equal(res[1].id, 77);
      assert.equal(res[1].error.code, RPC_SEND_REFUSED);
      // Only the read went up.
      assert.equal(h.upstream.requests.length, 1);
      assert.equal(h.upstream.requests[0].body, JSON.stringify(read));
      assert.equal(h.sends[0].meta.server, 'wallet');
    } finally {
      await h.close();
    }
  });

  test('a batch\'s sends are decided one at a time, in order', async () => {
    let active = 0;
    let maxActive = 0;
    const order = [];
    const h = await harness({
      onSend: async (bytes, meta) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        order.push(meta.requestId);
        await new Promise((r) => setTimeout(r, 15));
        active -= 1;
        return meta.requestId === 2 ? { forward: true } : { forward: false, message: 'no', data: {} };
      },
    });
    try {
      const calls = [1, 2, 3].map((id) => rpc(id, 'sendTransaction', [base58(txBytes())]));
      const batch = [calls[0], rpc('mid', 'sendBundle', [[]]), calls[1], { jsonrpc: '2.0', id: 'bad' }, calls[2]];
      const res = JSON.parse((await h.post('/', JSON.stringify(batch))).text);
      assert.equal(maxActive, 1);
      assert.deepEqual(order, [1, 2, 3]);
      assert.deepEqual(res.map((r) => [r.id, r.error?.code ?? 'ok']), [
        [1, RPC_SEND_REFUSED],
        ['mid', RPC_METHOD_DENIED],
        [2, 'ok'],
        ['bad', -32600],
        [3, RPC_SEND_REFUSED],
      ]);
      assert.equal(h.upstream.requests.length, 1);
      assert.equal(h.upstream.requests[0].body, JSON.stringify(calls[1]));
    } finally {
      await h.close();
    }
  });
});

// --- WebSocket tunnel --------------------------------------------------------

const WS_UPSTREAM_PATH = '/v2/ws-marker-path?api-key=ws-marker-token';

/**
 * A fake WebSocket upstream: reads the upgrade request, answers 101, then
 * echoes every byte. It parses no frames, and neither does the tunnel.
 */
async function fakeWsUpstream() {
  const heads = [];
  const sockets = [];
  const server = net.createServer((socket) => {
    sockets.push(socket);
    socket.on('error', () => {});
    let buffered = Buffer.alloc(0);
    let upgraded = false;
    socket.on('data', (chunk) => {
      if (upgraded) return void socket.write(chunk);
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf('\r\n\r\n');
      if (end === -1) return;
      heads.push(buffered.subarray(0, end).toString('latin1'));
      upgraded = true;
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
        + 'Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n');
      const rest = buffered.subarray(end + 4);
      if (rest.length) socket.write(rest);
    });
  });
  const port = await listenOn(server);
  return { port, url: `ws://127.0.0.1:${port}${WS_UPSTREAM_PATH}`, heads, sockets, close: () => closeQuietly(server) };
}

/** An HTTP upgrade request to the tunnel; resolves on 101 or any other answer. */
function upgrade(port, { path = '/s/wallet', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port,
      path,
      agent: false,
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        ...headers,
      },
    });
    req.on('upgrade', (res, socket) => resolve({ status: res.statusCode, socket }));
    req.on('response', (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Write bytes, collect exactly that many back. */
function roundTrip(socket, text) {
  return new Promise((resolve) => {
    let got = '';
    const onData = (chunk) => {
      got += chunk.toString('utf8');
      if (got.length >= text.length) {
        socket.off('data', onData);
        resolve(got);
      }
    };
    socket.on('data', onData);
    socket.write(text);
  });
}

const closed = (socket) => new Promise((resolve) => {
  if (socket.destroyed) resolve();
  else socket.once('close', resolve);
});

async function tunnelHarness(extra = {}) {
  const ws = await fakeWsUpstream();
  const upstream = await fakeUpstream();
  const cp = await startCheckpoint({ upstreamUrl: upstream.url, upstreamWsUrl: ws.url, onSend: forward, ...extra });
  return {
    ws,
    cp,
    wsPort: cp.port + 1,
    close: async () => { await cp.close(); await ws.close(); await upstream.close(); },
  };
}

describe('WebSocket tunnel on port + 1', () => {
  test('bytes written by the client come back through the tunnel', async () => {
    const h = await tunnelHarness();
    try {
      assert.equal(h.cp.wsUrl, `ws://127.0.0.1:${h.wsPort}`);
      for (const path of ['/s/wallet', '/']) {
        const up = await upgrade(h.wsPort, { path });
        assert.equal(up.status, 101, path);
        const payload = `ping-through-the-tunnel ${path} ${'x'.repeat(5000)}`;
        assert.equal(await roundTrip(up.socket, payload), payload);
        up.socket.destroy();
      }
      // The request was re-addressed: upstream path and query, upstream Host,
      // client's WebSocket headers kept, no Origin.
      assert.equal(h.ws.heads.length, 2);
      for (const head of h.ws.heads) {
        const [line, ...headers] = head.split('\r\n');
        assert.equal(line, `GET ${WS_UPSTREAM_PATH} HTTP/1.1`);
        const lower = headers.map((x) => x.toLowerCase());
        assert.ok(lower.includes(`host: 127.0.0.1:${h.ws.port}`), head);
        assert.ok(lower.includes('sec-websocket-key: dghlihnhbxbszsbub25jzq=='), head);
        assert.ok(lower.includes('upgrade: websocket'), head);
        assert.equal(lower.filter((x) => x.startsWith('host:')).length, 1);
        assert.ok(!lower.some((x) => x.startsWith('origin:')), head);
      }
    } finally {
      await h.close();
    }
  });

  test('when either side closes, both are torn down', async () => {
    const h = await tunnelHarness();
    try {
      const a = await upgrade(h.wsPort);
      await roundTrip(a.socket, 'hello');
      a.socket.destroy();
      await closed(h.ws.sockets[0]);

      const b = await upgrade(h.wsPort);
      await roundTrip(b.socket, 'hello');
      h.ws.sockets[1].destroy();
      await closed(b.socket);
    } finally {
      await h.close();
    }
  });

  test('wrong Host, foreign Origin, bad path: refused before any upstream connection', async () => {
    const h = await tunnelHarness();
    try {
      assert.equal((await upgrade(h.wsPort, { headers: { host: 'evil.example' } })).status, 403);
      assert.equal((await upgrade(h.wsPort, { headers: { host: `127.0.0.1:${h.cp.port}` } })).status, 403);
      assert.equal((await upgrade(h.wsPort, { headers: { origin: 'https://evil.example' } })).status, 403);
      assert.equal((await upgrade(h.wsPort, { path: '/s/BAD' })).status, 404);
      assert.equal((await upgrade(h.wsPort, { path: '/x' })).status, 404);
      assert.equal((await upgrade(h.wsPort, { headers: { upgrade: 'h2c' } })).status, 400);
      assert.equal((await upgrade(h.wsPort, { headers: { host: `localhost:${h.wsPort}`, origin: `http://localhost:${h.wsPort}` } })).status, 101);
      assert.equal(h.ws.sockets.length, 1);
      const plain = await send(h.wsPort, { path: '/', method: 'GET' });
      assert.equal(plain.status, 426);
    } finally {
      await h.close();
    }
  });

  test('upstream WebSocket down ⇒ 502, URL nowhere', async () => {
    const deadPort = await freePort();
    const upstream = await fakeUpstream();
    const lines = [];
    const wsUrl = `ws://127.0.0.1:${deadPort}${WS_UPSTREAM_PATH}`;
    const cp = await startCheckpoint({ upstreamUrl: upstream.url, upstreamWsUrl: wsUrl, onSend: forward, logger: (l) => lines.push(l) });
    try {
      const res = await upgrade(cp.port + 1);
      assert.equal(res.status, 502);
      for (const text of [res.text, ...lines]) {
        assert.ok(!text.includes('ws-marker'), text);
        assert.ok(!text.includes(String(deadPort)), text);
      }
    } finally {
      await cp.close();
      await upstream.close();
    }
  });

  test('without upstreamWsUrl the tunnel targets the upstream URL with ws://', async () => {
    const ws = await fakeWsUpstream();
    // http://127.0.0.1:<ws port>/… → ws://127.0.0.1:<ws port>/…
    const cp = await startCheckpoint({ upstreamUrl: `http://127.0.0.1:${ws.port}${WS_UPSTREAM_PATH}`, onSend: forward });
    try {
      const up = await upgrade(cp.port + 1);
      assert.equal(up.status, 101);
      assert.equal(await roundTrip(up.socket, 'derived'), 'derived');
      assert.equal(ws.heads[0].split('\r\n')[0], `GET ${WS_UPSTREAM_PATH} HTTP/1.1`);
      up.socket.destroy();
    } finally {
      await cp.close();
      await ws.close();
    }
  });
});

describe('lifecycle', () => {
  test('close() frees both ports, even with a live tunnel and a keep-alive connection', async () => {
    // A port freed by close() could in principle be taken by a parallel test
    // before the restart; a fresh pair absorbs that race, a real leak fails
    // every attempt.
    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
      const h = await tunnelHarness();
      const { port } = h.cp;
      const up = await upgrade(h.wsPort);
      await roundTrip(up.socket, 'live');
      const keepAlive = request({ host: '127.0.0.1', port, path: '/health', method: 'GET', headers: { connection: 'keep-alive' } });
      await new Promise((resolve) => keepAlive.on('response', (res) => { res.resume(); res.on('end', resolve); }).end());

      await h.cp.close();
      await closed(up.socket);
      await closed(h.ws.sockets[0]);
      await h.close();
      let again;
      try {
        again = await startRpcCheckpoint({ upstreamUrl: 'http://127.0.0.1:9/', port, onSend: forward });
      } catch (err) {
        lastError = err;
        continue;
      }
      try {
        assert.equal(again.url, `http://127.0.0.1:${port}`);
        assert.equal(again.wsUrl, `ws://127.0.0.1:${port + 1}`);
        assert.equal((await send(port, { path: '/health', method: 'GET' })).text, 'ok');
      } finally {
        await again.close();
      }
      return;
    }
    throw lastError;
  });

  test('close() is idempotent', async () => {
    const h = await tunnelHarness();
    await Promise.all([h.cp.close(), h.cp.close()]);
    await h.close();
  });

  test('if port + 1 is taken, start fails naming it and leaves port free', async () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const port = await freePort();
      if (port > 65534) continue;
      const blocker = net.createServer();
      try {
        await listenOn(blocker, port + 1);
      } catch {
        continue;
      }
      try {
        await assert.rejects(startRpcCheckpoint({ upstreamUrl: 'http://127.0.0.1:9/', port, onSend: forward }), (err) => {
          assert.equal(err.code, 'EADDRINUSE');
          assert.equal(err.port, port + 1);
          assert.match(err.message, new RegExp(`127\\.0\\.0\\.1:${port + 1}`));
          return true;
        });
        const probe = net.createServer();
        await listenOn(probe, port);
        await closeQuietly(probe);
      } finally {
        await closeQuietly(blocker);
      }
      return;
    }
    throw new Error('could not stage an occupied port + 1');
  });

  test('bad arguments are refused before anything listens', async () => {
    const upstreamUrl = 'http://127.0.0.1:9/';
    await assert.rejects(startRpcCheckpoint({ upstreamUrl, port: 20001 }), TypeError);
    await assert.rejects(startRpcCheckpoint({ upstreamUrl, port: 0, onSend: forward }), RangeError);
    await assert.rejects(startRpcCheckpoint({ upstreamUrl, port: 65535, onSend: forward }), RangeError);
    await assert.rejects(startRpcCheckpoint({ upstreamUrl: 'ftp://127.0.0.1/', port: 20001, onSend: forward }), TypeError);
    await assert.rejects(startRpcCheckpoint({ upstreamUrl, upstreamWsUrl: 'http://127.0.0.1/', port: 20001, onSend: forward }), TypeError);
    await assert.rejects(startRpcCheckpoint({ upstreamUrl, port: 20001, onSend: forward, deniedMethods: 'sendBundle' }), TypeError);
  });
});
