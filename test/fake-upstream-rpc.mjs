// Loopback fake of the Solana JSON-RPC methods Gate and the naive wallet fixture use, for
// hermetic end-to-end tests (SPEC section 7). Scripted, not stateful: a test states the answers,
// then asserts on `calls` and `sent`. No network, binds port 0 for parallel test files.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Base58 encode. Local copy so this fake does not depend on the code it helps test. */
export function base58Encode(bytes) {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  return '1'.repeat(zeros) + out;
}

/** Base58 decode; throws on an out-of-alphabet character. */
export function base58Decode(text) {
  let n = 0n;
  let zeros = 0;
  while (zeros < text.length && text[zeros] === '1') zeros++;
  for (const ch of text) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) throw new Error('invalid base58');
    n = n * 58n + BigInt(v);
  }
  const body = [];
  while (n > 0n) {
    body.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  return Uint8Array.from([...new Array(zeros).fill(0), ...body]);
}

export const DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
export const FAKE_BLOCKHASH = base58Encode(createHash('sha256').update('sfgate fake upstream blockhash').digest());

const SYSTEM_PROGRAM = '11111111111111111111111111111111';

/** First signature of a wire transaction: compact-u16 count, then 64-byte signatures. */
function firstSignature(bytes) {
  let count = 0;
  let shift = 0;
  let i = 0;
  for (;;) {
    const b = bytes[i++];
    count |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  if (count < 1 || bytes.length < i + 64) throw new Error('transaction carries no signature');
  return base58Encode(bytes.subarray(i, i + 64));
}

/** Render an account value: null (missing) or { lamports, owner?, data?, executable? }. */
function renderAccount(acc) {
  if (acc === null || acc === undefined) return null;
  const data = acc.data instanceof Uint8Array ? Buffer.from(acc.data).toString('base64') : (acc.data ?? '');
  return {
    lamports: Number(acc.lamports ?? 0),
    owner: acc.owner ?? SYSTEM_PROGRAM,
    data: [data, 'base64'],
    executable: acc.executable === true,
    rentEpoch: 0,
    space: Buffer.from(data, 'base64').length,
  };
}

/** Look `address` up in a map object, or call it when `source` is a function. */
function lookup(source, address, ...rest) {
  if (typeof source === 'function') return source(address, ...rest);
  if (source && typeof source === 'object') return source[address];
  return undefined;
}

/**
 * Start the fake upstream HTTP JSON-RPC server.
 *
 * @param {object}   [script]
 * @param {string}   [script.blockhash]        getLatestBlockhash value
 * @param {bigint|number|Function|object} [script.balance]  lamports for getBalance
 * @param {object|Function} [script.accounts]  address -> account, for getMultipleAccounts
 * @param {object|Function} [script.tokenAccounts]  owner -> [{ pubkey, account }]
 * @param {Array|Function}  [script.simulate]  per-call simulateTransaction result
 * @param {object|Function} [script.statuses]  signature -> status row for getSignatureStatuses
 * @param {object|Function} [script.transactions]  signature -> getTransaction result
 * @param {object}   [script.errors]           method -> JSON-RPC error object to return
 * @returns {Promise<{ url, calls, sent, signatures, close, portPath }>}
 */
export async function startFakeUpstream(script = {}) {
  const calls = [];
  const sent = [];
  const signatures = [];
  let simIndex = 0;

  const blockhash = script.blockhash ?? FAKE_BLOCKHASH;

  function handleOne(payload, pathname) {
    const { method, params, id } = payload ?? {};
    calls.push({ method, params, path: pathname });

    if (script.errors && script.errors[method]) {
      return { jsonrpc: '2.0', id, error: script.errors[method] };
    }

    const ctx = { context: { slot: 1, apiVersion: '2.0.0' } };
    let result;
    switch (method) {
      case 'getLatestBlockhash':
        result = { ...ctx, value: { blockhash, lastValidBlockHeight: 1000 } };
        break;
      case 'getGenesisHash':
        result = script.genesisHash ?? DEVNET_GENESIS_HASH;
        break;
      case 'getBalance': {
        const bal = lookup(script.balance, params?.[0]);
        result = { ...ctx, value: Number(bal ?? (typeof script.balance === 'bigint' || typeof script.balance === 'number' ? script.balance : 0)) };
        break;
      }
      case 'getMultipleAccounts': {
        const addresses = params?.[0] ?? [];
        result = { ...ctx, value: addresses.map((a) => renderAccount(lookup(script.accounts, a) ?? null)) };
        break;
      }
      case 'getAccountInfo':
        result = { ...ctx, value: renderAccount(lookup(script.accounts, params?.[0]) ?? null) };
        break;
      case 'getTokenAccountsByOwner': {
        const rows = lookup(script.tokenAccounts, params?.[0]) ?? [];
        result = { ...ctx, value: rows };
        break;
      }
      case 'simulateTransaction': {
        const scripted = typeof script.simulate === 'function'
          ? script.simulate(simIndex, params)
          : Array.isArray(script.simulate)
            ? script.simulate[Math.min(simIndex, script.simulate.length - 1)]
            : script.simulate;
        simIndex += 1;
        const s = scripted ?? { err: null, logs: [] };
        result = {
          ...ctx,
          value: {
            err: s.err ?? null,
            logs: s.logs ?? [],
            unitsConsumed: s.unitsConsumed ?? 0,
            accounts: s.accounts
              ? (params?.[1]?.accounts?.addresses ?? []).map((a) => renderAccount(s.accounts[a] ?? null))
              : null,
            returnData: s.returnData ?? null,
          },
        };
        break;
      }
      case 'sendTransaction': {
        const encoding = params?.[1]?.encoding ?? 'base58';
        const raw = params?.[0];
        const bytes = encoding === 'base64' ? new Uint8Array(Buffer.from(raw, 'base64')) : base58Decode(raw);
        const sig = firstSignature(bytes);
        sent.push({ bytes, encoding, signature: sig });
        signatures.push(sig);
        result = sig;
        break;
      }
      case 'getSignatureStatuses': {
        const sigs = params?.[0] ?? [];
        result = {
          ...ctx,
          value: sigs.map((sig) => {
            const row = lookup(script.statuses, sig);
            if (row === undefined) {
              return signatures.includes(sig)
                ? { slot: 1, confirmations: null, err: null, confirmationStatus: 'confirmed' }
                : null;
            }
            return row;
          }),
        };
        break;
      }
      case 'getTransaction':
        result = lookup(script.transactions, params?.[0]) ?? null;
        break;
      default:
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `unmocked: ${method}` } };
    }
    return { jsonrpc: '2.0', id, result };
  }

  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let payload;
      try { payload = JSON.parse(body); } catch { payload = {}; }
      const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
      const out = Array.isArray(payload) ? payload.map((p) => handleOne(p, pathname)) : handleOne(payload, pathname);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    portPath: (server) => `http://127.0.0.1:${port}/s/${server}`,
    calls,
    sent,
    signatures,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
