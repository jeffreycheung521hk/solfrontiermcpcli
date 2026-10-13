// Read-only: print the last swap attempt from the Gate audit as a timeline
// a person can read, ending with which guard decided it. No network, no RPC.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyChainText } from '../../../src/gate/audit-log.mjs';
import { uuidv7Time } from './jupiter-blockhash-window.mjs';

const AUDIT = process.env.SFGATE_PHANTOM_AUDIT_PATH
  ? path.resolve(process.env.SFGATE_PHANTOM_AUDIT_PATH)
  : fileURLToPath(new URL('../../../docs/proof/mainnet-2026-10-12/audit.jsonl', import.meta.url));
const TOOL = 'jup__execute-ultra-order';

const jst = (ms) => new Date(ms + 9 * 3600000).toISOString().slice(11, 23);
const usdc = (raw) => (/^\d+$/.test(String(raw)) ? (Number(raw) / 1e6).toFixed(6) : '?');

function label(r) {
  switch (r.type) {
    case 'public_order_review': return `報價檢查${r.review?.verdict === 'hold' ? '通過' : '未通過'}（最低 ${usdc(r.otherAmountThreshold)} USDC）`;
    case 'tool_call': return '付款簽署已送到 Gate';
    case 'tx_review': return `最後模擬${r.sim?.ok ? '通過' : `失敗：${JSON.stringify(r.sim?.err ?? null)}`}`;
    case 'hold_created': return `建立 Gate 核准請求（期限 ${jst(Date.parse(r.expiresAt))} JST）`;
    case 'hold_approved': return `Gate Approver 已核准（${r.method}）`;
    case 'hold_cancelled': return `核准請求已取消（${r.reason ?? '未註明'}）`;
    case 'hold_expired': return '核准請求逾時';
    case 'hold_rejected': return '核准請求被拒絕';
    case 'order_blockhash_expired': return `鏈上確認交易有效期已過（${r.phase}，slot ${r.contextSlot ?? '?'}）`;
    case 'order_window_expired': return `本機簽署與核准安全期限已到（${r.phase}，保留 ${r.executionReserveMs / 1000} 秒送出時間）`;
    case 'payment_signature_rejected': return `付款簽名送到太晚，未建立核准請求（stage=${r.stage}，code=${r.code}）`;
    case 'execution_refused': return `送出前拒絕：stage=${r.stage}，code=${r.code}${
      r.blockhashValid === false ? `，isBlockhashValid=false（slot ${r.blockhashContextSlot ?? '?'}）` : ''}`;
    case 'execute_attempt': return `已寫入送出意圖（候選簽名 ${r.signature}；此紀錄不能證明已送出）`;
    case 'tool_result': return `Gate 結果：${r.isError ? '錯誤' : '完成'}${r.signature ? `，簽名 ${r.signature}` : ''}`;
    default: return r.type;
  }
}

/** The last attempt's records, timeline lines and a one-line conclusion. */
export function summarizeAttempt(records) {
  const lastQuote = records.filter((r) => r.type === 'public_order_review').at(-1);
  const lastCall = records.filter((r) => r.type === 'tool_call' && r.tool === TOOL && r.decision !== 'deny').at(-1);
  // A quote newer than the last signature is the latest attempt (e.g. a rehearsal left to expire).
  const call = lastCall && (!lastQuote || lastCall.seq > lastQuote.seq) ? lastCall : null;
  const requestId = call ? call.args?.requestId : lastQuote?.requestId;
  if (!requestId) return { lines: [], conclusion: '紀錄中沒有報價。' };
  const quote = records.filter((r) => r.type === 'public_order_review' && r.requestId === requestId
    && (!call || r.seq < call.seq)).at(-1);
  const related = records.filter((r) => r === quote || (call && r.seq >= call.seq && (r.callId === call.callId
    || r.parentIds?.includes(call.callId))) || (['order_blockhash_expired', 'order_window_expired', 'payment_signature_rejected'].includes(r.type)
      && r.requestId === requestId && r.seq >= (quote?.seq ?? call?.seq ?? 0)));
  const origin = uuidv7Time(requestId) ?? Date.parse(quote?.receivedAt ?? related[0]?.ts);
  const lines = [`Jupiter requestId ${requestId}（建單 ${jst(origin)} JST）`];
  if (quote?.receivedAt) lines.push(`  +${((Date.parse(quote.receivedAt) - origin) / 1000).toFixed(2)} s  本機收到報價`);
  for (const r of related) lines.push(`  +${((Date.parse(r.ts) - origin) / 1000).toFixed(2)} s  #${r.seq} ${label(r)}`);
  const find = (type) => related.find((r) => r.type === type);
  const seconds = (r) => ((Date.parse(r.ts) - origin) / 1000).toFixed(1);
  let conclusion;
  if (find('execution_refused')) {
    const r = find('execution_refused');
    conclusion = `未送出。失敗 guard：stage=${r.stage}，code=${r.code}，發生在 Jupiter 建單後 ${seconds(r)} 秒。`
      + (r.code === 'blockhash_expired' ? '原因：交易有效期（blockhash）已過。' : '');
  } else if (find('execute_attempt')) {
    conclusion = `已記錄送出意圖；這一筆紀錄不能證明已呼叫 Jupiter 或上鏈。先用 verify-phantom-mainnet.mjs 查核候選簽名 ${find('execute_attempt').signature}，不要重送。`;
  } else if (find('order_blockhash_expired')) {
    const r = find('order_blockhash_expired');
    conclusion = r.phase === 'awaiting-signature'
      ? `這份報價沒有被簽署；交易有效期在 Jupiter 建單後 ${seconds(r)} 秒結束。`
      : `未送出。交易有效期在 Jupiter 建單後 ${seconds(r)} 秒結束（${r.phase}），核准請求已取消。`;
  } else if (find('payment_signature_rejected')) {
    const r = find('payment_signature_rejected');
    conclusion = `未送出。付款簽名在 Jupiter 建單後 ${seconds(r)} 秒送到，已超過付款期限；沒有建立 Gate 核准。請手動重新取得報價。`;
  } else if (find('order_window_expired')) {
    const r = find('order_window_expired');
    conclusion = `未送出。本機簽署與核准安全期限在 Jupiter 建單後 ${seconds(r)} 秒到達（${r.phase}）`
      + (r.phase === 'gate-approval-pending' ? '，核准請求已取消。' : '。')
      + '這是本機期限紀錄，不能單憑它判定鏈上 blockhash 已過期。';
  } else if (find('tool_result')?.isError && find('hold_approved')) {
    const gap = Date.parse(find('tool_result').ts) - Date.parse(find('hold_approved').ts);
    conclusion = `未送出。舊版紀錄沒有 stage：核准後 ${gap} ms 返回錯誤（resultSha256 ${find('tool_result').resultSha256?.slice(0, 12)}…）。`
      + (gap >= 50 ? '這段時間相當於一次 RPC 來回，而核准後唯一的 RPC 是 isBlockhashValid（stage=blockhash_freshness）。'
        : '這麼短的時間代表在核准後的同步檢查就失敗了。');
  } else if (find('tx_review') && !find('tx_review').sim?.ok) {
    conclusion = `未送出。付款簽署後的最後模擬失敗：${JSON.stringify(find('tx_review').sim?.err ?? null)}。`;
  } else if (find('hold_expired') || find('hold_rejected') || find('hold_cancelled')) {
    conclusion = `未送出。${label(find('hold_expired') ?? find('hold_rejected') ?? find('hold_cancelled'))}。`;
  } else if (!call) {
    conclusion = '最後一份報價沒有被簽署送出。';
  } else {
    conclusion = '仍在處理中，或紀錄不完整；請保留 audit 檔，不要重送。';
  }
  return { lines, conclusion };
}

function main() {
  const text = readFileSync(AUDIT, 'utf8');
  const chain = verifyChainText(text.replace(/\r\n/g, '\n'));
  if (!chain.ok) {
    console.log(`audit 雜湊鏈驗證失敗（第 ${chain.firstBadLine} 行：${chain.reason}）。請保留檔案，不要修改。`);
    process.exitCode = 1;
    return;
  }
  const records = text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const { lines, conclusion } = summarizeAttempt(records);
  console.log(`audit 雜湊鏈完整：${chain.count} 筆，最後雜湊 ${chain.lastHash}`);
  for (const line of lines) console.log(line);
  console.log(`結論：${conclusion}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch { console.error('無法讀取 audit；沒有修改任何檔案。'); process.exitCode = 1; }
}
