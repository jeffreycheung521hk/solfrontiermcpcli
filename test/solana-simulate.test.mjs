import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { simulateWithDeltas, MAX_WATCH } from '../src/solana/simulate.mjs';
import { SolanaRpc } from '../src/solana/rpc.mjs';
import {
  SYSTEM, TOKEN, TOKEN_2022, randomAddress, tokenAccountData, mintData, rpcAccount,
} from './solana-builders.mjs';

/**
 * An in-process fake RPC. `state.pre` / `state.post` map address → rpc account
 * (absent = does not exist); `owned` lists the wallet's token accounts per
 * program. Every request is recorded, so tests assert what goes on the wire.
 */
function fakeRpc({ pre = {}, post = {}, owned = {}, mints = {}, simErr = null, logs = ['Program log: ok'], units = 1234, failOn = null }) {
  const calls = [];
  return {
    calls,
    async call(method, params) {
      calls.push({ method, params });
      if (failOn === method) throw new Error(`${method} unavailable`);
      switch (method) {
        case 'getTokenAccountsByOwner': {
          const list = owned[params[1].programId] ?? [];
          return { context: { slot: 1 }, value: list.map((pubkey) => ({ pubkey, account: pre[pubkey] ?? null })) };
        }
        case 'getMultipleAccounts': {
          const value = params[0].map((a) => mints[a] ?? pre[a] ?? null);
          return { context: { slot: 1 }, value };
        }
        case 'simulateTransaction': {
          const addresses = params[1].accounts.addresses;
          return {
            context: { slot: 2 },
            value: {
              err: simErr, logs, unitsConsumed: units,
              accounts: simErr ? null : addresses.map((a) => post[a] ?? null),
            },
          };
        }
        default:
          throw new Error(`unexpected method ${method}`);
      }
    },
  };
}

const tokenAcct = (mint, owner, amount, program = TOKEN) => rpcAccount({
  lamports: 2_039_280, owner: program, data: tokenAccountData({ mint, owner, amount }),
});
const mintAcct = (decimals, program = TOKEN) => rpcAccount({ lamports: 1_461_600, owner: program, data: mintData({ decimals }) });

describe('simulateWithDeltas', () => {
  test('request shapes: token-account discovery, pre-state, simulation', async () => {
    const wallet = randomAddress();
    const dest = randomAddress();
    const rpc = fakeRpc({
      pre: { [wallet]: rpcAccount({ lamports: 5_000_000 }) },
      post: { [wallet]: rpcAccount({ lamports: 3_995_000 }), [dest]: rpcAccount({ lamports: 1_000_000 }) },
    });
    await simulateWithDeltas(rpc, { txBase64: 'AQID', wallet, sigVerify: true, watch: [dest] });
    const [byOwner1, byOwner2, pre, sim] = rpc.calls;
    assert.deepEqual(byOwner1.params, [wallet, { programId: TOKEN }, { encoding: 'base64', commitment: 'confirmed' }]);
    assert.deepEqual(byOwner2.params, [wallet, { programId: TOKEN_2022 }, { encoding: 'base64', commitment: 'confirmed' }]);
    assert.deepEqual(pre.params, [[wallet, dest], { encoding: 'base64', commitment: 'confirmed' }]);
    assert.equal(sim.method, 'simulateTransaction');
    assert.deepEqual(sim.params, ['AQID', {
      encoding: 'base64', sigVerify: true, replaceRecentBlockhash: false, commitment: 'confirmed',
      accounts: { encoding: 'base64', addresses: [wallet, dest] },
    }]);
  });

  test('lamport delta of the wallet, as BigInt', async () => {
    const wallet = randomAddress();
    const dest = randomAddress();
    const rpc = fakeRpc({
      pre: { [wallet]: rpcAccount({ lamports: 5_000_000 }) },
      post: { [wallet]: rpcAccount({ lamports: 3_995_000 }), [dest]: rpcAccount({ lamports: 1_000_000 }) },
    });
    const r = await simulateWithDeltas(rpc, { txBase64: 'AQID', wallet, sigVerify: false, watch: [dest] });
    assert.equal(r.ok, true);
    assert.equal(r.err, null);
    assert.deepEqual(r.logs, ['Program log: ok']);
    assert.equal(r.unitsConsumed, 1234);
    assert.deepEqual(r.lamports, { pre: 5_000_000n, post: 3_995_000n });
    assert.deepEqual(r.tokens, []);
    assert.deepEqual(r.accounts.get(dest), { exists: true, ownerProgram: SYSTEM, tokenOwner: null, mint: null });
    assert.deepEqual(r.accounts.get(wallet).exists, true);
  });

  test('two token mints (one per token program), decimals read from mint data', async () => {
    const wallet = randomAddress();
    const [usdc, bonk] = [randomAddress(), randomAddress()];
    const [a1, a2] = [randomAddress(), randomAddress()];
    const rpc = fakeRpc({
      owned: { [TOKEN]: [a1], [TOKEN_2022]: [a2] },
      pre: {
        [wallet]: rpcAccount({ lamports: 10_000_000 }),
        [a1]: tokenAcct(usdc, wallet, 5_000_000n),
        [a2]: tokenAcct(bonk, wallet, 0n, TOKEN_2022),
      },
      post: {
        [wallet]: rpcAccount({ lamports: 9_995_000 }),
        [a1]: tokenAcct(usdc, wallet, 4_000_000n),
        [a2]: tokenAcct(bonk, wallet, 123_456_789n, TOKEN_2022),
      },
      mints: { [usdc]: mintAcct(6), [bonk]: mintAcct(5, TOKEN_2022) },
    });
    const r = await simulateWithDeltas(rpc, { txBase64: 'AQID', wallet, sigVerify: false });
    assert.deepEqual(r.tokens, [
      { account: a1, mint: usdc, owner: wallet, pre: 5_000_000n, post: 4_000_000n, decimals: 6 },
      { account: a2, mint: bonk, owner: wallet, pre: 0n, post: 123_456_789n, decimals: 5 },
    ]);
    const mintCall = rpc.calls.at(-1);
    assert.equal(mintCall.method, 'getMultipleAccounts');
    assert.deepEqual(mintCall.params[0], [usdc, bonk]);
    assert.deepEqual(r.accounts.get(a1), { exists: true, ownerProgram: TOKEN, tokenOwner: wallet, mint: usdc });
  });

  test('a token account that does not exist before and is owned by the wallet after counts as own', async () => {
    const wallet = randomAddress();
    const mint = randomAddress();
    const ata = randomAddress();
    const rpc = fakeRpc({
      pre: { [wallet]: rpcAccount({ lamports: 10_000_000 }) },
      post: { [wallet]: rpcAccount({ lamports: 7_955_720 }), [ata]: tokenAcct(mint, wallet, 170_000n) },
      mints: { [mint]: mintAcct(6) },
    });
    const r = await simulateWithDeltas(rpc, { txBase64: 'AQID', wallet, sigVerify: false, watch: [ata] });
    assert.deepEqual(r.tokens, [{ account: ata, mint, owner: wallet, pre: 0n, post: 170_000n, decimals: 6 }]);
    assert.deepEqual(r.accounts.get(ata), { exists: true, ownerProgram: TOKEN, tokenOwner: wallet, mint });
  });

  test("a destination token account owned by someone else is not the wallet's", async () => {
    const wallet = randomAddress();
    const other = randomAddress();
    const mint = randomAddress();
    const [mine, theirs] = [randomAddress(), randomAddress()];
    const rpc = fakeRpc({
      owned: { [TOKEN]: [mine] },
      pre: { [wallet]: rpcAccount({ lamports: 1 }), [mine]: tokenAcct(mint, wallet, 100n), [theirs]: tokenAcct(mint, other, 0n) },
      post: { [wallet]: rpcAccount({ lamports: 1 }), [mine]: tokenAcct(mint, wallet, 0n), [theirs]: tokenAcct(mint, other, 100n) },
      mints: { [mint]: mintAcct(0) },
    });
    const r = await simulateWithDeltas(rpc, { txBase64: 'AQID', wallet, sigVerify: false, watch: [theirs] });
    assert.deepEqual(r.tokens.map((t) => [t.account, t.pre, t.post]), [[mine, 100n, 0n]]);
    assert.equal(r.accounts.get(theirs).tokenOwner, other);
  });

  test('an account handed to another owner, or closed, counts down to zero', async () => {
    const wallet = randomAddress();
    const attacker = randomAddress();
    const mint = randomAddress();
    const [handed, closed] = [randomAddress(), randomAddress()];
    const rpc = fakeRpc({
      owned: { [TOKEN]: [handed, closed] },
      pre: { [wallet]: rpcAccount({ lamports: 1 }), [handed]: tokenAcct(mint, wallet, 500n), [closed]: tokenAcct(mint, wallet, 0n) },
      post: { [wallet]: rpcAccount({ lamports: 2_039_281 }), [handed]: tokenAcct(mint, attacker, 500n) },
    });
    const r = await simulateWithDeltas(rpc, { txBase64: 'AQID', wallet, sigVerify: false });
    assert.deepEqual(r.tokens, [
      { account: handed, mint, owner: wallet, pre: 500n, post: 0n, decimals: null },
      { account: closed, mint, owner: wallet, pre: 0n, post: 0n, decimals: null },
    ]);
    assert.equal(r.accounts.get(closed).exists, false);
  });

  test('a simulation err is passed through, not thrown', async () => {
    const wallet = randomAddress();
    const err = { InstructionError: [0, { Custom: 1 }] };
    const rpc = fakeRpc({ pre: { [wallet]: rpcAccount({ lamports: 42 }) }, simErr: err, logs: ['Program failed'] });
    const r = await simulateWithDeltas(rpc, { txBase64: 'AQID', wallet, sigVerify: true });
    assert.equal(r.ok, false);
    assert.deepEqual(r.err, err);
    assert.deepEqual(r.logs, ['Program failed']);
    assert.deepEqual(r.lamports, { pre: 42n, post: 42n });
  });

  test('an RPC throw at any step rejects (the caller fails closed)', async () => {
    const wallet = randomAddress();
    for (const method of ['getTokenAccountsByOwner', 'getMultipleAccounts', 'simulateTransaction']) {
      const rpc = fakeRpc({ pre: { [wallet]: rpcAccount({ lamports: 1 }) }, failOn: method });
      await assert.rejects(simulateWithDeltas(rpc, { txBase64: 'AQID', wallet, sigVerify: false }), new RegExp(method));
    }
  });

  test('malformed responses reject', async () => {
    const wallet = randomAddress();
    const base = fakeRpc({});
    const broken = (override) => ({
      call: async (method, params) => (override[method] ? override[method](params) : base.call(method, params)),
    });
    const run = (rpc) => simulateWithDeltas(rpc, { txBase64: 'AQID', wallet, sigVerify: false });
    await assert.rejects(run(broken({ getTokenAccountsByOwner: () => ({}) })), /malformed/);
    await assert.rejects(run(broken({ getMultipleAccounts: () => ({ value: [] }) })), /malformed/);
    await assert.rejects(run(broken({ simulateTransaction: () => ({}) })), /malformed/);
    await assert.rejects(run(broken({ simulateTransaction: () => ({ value: { err: null, accounts: null } }) })), /post-state/);
    await assert.rejects(run(broken({
      getMultipleAccounts: () => ({ value: [{ lamports: 1, owner: SYSTEM, data: ['x', 'base58'] }] }),
    })), /not base64/);
    await assert.rejects(run(broken({
      getMultipleAccounts: () => ({ value: [{ lamports: '1', owner: SYSTEM, data: ['', 'base64'] }] }),
    })), /lamports/);
  });

  test('bad arguments and an oversized watch set are refused, never trimmed', async () => {
    const wallet = randomAddress();
    const rpc = fakeRpc({});
    await assert.rejects(simulateWithDeltas(rpc, { txBase64: 'AQID', wallet: 'nope!', sigVerify: false }), /base58/);
    await assert.rejects(simulateWithDeltas(rpc, { txBase64: '', wallet, sigVerify: false }), TypeError);
    await assert.rejects(simulateWithDeltas(rpc, { txBase64: 'AQID', wallet }), /sigVerify/);
    const watch = Array.from({ length: MAX_WATCH }, randomAddress);
    await assert.rejects(simulateWithDeltas(rpc, { txBase64: 'AQID', wallet, sigVerify: false, watch }), /too many accounts/);
    const ok = await simulateWithDeltas(fakeRpc({}), { txBase64: 'AQID', wallet, sigVerify: false, watch: watch.slice(1) });
    assert.equal(ok.accounts.size, MAX_WATCH);
  });
});

describe('SolanaRpc { url }', () => {
  async function recorder() {
    const bodies = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        bodies.push(JSON.parse(body));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 7 }));
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { bodies, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
  }

  test('uses `url` without SOLFRONTIER_RPC_URL', async () => {
    const h = await recorder();
    try {
      const rpc = new SolanaRpc({ url: h.url, env: {} });
      assert.equal(await rpc.getSlot(), 7);
      assert.equal(h.bodies[0].method, 'getSlot');
    } finally {
      await h.close();
    }
  });

  test('`url` wins over SOLFRONTIER_RPC_URL', async () => {
    const h = await recorder();
    try {
      const rpc = new SolanaRpc({ url: h.url, env: { SOLFRONTIER_RPC_URL: 'http://127.0.0.1:9' } });
      assert.equal(await rpc.call('getSlot'), 7);
      assert.equal(h.bodies.length, 1);
    } finally {
      await h.close();
    }
  });

  test('without `url`, the env var is still required', () => {
    assert.throws(() => new SolanaRpc({ env: {} }), /SOLFRONTIER_RPC_URL/);
    assert.throws(() => new SolanaRpc({ url: '', env: {} }), TypeError);
  });

  test('the explicit url never appears in an error', async () => {
    const h = await recorder();
    const url = `${h.url}/?api-key=testonlynotreal`;
    await h.close();
    const rpc = new SolanaRpc({ url, env: {}, timeoutMs: 2000 });
    await assert.rejects(rpc.call('getSlot'), (err) => {
      assert.ok(!err.message.includes('testonlynotreal'), err.message);
      assert.ok(!err.message.includes(h.url), err.message);
      return true;
    });
  });
});
