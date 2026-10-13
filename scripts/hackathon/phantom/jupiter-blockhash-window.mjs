// Read-only measurement: how long does a fresh Jupiter Ultra order stay
// executable on mainnet right now? It asks Jupiter for an unsigned order, then
// polls the order's blockhash until the chain says it is gone.
// No wallet file, signing, simulation or execute. RPC methods used:
// getGenesisHash, isBlockhashValid, getBlockHeight. Nothing is retried.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { decodeTransaction } from '../../../src/solana/tx.mjs';
import { WALLET, SOL, USDC, MAINNET_GENESIS } from './phantom-keyless-runtime.mjs';

export const READ_METHODS = Object.freeze(['getGenesisHash', 'isBlockhashValid', 'getBlockHeight']);
export const POLL_MS = 500;
export const MAX_WATCH_MS = 90000;
// What the prototype needs outside human hands, from the 2026-10-11 audit:
// quote review ~0.7 s, post-signature review ~0.8 s, final check ~0.2 s, and
// ~2 s for Jupiter to land the transaction before the hash dies; plus 1 s margin.
export const MACHINE_BUDGET_MS = 4700;
const OUTPUT = fileURLToPath(new URL('../../../.sfgate-phantom-state/jupiter-blockhash-window.json', import.meta.url));

/** Jupiter requestIds are UUIDv7: the first 48 bits are the creation time in ms. */
export function uuidv7Time(id) {
  if (typeof id !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return null;
  return parseInt(id.replace(/-/g, '').slice(0, 12), 16);
}

const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const height = (value) => (Number.isSafeInteger(value) ? value : null);

/** One order: fetch, then poll its blockhash until the chain answers false. */
export async function measureOnce({ rpc, fetchOrder, clock = Date.now, sleep = delay,
  pollMs = POLL_MS, maxWatchMs = MAX_WATCH_MS }) {
  const order = await fetchOrder();
  const receivedAtMs = clock();
  if (!order || order.inputMint !== SOL || order.outputMint !== USDC || order.inAmount !== '1000000'
    || order.taker !== WALLET || typeof order.transaction !== 'string') throw new Error('unexpected_order');
  const blockhash = decodeTransaction(Buffer.from(order.transaction, 'base64')).recentBlockhash;
  const jupiterCreatedAtMs = uuidv7Time(order.requestId);
  const [confirmed, finalized, startHeight] = await Promise.all([
    rpc('isBlockhashValid', [blockhash, { commitment: 'confirmed' }]),
    rpc('isBlockhashValid', [blockhash, { commitment: 'finalized' }]),
    rpc('getBlockHeight', [{ commitment: 'confirmed' }]),
  ]);
  const row = { requestId: typeof order.requestId === 'string' ? order.requestId : null,
    jupiterCreatedAt: iso(jupiterCreatedAtMs), receivedAt: iso(receivedAtMs),
    receiptLagMs: jupiterCreatedAtMs === null ? null : receivedAtMs - jupiterCreatedAtMs,
    blockhash, validAtReceipt: confirmed?.value === true,
    // A hash the finalized bank already knows is at least ~32 blocks old.
    alreadyFinalizedAtReceipt: finalized?.value === true,
    heightAtReceipt: height(startHeight), slotAtReceipt: height(confirmed?.context?.slot) };
  if (!row.validAtReceipt) return { ...row, status: 'INVALID_AT_RECEIPT' };
  let lastValidMs = receivedAtMs;
  let lastValidHeight = row.heightAtReceipt;
  while (clock() - receivedAtMs < maxWatchMs) {
    await sleep(pollMs);
    const [answer, nowHeight] = await Promise.all([
      rpc('isBlockhashValid', [blockhash, { commitment: 'confirmed' }]),
      rpc('getBlockHeight', [{ commitment: 'confirmed' }]),
    ]);
    const at = clock();
    if (answer?.value === true) { lastValidMs = at; lastValidHeight = height(nowHeight); continue; }
    if (answer?.value !== false) continue; // malformed answers prove nothing either way
    const blocksLeft = (h) => (h === null || row.heightAtReceipt === null ? null : h - row.heightAtReceipt);
    return { ...row, status: 'EXPIRED_OBSERVED',
      lastValidMsAfterReceipt: lastValidMs - receivedAtMs, firstInvalidMsAfterReceipt: at - receivedAtMs,
      lastValidMsAfterJupiter: jupiterCreatedAtMs === null ? null : lastValidMs - jupiterCreatedAtMs,
      firstInvalidMsAfterJupiter: jupiterCreatedAtMs === null ? null : at - jupiterCreatedAtMs,
      heightAtFirstInvalid: height(nowHeight), slotAtFirstInvalid: height(answer?.context?.slot),
      // Blocks the hash still had when we received the order (bounds from poll edges).
      blocksLeftAtReceiptMin: blocksLeft(lastValidHeight),
      blocksLeftAtReceiptMax: height(nowHeight) === null ? null : blocksLeft(height(nowHeight) - 1) };
  }
  return { ...row, status: 'NOT_EXPIRED_WITHIN_WATCH', lastValidMsAfterReceipt: lastValidMs - receivedAtMs };
}

/** The decision a person needs: how many seconds the two signatures may take. */
export function summarize(samples) {
  const observed = samples.filter((s) => s.status === 'EXPIRED_OBSERVED');
  const windows = observed.map((s) => s.lastValidMsAfterReceipt).sort((a, b) => a - b);
  const slotRates = observed.filter((s) => s.slotAtReceipt !== null && s.slotAtFirstInvalid !== null
    && s.firstInvalidMsAfterReceipt > 0)
    .map((s) => s.firstInvalidMsAfterReceipt / (s.slotAtFirstInvalid - s.slotAtReceipt));
  if (!windows.length) {
    return { samples: samples.length, observed: 0, verdict: 'NO_MEASUREMENT', humanBudgetMs: null };
  }
  const minWindowMs = windows[0];
  const humanBudgetMs = minWindowMs - MACHINE_BUDGET_MS;
  return { samples: samples.length, observed: observed.length, minWindowMs,
    medianWindowMs: windows[Math.floor((windows.length - 1) / 2)], machineBudgetMs: MACHINE_BUDGET_MS,
    humanBudgetMs, msPerSlot: slotRates.length ? Math.round(slotRates.reduce((a, b) => a + b, 0) / slotRates.length) : null,
    verdict: humanBudgetMs >= 15000 ? 'OK' : humanBudgetMs >= 10000 ? 'TIGHT' : 'TOO_SHORT' };
}

function savedRpc() {
  const endpoint = (process.env.SFGATE_UPSTREAM_RPC_URL
    ?? readFileSync(path.join(homedir(), '.sfgate/mainnet-rpc.url'), 'utf8')).trim();
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.hostname !== 'mainnet.helius-rpc.com' || url.username || url.password
    || !url.searchParams.get('api-key')) throw new Error('invalid_saved_rpc');
  let id = 0;
  return async (method, params = []) => {
    if (!READ_METHODS.includes(method)) throw new Error('rpc_write_forbidden');
    const requestId = ++id;
    const response = await fetch(endpoint, { method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }), signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('rpc_failed');
    const body = await response.json();
    if (body.error || body.id !== requestId || !Object.hasOwn(body, 'result')) throw new Error('rpc_failed');
    return body.result;
  };
}

async function fetchJupiterOrder() {
  const params = new URLSearchParams({ inputMint: SOL, outputMint: USDC, amount: '1000000', taker: WALLET });
  const response = await fetch(`https://api.jup.ag/ultra/v1/order?${params}`, { redirect: 'error',
    signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error('order_failed');
  return response.json();
}

async function main() {
  const count = Math.min(5, Math.max(1, Number.parseInt(process.argv[2] ?? '3', 10) || 3));
  const report = { startedAt: new Date().toISOString(), readOnly: true, signingRequests: 0,
    simulationRequests: 0, executionRequests: 0, rpcMethods: READ_METHODS, samples: [] };
  const save = () => {
    mkdirSync(path.dirname(OUTPUT), { recursive: true });
    writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  };
  try {
    const rpc = savedRpc();
    if (await rpc('getGenesisHash') !== MAINNET_GENESIS) throw new Error('wrong_network');
    for (let i = 0; i < count; i += 1) {
      if (i) await delay(3000);
      const sample = await measureOnce({ rpc, fetchOrder: fetchJupiterOrder });
      report.samples.push(sample);
      save();
      console.log(`樣本 ${i + 1}/${count}：${sample.status}，收到報價後仍有效 ${
        sample.lastValidMsAfterReceipt === undefined ? '—' : (sample.lastValidMsAfterReceipt / 1000).toFixed(1)} 秒`
        + `${sample.alreadyFinalizedAtReceipt ? '（收到時 blockhash 已 finalized）' : ''}`);
    }
    report.summary = summarize(report.samples);
    report.status = 'CHECK_COMPLETE';
  } catch (error) {
    report.status = 'CHECK_UNAVAILABLE';
    report.reason = ['invalid_saved_rpc', 'wrong_network', 'unexpected_order', 'order_failed', 'rpc_failed',
      'rpc_write_forbidden'].includes(error?.message) ? error.message : 'unavailable';
  }
  report.finishedAt = new Date().toISOString();
  save();
  const s = report.summary;
  if (!s || s.humanBudgetMs === null) {
    console.log(`量測未完成（${report.reason ?? s?.verdict}）。沒有簽署、模擬或送出任何交易。`);
    process.exitCode = 1;
    return;
  }
  console.log(`最短有效期（收到報價起）：${(s.minWindowMs / 1000).toFixed(1)} 秒；扣除程式與上鏈所需 ${
    (s.machineBudgetMs / 1000).toFixed(1)} 秒後，兩次簽署＋核准最多可用 ${(s.humanBudgetMs / 1000).toFixed(1)} 秒。`);
  console.log({ OK: '判定 OK：可以照操作步驟做一次真實交換。',
    TIGHT: '判定 TIGHT：只有在熟練、事先排好兩個視窗時才嘗試；否則先不要做。',
    TOO_SHORT: '判定 TOO_SHORT：人手雙簽來不及，先不要做真實交換。' }[s.verdict]);
  console.log('沒有簽署、模擬或送出任何交易。結果已存到 .sfgate-phantom-state/jupiter-blockhash-window.json。');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('量測無法完成；沒有簽署或送出任何交易。'); process.exitCode = 1; });
}
