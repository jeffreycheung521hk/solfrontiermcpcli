// A loopback fake of the Solana JSON-RPC endpoints this CLI uses.
//
// Exists so the funding orchestration can be exercised end to end without a
// network, a chain, or money. Scripted so a test can stage the exact timing
// that mattered on 2026-08-02: a payment that is on chain and on time, but
// which the RPC does not list until later.
import { createServer } from 'node:http';

const WAD = 10n ** 18n;

/**
 * A 619-byte Solend reserve whose decoded supply APR clears any sane
 * threshold. Field offsets mirror src/solana/solend.mjs.
 */
export function buildReserveAccount({ lastUpdateSlot, stale = false, available = 1_000_000n, borrowed = 2_447_087n }) {
  const b = Buffer.alloc(619);
  b.writeBigUInt64LE(BigInt(lastUpdateSlot), 1);
  b[9] = stale ? 1 : 0;
  b.writeBigUInt64LE(available, 171);
  const borrowedWads = borrowed * WAD;
  for (let i = 0; i < 16; i++) b[179 + i] = Number((borrowedWads >> BigInt(8 * i)) & 0xffn);
  b[299] = 92; // optimal utilization %
  b[303] = 1; // min borrow rate %
  b[304] = 4; // optimal borrow rate %
  b[305] = 12; // max borrow rate %
  b[372] = 20; // protocol take rate %
  b[470] = 95; // max utilization %
  b.writeBigUInt64LE(350n, 471); // super max borrow rate %
  return b.toString('base64');
}

/**
 * @param {object} script
 * @param {() => number} script.slot            current slot
 * @param {() => Array}  script.signatureRows   what getSignaturesForAddress returns now
 * @param {(sig: string) => object|null} script.transaction
 */
export async function startFakeRpc(script) {
  const calls = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let payload;
      try { payload = JSON.parse(body); } catch { payload = {}; }
      const { method, params, id } = payload;
      calls.push(method);
      let result;
      switch (method) {
        case 'getSlot':
          result = script.slot();
          break;
        case 'getSignaturesForAddress':
          result = script.signatureRows();
          break;
        case 'getTransaction':
          result = script.transaction(params?.[0]) ?? null;
          break;
        case 'getAccountInfo':
          result = { context: { slot: script.slot() }, value: { data: [buildReserveAccount({ lastUpdateSlot: script.slot() }), 'base64'] } };
          break;
        case 'getTokenAccountsByOwner':
          result = { value: [] };
          break;
        default:
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: `unmocked: ${method}` } }));
          return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
