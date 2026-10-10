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

describe('sendTransaction never reaches upstream unless onSend forwards it', () => {
  test('a refused send is -32099 and upstream receives nothing', async () => {
    const h = await harness();
    try {
      const res = JSON.parse((await h.post('/s/wallet', JSON.stringify(rpc(11, 'sendTransaction', ['AQID', { encoding: 'base64' }])))).text);
      assert.equal(res.id, 11);
      assert.equal(res.error.code, RPC_SEND_REFUSED);
      assert.equal(h.upstream.requests.length, 0);
    } finally {
      await h.close();
    }
  });
});
