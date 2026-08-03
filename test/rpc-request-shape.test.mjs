// What rpc.mjs actually puts on the wire.
//
// This file exists because of the 2026-08-03 failure, and it is the real fix;
// the missing parameter was only the symptom.
//
// `getTransaction` was called without an `encoding` parameter. Solana's default
// is "json", not "jsonParsed": account keys come back as bare strings instead of
// {pubkey, signer, writable} objects, and instructions carry programIdIndex
// rather than programId, with no `parsed` member at all. Every check in
// funding-proof.mjs reads exactly those fields, so a perfectly correct payment
// -- right memo, right amount, right payer, on time -- failed at the very first
// gate with `payer_did_not_sign`, was blacklisted in `seen`, and was never
// looked at again for the remaining 218 seconds.
//
// Nothing caught it, and the reason is worth more than the bug:
//
//   * 28 funding-proof tests hand a jsonParsed fixture straight to the
//     validator, so they never travel through rpc.mjs.
//   * 8 hermetic end-to-end tests use a fake RPC that ignores request
//     parameters and always answers jsonParsed. A fake that honours the
//     client's INTENT rather than its REQUEST cannot detect a wrong request.
//   * The captured mainnet fixture was itself fetched with jsonParsed
//     explicitly set.
//
// The defect was not inside any layer. It was in the contract between two
// layers, and no test asserted what crosses it. So these tests assert the
// literal JSON-RPC request body, which is the one thing all of the above skip.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { SolanaRpc } from '../src/solana/rpc.mjs';

/** A loopback JSON-RPC server that records every request body verbatim. */
async function recordingRpc(reply = { ok: true }) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      requests.push(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: reply }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    requests,
    rpc: new SolanaRpc({ env: { SOLFRONTIER_RPC_URL: url } }),
    close: () => new Promise((r) => server.close(r)),
  };
}

describe('the JSON-RPC request body, as it goes on the wire', () => {
  test('getTransaction asks for jsonParsed, explicitly and always', async () => {
    // The 2026-08-03 regression, pinned. Without this parameter the response
    // has no `programId`, no `parsed` and no `accountKeys[].signer`, and every
    // funding check fails on a correct payment.
    const h = await recordingRpc(null);
    try {
      await h.rpc.getTransaction('SomeSignature', 'confirmed');
      const [req] = h.requests;
      assert.equal(req.method, 'getTransaction');
      const config = req.params[1];
      assert.equal(config.encoding, 'jsonParsed', 'encoding must be requested, never defaulted');
      assert.equal(config.maxSupportedTransactionVersion, 0);
      assert.equal(config.commitment, 'confirmed');
    } finally {
      await h.close();
    }
  });

  test('the default commitment is still explicit in the request', async () => {
    const h = await recordingRpc(null);
    try {
      await h.rpc.getTransaction('SomeSignature');
      assert.equal(h.requests[0].params[1].encoding, 'jsonParsed');
      assert.equal(h.requests[0].params[1].commitment, 'finalized');
    } finally {
      await h.close();
    }
  });

  test('every method that parses a response asks for a parsed response', async () => {
    // A blanket rule rather than one case: any call whose result is read
    // field-by-field must name its encoding, because the default is never the
    // shape the reader expects.
    const h = await recordingRpc({ value: [] });
    try {
      await h.rpc.getTransaction('S');
      await h.rpc.getTokenBalance('Owner', 'Mint');
      for (const req of h.requests) {
        const config = req.params.find((p) => p && typeof p === 'object' && !Array.isArray(p) && 'encoding' in p);
        assert.ok(config, `${req.method} must name an encoding`);
        assert.equal(config.encoding, 'jsonParsed', `${req.method} must ask for jsonParsed`);
      }
    } finally {
      await h.close();
    }
  });

  test('getSignaturesForAddress names its commitment and its limit', async () => {
    // Left implicit, this defaults to `finalized` while getTransaction is
    // called at `confirmed` -- the listing and the fetch disagreeing about
    // which chain state they are looking at.
    const h = await recordingRpc([]);
    try {
      await h.rpc.getSignaturesForAddress('SomeAta', 100);
      const config = h.requests[0].params[1];
      assert.equal(config.limit, 100);
      assert.equal(config.commitment, 'confirmed', 'the listing must match the fetch commitment');
    } finally {
      await h.close();
    }
  });

  test('getAccountInfo and getSlot name their commitment', async () => {
    const h = await recordingRpc({ value: null });
    try {
      await h.rpc.getSlot('confirmed');
      await h.rpc.getAccountInfo('SomeAccount');
      assert.equal(h.requests[0].params[0].commitment, 'confirmed');
      assert.equal(h.requests[1].params[1].commitment, 'confirmed');
      assert.equal(h.requests[1].params[1].encoding, 'base64');
    } finally {
      await h.close();
    }
  });
});
