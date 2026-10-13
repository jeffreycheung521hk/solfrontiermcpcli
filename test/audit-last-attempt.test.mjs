// Hermetic checks for the audit timeline reader. Records are copied from the
// 2026-10-11 audit (seq 8-13, public fields only) or built in memory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeAttempt } from '../scripts/hackathon/phantom/audit-last-attempt.mjs';

const RID = '01a12b4c-6b87-76ac-8fa5-e1b2875ec6b9';
const CALL = '3b172e56c7d1';
const HASH = 'd392231ec32097e8c5a0e5c4f09cc347b543cc3e72dfdfd6ef5eb48b963fbe55';
const base = [
  { seq: 8, ts: '2026-10-11T14:09:52.028Z', type: 'public_order_review', requestId: RID, messageSha256: HASH,
    otherAmountThreshold: '109043', review: { verdict: 'hold' } },
  { seq: 9, ts: '2026-10-11T14:09:56.570Z', type: 'tool_call', callId: CALL, tool: 'jup__execute-ultra-order',
    decision: 'bound', args: { requestId: RID } },
  { seq: 10, ts: '2026-10-11T14:09:57.323Z', type: 'tx_review', callId: CALL, parentIds: [CALL], sim: { ok: true, err: null } },
  { seq: 11, ts: '2026-10-11T14:09:57.325Z', type: 'hold_created', callId: CALL, parentIds: [CALL], holdId: '0707fc8aa8ed',
    expiresAt: '2026-10-11T14:10:57.324Z' },
  { seq: 12, ts: '2026-10-11T14:10:14.305Z', type: 'hold_approved', callId: CALL, parentIds: [CALL],
    method: 'wallet-signature' },
];

test('2026-10-11 records: old build shows no stage, but the 211 ms gap points at the blockhash RPC', () => {
  const records = [...base, { seq: 13, ts: '2026-10-11T14:10:14.516Z', type: 'tool_result', callId: CALL,
    resultSha256: '3da3e73b3b6c518e349c4ac801768e56307bdccf6918f8eebb940f8fbe1dfb86', isError: true }];
  const { lines, conclusion } = summarizeAttempt(records);
  assert.match(lines[0], /23:09:50\.983 JST/);
  assert.ok(lines.some((line) => /\+23\.32 s  #12 Gate Approver 已核准/.test(line)), lines.join('\n'));
  assert.match(conclusion, /舊版紀錄沒有 stage：核准後 211 ms/);
  assert.match(conclusion, /isBlockhashValid（stage=blockhash_freshness）/);
});

test('new build names the failing guard, the code and the elapsed time', () => {
  const records = [...base, { seq: 13, ts: '2026-10-11T14:10:14.516Z', type: 'execution_refused', callId: CALL,
    requestId: RID, stage: 'blockhash_freshness', code: 'blockhash_expired', msSinceOrder: 23156,
    blockhashValid: false, blockhashContextSlot: 455679600 },
  { seq: 14, ts: '2026-10-11T14:10:14.517Z', type: 'tool_result', callId: CALL, isError: true }];
  const { conclusion, lines } = summarizeAttempt(records);
  assert.equal(conclusion, '未送出。失敗 guard：stage=blockhash_freshness，code=blockhash_expired，發生在 Jupiter 建單後 23.5 秒。原因：交易有效期（blockhash）已過。');
  assert.ok(lines.some((line) => /isBlockhashValid=false（slot 455679600）/.test(line)));
});

test('watchdog expiry before approval is reported with the phase', () => {
  const records = [...base.slice(0, 4),
    { seq: 12, ts: '2026-10-11T14:10:10.000Z', type: 'order_blockhash_expired', callId: CALL, requestId: RID,
      phase: 'gate-approval-pending', contextSlot: 1 },
    { seq: 13, ts: '2026-10-11T14:10:10.001Z', type: 'hold_cancelled', callId: CALL, parentIds: [CALL], reason: 'blockhash expired' }];
  assert.match(summarizeAttempt(records).conclusion, /建單後 19\.0 秒結束（gate-approval-pending），核准請求已取消/);
});

test('submitted attempt points to on-chain verification, never a resend', () => {
  const signature = '4'.repeat(88);
  const records = [...base, { seq: 13, ts: '2026-10-11T14:10:14.600Z', type: 'execute_attempt', callId: CALL,
    requestId: RID, signature, messageSha256: HASH }];
  assert.match(summarizeAttempt(records).conclusion, /verify-phantom-mainnet\.mjs.*不要重送/);
});

test('unsigned last quote and empty log are reported plainly', () => {
  assert.equal(summarizeAttempt([base[0]]).conclusion, '最後一份報價沒有被簽署送出。');
  assert.equal(summarizeAttempt([]).conclusion, '紀錄中沒有報價。');
});

test('a newer unsigned rehearsal quote is the latest attempt and shows its measured window', () => {
  const RID2 = '01a12b9f-0000-7000-8000-000000000000';
  const created = Number.parseInt(RID2.replace(/-/g, '').slice(0, 12), 16);
  const records = [...base, { seq: 13, ts: '2026-10-11T14:10:14.516Z', type: 'tool_result', callId: CALL, isError: true },
    { seq: 14, ts: new Date(created + 1100).toISOString(), type: 'public_order_review', requestId: RID2,
      otherAmountThreshold: '109100', review: { verdict: 'hold' }, receivedAt: new Date(created + 400).toISOString() },
    { seq: 15, ts: new Date(created + 21400).toISOString(), type: 'order_blockhash_expired', callId: null,
      requestId: RID2, phase: 'awaiting-signature', contextSlot: 2 }];
  const { lines, conclusion } = summarizeAttempt(records);
  assert.match(lines[0], new RegExp(RID2));
  assert.ok(lines.some((line) => /\+0\.40 s  本機收到報價/.test(line)), lines.join('\n'));
  assert.equal(conclusion, '這份報價沒有被簽署；交易有效期在 Jupiter 建單後 21.4 秒結束。');
});

test('unsigned local safety deadline is distinguished from chain expiry', () => {
  const records = [base[0], { seq: 9, ts: '2026-10-11T14:10:10.028Z', type: 'order_window_expired',
    requestId: RID, phase: 'awaiting-signature', executionReserveMs: 2000 }];
  const { lines, conclusion } = summarizeAttempt(records);
  assert.ok(lines.some(line => /本機簽署與核准安全期限.*保留 2 秒/.test(line)));
  assert.match(conclusion, /未送出。本機簽署與核准安全期限/);
  assert.match(conclusion, /不能單憑它判定鏈上 blockhash 已過期/);
});

test('pending hold cancelled by local deadline is named in the timeline', () => {
  const records = [...base.slice(0, 4), { seq: 12, ts: '2026-10-11T14:10:10.028Z',
    type: 'order_window_expired', callId: CALL, requestId: RID,
    phase: 'gate-approval-pending', executionReserveMs: 2000 },
    { seq: 13, ts: '2026-10-11T14:10:10.029Z', type: 'hold_cancelled', callId: CALL,
      parentIds: [CALL], reason: 'approval window expired' }];
  assert.match(summarizeAttempt(records).conclusion, /gate-approval-pending.*核准請求已取消/);
});

test('late payment is reported without a hold and earlier quote expiry cannot contaminate a replacement', () => {
  const records = [base[0], { seq: 9, ts: '2026-10-11T14:10:10.028Z', type: 'order_window_expired',
    requestId: RID, phase: 'awaiting-signature', executionReserveMs: 2000 },
    { ...base[0], seq: 10, ts: '2026-10-11T14:10:11.000Z' },
    { seq: 11, ts: '2026-10-11T14:10:23.001Z', type: 'payment_signature_rejected', requestId: RID,
      stage: 'payment_signature_age', code: 'payment_signature_too_late' }];
  const { lines, conclusion } = summarizeAttempt(records);
  assert.match(conclusion, /付款簽名.*已超過付款期限；沒有建立 Gate 核准.*手動重新取得報價/);
  assert.ok(lines.some(line => /付款簽名送到太晚/.test(line)));
  assert.ok(!lines.some(line => /#9 /.test(line)));
});

test('an explicit refusal after an audit intent still identifies the failed final guard', () => {
  const records = [...base, { seq: 13, ts: '2026-10-11T14:10:14.600Z', type: 'execute_attempt',
    callId: CALL, requestId: RID, signature: '4'.repeat(88), messageSha256: HASH },
    { seq: 14, ts: '2026-10-11T14:10:14.601Z', type: 'execution_refused', callId: CALL,
      requestId: RID, stage: 'post_intent_execution_reserve', code: 'approval_window_expired' }];
  assert.match(summarizeAttempt(records).conclusion, /未送出。失敗 guard：stage=post_intent_execution_reserve/);
});
