// The difference between the fakes and mainnet: RESPONSE SHAPE.
//
// test/fake-rpc-server.mjs replays scripts/demo/fixtures/funding-20260802.json
// verbatim, whatever the request asked for. That fixture was captured by
// scripts/demo/Demo.ps1:439-443, which explicitly sends
// `encoding = 'jsonParsed'`. The CLI does not: SolanaRpc.getTransaction
// (src/solana/rpc.mjs:58-60) sends only `maxSupportedTransactionVersion` and
// `commitment`, so a real validator applies the DEFAULT encoding, "json".
//
// Under "json" the same transaction is a different document:
//   accountKeys      base58 strings, with the signer flags in `header`
//   instructions     {programIdIndex, accounts, data} — no programId, no parsed
//
// verifyFundingTransaction reads only the jsonParsed shape, so the correct
// payment fails at src/solana/funding-proof.mjs:134 with `payer_did_not_sign`,
// findFundingMatches:197 puts the signature in `seen` forever, and the reason
// is discarded — flow.mjs:414-430 looks at `matches.length` and nothing else.
// The result is SILENCE: no event, no warning, no confirm call, just the
// countdown continuing over a payment already sitting on chain.
//
// The fake below is the shared one plus one honest behaviour: it renders the
// encoding it was actually asked for.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { buildReserveAccount } from './fake-rpc-server.mjs';
import { CLI, ROOT } from './helpers.mjs';

const FIXTURE = JSON.parse(
  readFileSync(path.join(ROOT, 'scripts', 'demo', 'fixtures', 'funding-20260802.json'), 'utf8'),
);
const FAKE_SERVER = path.join(ROOT, 'test', 'fake-solfrontier-server.mjs');
const USER_WALLET = 'C4QQjzWxnJ5QFAbkzhQJ3wTzyX6nw1vyFvJwbPXJGPNW';

/**
 * The captured jsonParsed transaction, re-rendered as encoding:"json".
 *
 * This is what mainnet returns when no encoding is requested. Only the
 * `transaction` member changes; `meta` (including the token balance rows) is
 * identical in both encodings, which is why the failure is not a balance
 * mismatch but a shape mismatch three checks earlier.
 */
export function asDefaultJsonEncoding(parsed) {
  const tx = JSON.parse(JSON.stringify(parsed));
  const message = tx.transaction.message;
  const keys = message.accountKeys.map((k) => k.pubkey);
  const signers = message.accountKeys.filter((k) => k.signer).length;
  const readonlyUnsigned = message.accountKeys.filter((k) => !k.signer && !k.writable).length;
  message.accountKeys = keys; // plain strings — the `signer` flag is gone
  message.header = {
    numRequiredSignatures: signers,
    numReadonlySignedAccounts: 0,
    numReadonlyUnsignedAccounts: readonlyUnsigned,
  };
  message.instructions = message.instructions.map((ix) => ({
    programIdIndex: keys.indexOf(ix.programId), // an index, not a programId
    accounts: [],
    data: '3Bxs4h24hCVSAmnH', // base58 bytes — nothing is parsed for us
    stackHeight: null,
  }));
  return tx;
}

/** Like startFakeRpc, but it honours the `encoding` the client asked for. */
async function startEncodingFaithfulRpc(script) {
  const getTransactionParams = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let payload;
      try { payload = JSON.parse(body); } catch { payload = {}; }
      const { method, params, id } = payload;
      let result;
      switch (method) {
        case 'getSlot':
          result = script.slot();
          break;
        case 'getSignaturesForAddress':
          result = script.signatureRows();
          break;
        case 'getTransaction': {
          getTransactionParams.push(params?.[1] ?? null);
          const tx = script.transaction(params?.[0]) ?? null;
          // The whole point of this fake: a validator serves the encoding it
          // was asked for, and "not asked" means "json".
          result = tx && (params?.[1]?.encoding === 'jsonParsed' ? tx : asDefaultJsonEncoding(tx));
          break;
        }
        case 'getAccountInfo':
          result = {
            context: { slot: script.slot() },
            value: { data: [buildReserveAccount({ lastUpdateSlot: script.slot() }), 'base64'] },
          };
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
    getTransactionParams,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function runFlow({ rpcUrl, serverFlags = [], flowFlags = [] }) {
  const dir = await mkdtemp(path.join(tmpdir(), 'sfcli-enc-'));
  const configPath = path.join(dir, 'sfcli.config.json');
  await writeFile(configPath, JSON.stringify({
    serverBin: process.execPath,
    serverArgs: [FAKE_SERVER, ...serverFlags],
    dbPath: path.join(dir, 'scratch.db'),
  }));
  try {
    const result = await new Promise((resolve) => {
      execFile(process.execPath, [
        CLI, 'flow',
        '--amount', '0.2', '--threshold-bps', '88',
        '--user-wallet', USER_WALLET,
        '--yes', '--json', '--color', 'never',
        '--poll-ms', '250', '--skip-executor-check',
        ...flowFlags,
      ], {
        cwd: ROOT,
        timeout: 45_000,
        env: { ...process.env, SFCLI_CONFIG: configPath, SOLFRONTIER_RPC_URL: rpcUrl, NO_COLOR: '1' },
      }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }));
    });
    let body = null;
    try { body = JSON.parse(result.stdout); } catch { /* reported by the test */ }
    return { ...result, body };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function stagedPayment({ slot }) {
  const tx = JSON.parse(JSON.stringify(FIXTURE.transaction));
  tx.slot = slot;
  return { row: { ...FIXTURE.row, slot }, transaction: tx };
}

function revealFrom(nth, rows) {
  let call = 0;
  return () => (++call >= nth ? rows : []);
}

describe('getTransaction encoding', () => {
  test('the client asks for jsonParsed explicitly', async () => {
    // The regression guard. Everything downstream of this call reads
    // `programId`, `parsed` and `accountKeys[].signer`; only jsonParsed has
    // them, and the default is not jsonParsed. Relying on a default that the
    // proof layer cannot verify is the whole defect.
    const payment = stagedPayment({ slot: 1010 });
    const rpc = await startEncodingFaithfulRpc({
      slot: () => 1000,
      signatureRows: revealFrom(2, [payment.row]),
      transaction: (sig) => (sig === payment.row.signature ? payment.transaction : null),
    });
    try {
      await runFlow({
        rpcUrl: rpc.url,
        serverFlags: ['--window-ms', '4000'],
        flowFlags: ['--reconcile-ms', '1000', '--post-signing-ms', '0'],
      });
      assert.ok(rpc.getTransactionParams.length > 0, 'the payment must have been fetched at all');
      for (const params of rpc.getTransactionParams) {
        assert.equal(
          params?.encoding, 'jsonParsed',
          'getTransaction must request jsonParsed; the default is "json", whose compiled '
          + 'instructions and string accountKeys make verifyFundingTransaction fail closed and silently',
        );
      }
    } finally {
      await rpc.close();
    }
  });

  test('a correct payment served in the default encoding is still proven and confirmed', async () => {
    // The live shape, end to end. Identical to the passing orchestration test
    // in every respect except that the RPC answers the request that was
    // actually sent instead of the one the fixture was captured with.
    const payment = stagedPayment({ slot: 1010 });
    const rpc = await startEncodingFaithfulRpc({
      slot: () => 1000,
      signatureRows: revealFrom(2, [payment.row]),
      transaction: (sig) => (sig === payment.row.signature ? payment.transaction : null),
    });
    try {
      const r = await runFlow({
        rpcUrl: rpc.url,
        serverFlags: ['--window-ms', '8000'],
        flowFlags: ['--reconcile-ms', '2000', '--post-signing-ms', '0'],
      });
      // What the four live runs looked like: the payment is on chain, the
      // client fetches it, rejects it on shape, and says NOTHING.
      assert.ok(
        !r.stderr.includes('"type":"detect.rpc_hiccup"'),
        'no error is emitted — the silence is the symptom, not a missing log line',
      );
      assert.equal(r.body?.status !== 'no_signature_detected', true,
        `flow failed to detect a correct payment served in the default encoding.\n`
        + `This is the live failure. stderr:\n${r.stderr}`);
      assert.equal(r.body?.confirm?.status, 'budget_reserved', `stderr: ${r.stderr}`);
      assert.equal(r.body.signature, payment.row.signature);
      assert.equal(r.body.proof.controlledDelta, '200000');
    } finally {
      await rpc.close();
    }
  });
});
