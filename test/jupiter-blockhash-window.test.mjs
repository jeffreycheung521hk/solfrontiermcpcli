// Hermetic checks for the read-only window measurement: a fake ledger whose
// block height follows a fake clock. No network, wallet or Jupiter request.
import test from 'node:test';
import assert from 'node:assert/strict';
import { measureOnce, summarize, uuidv7Time, READ_METHODS, MACHINE_BUDGET_MS } from '../scripts/hackathon/phantom/jupiter-blockhash-window.mjs';
import { WALLET, SOL, USDC } from '../scripts/hackathon/phantom/phantom-keyless-runtime.mjs';
import { message, transaction } from './solana-builders.mjs';
import { decodeTransaction } from '../src/solana/tx.mjs';

const JUP6 = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';

function ledger({ msPerBlock = 220, ageAtReceiptBlocks = 45, requestId = '01a12b4c-6b87-76ac-8fa5-e1b2875ec6b9' } = {}) {
  const unsigned = Buffer.from(transaction(message({ version: 0, header: [1, 0, 1], keys: [WALLET, JUP6],
    instructions: [{ p: 1, a: [0], d: [1] }] }), [null])).toString('base64');
  const blockhash = decodeTransaction(Buffer.from(unsigned, 'base64')).recentBlockhash;
  let clock = 1_791_727_791_360; // 2026-10-11T14:09:51.360Z, the 2026-10-11 receipt time
  const startHeight = 433_717_954;
  const lastValidHeight = startHeight - ageAtReceiptBlocks + 150;
  const heightNow = () => startHeight + Math.floor((clock - 1_791_727_791_360) / msPerBlock);
  const calls = [];
  const rpc = async (method, params) => {
    calls.push(method);
    assert.ok(READ_METHODS.includes(method), `read-only method only: ${method}`);
    if (method === 'getBlockHeight') return heightNow();
    assert.equal(params[0], blockhash);
    const committed = params[1].commitment === 'finalized' ? heightNow() - 32 : heightNow();
    const born = lastValidHeight - 150;
    return { context: { slot: 455_680_818 + (heightNow() - startHeight) },
      value: committed >= born && committed <= lastValidHeight };
  };
  const order = { inputMint: SOL, outputMint: USDC, inAmount: '1000000', taker: WALLET, requestId, transaction: unsigned };
  return { rpc, calls, fetchOrder: async () => ({ ...order }), clock: () => clock,
    sleep: async (ms) => { clock += ms; }, blockhash };
}

test('Jupiter requestId UUIDv7 gives the order creation time', () => {
  assert.equal(new Date(uuidv7Time('01a12b4c-6b87-76ac-8fa5-e1b2875ec6b9')).toISOString(), '2026-10-11T14:09:50.983Z');
  assert.equal(uuidv7Time('not-a-uuid'), null);
  assert.equal(uuidv7Time('01a12b4c-6b87-46ac-8fa5-e1b2875ec6b9'), null, 'only version 7 carries a time');
});

test('measures the blockhash window from receipt with block-height bounds', async () => {
  const l = ledger({ msPerBlock: 220, ageAtReceiptBlocks: 45 });
  const row = await measureOnce({ rpc: l.rpc, fetchOrder: l.fetchOrder, clock: l.clock, sleep: l.sleep });
  assert.equal(row.status, 'EXPIRED_OBSERVED');
  assert.equal(row.blockhash, l.blockhash);
  assert.equal(row.receiptLagMs, 377);
  // 105 blocks were left at receipt: ~23.1 s at 220 ms per block, within one poll.
  assert.ok(row.lastValidMsAfterReceipt <= 105 * 220 && row.firstInvalidMsAfterReceipt > 105 * 220,
    JSON.stringify(row));
  assert.ok(row.blocksLeftAtReceiptMin <= 105 && row.blocksLeftAtReceiptMax >= 105, JSON.stringify(row));
  assert.equal(row.alreadyFinalizedAtReceipt, true, 'a 45-block-old hash is already in the finalized bank');
  assert.ok(l.calls.every((method) => READ_METHODS.includes(method)));
});

test('a fresh hash is not yet finalized and leaves ~30 s at 200 ms blocks', async () => {
  const l = ledger({ msPerBlock: 200, ageAtReceiptBlocks: 2 });
  const row = await measureOnce({ rpc: l.rpc, fetchOrder: l.fetchOrder, clock: l.clock, sleep: l.sleep });
  assert.equal(row.alreadyFinalizedAtReceipt, false);
  assert.ok(row.lastValidMsAfterReceipt > 28000 && row.lastValidMsAfterReceipt <= 29600, JSON.stringify(row));
});

test('summary turns windows into a human budget and a go / no-go verdict', () => {
  const sample = (ms) => ({ status: 'EXPIRED_OBSERVED', lastValidMsAfterReceipt: ms, firstInvalidMsAfterReceipt: ms + 500,
    slotAtReceipt: 0, slotAtFirstInvalid: Math.round((ms + 500) / 220) });
  assert.equal(summarize([sample(25000), sample(30000)]).verdict, 'OK');
  const tight = summarize([sample(17000), sample(29000)]);
  assert.equal(tight.minWindowMs, 17000);
  assert.equal(tight.humanBudgetMs, 17000 - MACHINE_BUDGET_MS);
  assert.equal(tight.verdict, 'TIGHT');
  assert.equal(summarize([sample(12000)]).verdict, 'TOO_SHORT');
  assert.equal(summarize([{ status: 'INVALID_AT_RECEIPT' }]).verdict, 'NO_MEASUREMENT');
});

test('an order for another wallet or amount is refused before any RPC', async () => {
  const l = ledger();
  await assert.rejects(() => measureOnce({ rpc: l.rpc, clock: l.clock, sleep: l.sleep,
    fetchOrder: async () => ({ ...(await l.fetchOrder()), inAmount: '2000000' }) }), /unexpected_order/);
  assert.equal(l.calls.length, 0);
});
