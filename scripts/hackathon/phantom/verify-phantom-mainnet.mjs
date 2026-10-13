// Read-only reconciliation for exactly one Phantom-signed mainnet candidate.
// Never imports a wallet file, signs, simulates, executes, or retries a request.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeTransaction, messageSha256, verifySignatures } from '../../../src/solana/tx.mjs';
import { decode, decodePublicKey, encode } from '../../../src/solana/base58.mjs';
import { verifyChainText } from '../../../src/gate/audit-log.mjs';
import { buildApprovalMessage, verifyApproval } from '../../../src/gate/holds.mjs';
import { assetChanges, formatUnits } from '../../../src/gate/tx-policy.mjs';
import { collectSentTransactions, verifyAuditLog } from '../../../src/commands/audit.mjs';

export const WALLET = 'J3rFAMrr2GDNhDg2x3Cn2K9iNKyrGh4WcqbmNG9xKaRj';
export const APPROVER = '6N7UYBzKmdHYtUssw45QDbGd1No2xUVTFkkVwnovTd3M';
export const WSOL = 'So11111111111111111111111111111111111111112';
export const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const AUDIT_PATH = process.env.SFGATE_PHANTOM_AUDIT_PATH
  ? path.resolve(process.env.SFGATE_PHANTOM_AUDIT_PATH)
  : path.join(ROOT, 'docs/proof/mainnet-2026-10-12/audit.jsonl');
const OUTPUT_PATH = path.join(ROOT, '.sfgate-phantom-state/mainnet-phantom-final-verification.json');
const SHA256 = /^[0-9a-f]{64}$/;
const rawAmount = (value) => typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) && value.length <= 78;

class VerificationError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const requireThat = (condition, code) => { if (!condition) throw new VerificationError(code); };
const one = (rows, code) => { requireThat(rows.length === 1, code); return rows[0]; };

export function checkSignature(signature) {
  requireThat(typeof signature === 'string' && signature.length >= 64 && signature.length <= 100,
    'INVALID_CANDIDATE_SIGNATURE');
  let bytes;
  try { bytes = decode(signature); } catch { throw new VerificationError('INVALID_CANDIDATE_SIGNATURE'); }
  requireThat(bytes.length === 64 && encode(bytes) === signature, 'INVALID_CANDIDATE_SIGNATURE');
  return signature;
}

/** Resolve ledger account indexes directly; no current lookup-table RPC is needed. */
export function ledgerBalances(tx, { wallet = WALLET } = {}) {
  requireThat(Array.isArray(tx?.transaction) && tx.transaction[1] === 'base64'
    && typeof tx.transaction[0] === 'string', 'MISSING_BASE64_TRANSACTION');
  const bytes = Buffer.from(tx.transaction[0], 'base64');
  requireThat(bytes.toString('base64') === tx.transaction[0] && bytes.length <= 1232,
    'INVALID_LEDGER_TRANSACTION_ENCODING');
  let decoded;
  try { decoded = decodeTransaction(bytes); } catch { throw new VerificationError('INVALID_LEDGER_TRANSACTION'); }
  requireThat(verifySignatures(decoded).complete, 'INVALID_LEDGER_SIGNATURES');
  const meta = tx.meta;
  requireThat(meta && Object.hasOwn(meta, 'err') && meta.err === null, 'ON_CHAIN_EXECUTION_FAILED');
  requireThat(Number.isSafeInteger(tx.slot) && tx.slot >= 0, 'INVALID_LEDGER_SLOT');
  const loaded = meta.loadedAddresses ?? { writable: [], readonly: [] };
  requireThat(Array.isArray(loaded.writable) && Array.isArray(loaded.readonly), 'MISSING_LOADED_ADDRESSES');
  const nw = decoded.addressTableLookups.reduce((n, l) => n + l.writableIndexes.length, 0);
  const nr = decoded.addressTableLookups.reduce((n, l) => n + l.readonlyIndexes.length, 0);
  requireThat(loaded.writable.length === nw && loaded.readonly.length === nr, 'LOADED_ADDRESS_COUNT_MISMATCH');
  const keys = [...decoded.staticAccountKeys, ...loaded.writable, ...loaded.readonly];
  requireThat(new Set(keys).size === keys.length, 'DUPLICATE_LEDGER_ACCOUNT');
  try { keys.forEach(decodePublicKey); } catch { throw new VerificationError('INVALID_LEDGER_ACCOUNT'); }
  const walletIndex = keys.indexOf(wallet);
  requireThat(walletIndex >= 0 && walletIndex < decoded.header.numRequiredSignatures,
    'WALLET_NOT_A_LEDGER_SIGNER');
  requireThat(Array.isArray(meta.preBalances) && Array.isArray(meta.postBalances)
    && meta.preBalances.length === keys.length && meta.postBalances.length === keys.length,
  'MISSING_NATIVE_BALANCE_METADATA');
  const pre = meta.preBalances[walletIndex];
  const post = meta.postBalances[walletIndex];
  requireThat(Number.isSafeInteger(pre) && pre >= 0 && Number.isSafeInteger(post) && post >= 0,
    'UNSAFE_NATIVE_BALANCE');

  function owned(rows) {
    requireThat(Array.isArray(rows), 'MISSING_TOKEN_BALANCE_METADATA');
    const indexes = new Set();
    const balances = new Map();
    for (const row of rows) {
      requireThat(row && Number.isInteger(row.accountIndex) && row.accountIndex >= 0
        && row.accountIndex < keys.length && !indexes.has(row.accountIndex), 'INVALID_TOKEN_ACCOUNT_INDEX');
      indexes.add(row.accountIndex);
      requireThat(typeof row.owner === 'string' && typeof row.mint === 'string', 'MISSING_TOKEN_OWNER_OR_MINT');
      try { decodePublicKey(row.owner); decodePublicKey(row.mint); }
      catch { throw new VerificationError('INVALID_TOKEN_OWNER_OR_MINT'); }
      const amount = row.uiTokenAmount;
      requireThat(amount && rawAmount(amount.amount) && Number.isInteger(amount.decimals)
        && amount.decimals >= 0 && amount.decimals <= 255, 'INVALID_RAW_TOKEN_BALANCE');
      if (row.mint === WSOL) requireThat(amount.decimals === 9, 'INCORRECT_WSOL_DECIMALS');
      if (row.mint === USDC) requireThat(amount.decimals === 6, 'INCORRECT_USDC_DECIMALS');
      if (row.owner === wallet) balances.set(`${row.accountIndex}:${row.mint}`, {
        accountIndex: row.accountIndex, account: keys[row.accountIndex], mint: row.mint,
        amount: BigInt(amount.amount), decimals: amount.decimals,
      });
    }
    return balances;
  }
  const before = owned(meta.preTokenBalances);
  const after = owned(meta.postTokenBalances);
  const tokens = [];
  const rows = [];
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const a = before.get(key);
    const b = after.get(key);
    const selected = b ?? a;
    requireThat(!a || !b || a.decimals === b.decimals, 'TOKEN_DECIMALS_CHANGED');
    const token = { mint: selected.mint, pre: a?.amount ?? 0n, post: b?.amount ?? 0n,
      decimals: selected.decimals };
    tokens.push(token);
    rows.push({ account: selected.account, accountIndex: selected.accountIndex, mint: token.mint,
      decimals: token.decimals, preRaw: token.pre.toString(), postRaw: token.post.toString(),
      deltaRaw: (token.post - token.pre).toString() });
  }
  const lamports = { pre: BigInt(pre), post: BigInt(post) };
  const assets = assetChanges({ lamports, tokens });
  const nativeDelta = lamports.post - lamports.pre;
  const wsolDelta = tokens.filter((t) => t.mint === WSOL).reduce((sum, t) => sum + t.post - t.pre, 0n);
  const solDelta = assets.find((a) => a.asset === 'SOL').net;
  const usdcDelta = assets.find((a) => a.asset === USDC)?.net ?? 0n;
  return { decoded, nativeDelta, wsolDelta, solDelta, usdcDelta, assets,
    public: { nativePreLamports: pre.toString(), nativePostLamports: post.toString(),
      nativeDeltaLamports: nativeDelta.toString(), ownerWsolDeltaRaw: wsolDelta.toString(),
      totalSolAssetDeltaLamports: solDelta.toString(), totalSolAssetDeltaSol: formatUnits(solDelta, 9),
      usdcDeltaRaw: usdcDelta.toString(), usdcDeltaUsdc: formatUnits(usdcDelta, 6), tokenAccounts: rows } };
}

/** One read-only pass. Injected RPC makes this function fully hermetic in tests. */
export async function verifyCandidate({ signature, auditText, rpc, wallet = WALLET, approver = APPROVER }) {
  checkSignature(signature);
  const summary = { signature, wallet, approver, network: 'mainnet-beta', commitment: 'finalized',
    explorerUrl: `https://explorer.solana.com/tx/${signature}`, automaticRetries: 0,
    simulationRequests: 0, executionRequests: 0 };
  try {
    requireThat(typeof rpc?.call === 'function', 'MISSING_READ_ONLY_RPC');
    const chain = verifyChainText(auditText.replace(/\r\n/g, '\n'));
    requireThat(chain.ok, 'AUDIT_CHAIN_FAILED');
    const records = auditText.replace(/\r\n/g, '\n').trimEnd().split('\n').filter(Boolean).map(JSON.parse);
    const group = one(collectSentTransactions(records), 'AUDIT_MUST_HAVE_EXACTLY_ONE_TRANSACTION');
    requireThat(group.signature === signature && group.link === 'ok' && group.approved.length === 1,
      'CANDIDATE_APPROVAL_LINK_FAILED');
    const hash = group.approved[0];
    requireThat(SHA256.test(hash), 'INVALID_APPROVED_MESSAGE_HASH');
    const attempt = one(records.filter((r) => r.type === 'execute_attempt'), 'AUDIT_MUST_HAVE_ONE_EXECUTE_ATTEMPT');
    requireThat(attempt.signature === signature && attempt.messageSha256 === hash
      && typeof attempt.requestId === 'string' && group.callIds.includes(attempt.callId), 'EXECUTE_ATTEMPT_LINK_FAILED');
    const quote = one(records.filter((r) => r.type === 'public_order_review'
      && r.requestId === attempt.requestId && r.messageSha256 === hash && r.seq < attempt.seq), 'ORDER_MINIMUM_LINK_FAILED');
    requireThat(quote.inAmount === '1000000' && rawAmount(quote.otherAmountThreshold)
      && BigInt(quote.otherAmountThreshold) > 0n && quote.review?.messageSha256 === hash
      && quote.review?.verdict === 'hold' && quote.review?.sim?.ok === true
      && quote.review?.sim?.err === null && quote.review?.violations?.length === 0, 'ORDER_REVIEW_FAILED');
    const approved = one(records.filter((r) => r.type === 'hold_approved'
      && r.callId === attempt.callId && r.messageSha256 === hash && r.seq < attempt.seq), 'APPROVER_LINK_FAILED');
    requireThat(approved.publicKey === approver && approved.method === 'wallet-signature', 'WRONG_GATE_APPROVER');
    const created = one(records.filter((r) => r.type === 'hold_created' && r.holdId === approved.holdId
      && r.callId === attempt.callId && r.messageSha256 === hash && r.seq < approved.seq), 'HOLD_CREATION_LINK_FAILED');
    const expectedMessage = buildApprovalMessage({ id: created.holdId, cluster: created.cluster,
      messageSha256: hash, summaryLine: created.summaryLine, expiresAt: created.expiresAt });
    requireThat(created.cluster === 'mainnet-beta' && created.approvalMessage === expectedMessage,
      'APPROVAL_MESSAGE_MISMATCH');
    requireThat(verifyApproval({ message: expectedMessage, publicKey: approved.publicKey,
      signature: decode(approved.signature), approver }), 'INVALID_APPROVER_SIGNATURE');
    requireThat(await rpc.call('getGenesisHash') === MAINNET_GENESIS, 'WRONG_RPC_NETWORK');
    const status = (await rpc.call('getSignatureStatuses', [[signature], { searchTransactionHistory: true }]))?.value?.[0];
    if (!status || status.confirmationStatus !== 'finalized') return { ...summary,
      status: 'NOT_FINALIZED', reason: 'FINALIZED_STATUS_NOT_AVAILABLE',
      observedConfirmationStatus: typeof status?.confirmationStatus === 'string' ? status.confirmationStatus : null };
    requireThat(Object.hasOwn(status, 'err') && status.err === null, 'FINALIZED_TRANSACTION_FAILED');
    const tx = await rpc.call('getTransaction', [signature,
      { encoding: 'base64', maxSupportedTransactionVersion: 0, commitment: 'finalized' }]);
    if (!tx) return { ...summary, status: 'NOT_FINALIZED', reason: 'FINALIZED_TRANSACTION_NOT_AVAILABLE' };
    const balances = ledgerBalances(tx, { wallet });
    requireThat(encode(balances.decoded.signatures[0]) === signature, 'LEDGER_SIGNATURE_MISMATCH');
    requireThat(messageSha256(balances.decoded) === hash, 'APPROVED_MESSAGE_MISMATCH');
    requireThat(status.slot === tx.slot, 'FINALIZED_SLOT_MISMATCH');
    const audit = await verifyAuditLog({ text: auditText, commitment: 'finalized', rpc: { async call(method, params) {
      requireThat(method === 'getTransaction' && params[0] === signature && params[1]?.encoding === 'base64'
        && params[1]?.commitment === 'finalized' && params[1]?.maxSupportedTransactionVersion === 0,
      'UNEXPECTED_AUDIT_RPC_REQUEST');
      return tx;
    } } });
    const transactions = audit.results.filter((r) => r.signature !== undefined);
    requireThat(audit.chain.ok && audit.counts.failed === 0 && audit.counts.unverified === 0
      && transactions.length === 1 && transactions[0].signature === signature
      && transactions[0].status === 'PASS' && transactions[0].approvedMessageSha256?.includes(hash)
      && transactions[0].observedMessageSha256 === hash, 'STRICT_AUDIT_VERIFICATION_FAILED');
    requireThat(balances.usdcDelta >= BigInt(quote.otherAmountThreshold), 'ACTUAL_USDC_BELOW_APPROVED_MINIMUM');
    const solOutflow = balances.solDelta < 0n ? -balances.solDelta : 0n;
    requireThat(solOutflow <= 3000000n, 'ACTUAL_SOL_OUTFLOW_EXCEEDS_CAP');
    requireThat(!balances.assets.some((a) => a.asset !== 'SOL' && a.asset !== USDC && a.net < 0n),
      'UNEXPECTED_ACTUAL_TOKEN_OUTFLOW');
    return { ...summary, status: 'VERIFIED', finalized: true, slot: tx.slot,
      blockTime: Number.isSafeInteger(tx.blockTime) ? new Date(tx.blockTime * 1000).toISOString() : null,
      messageSha256: hash, minimumUsdcRaw: quote.otherAmountThreshold,
      minimumUsdc: formatUnits(BigInt(quote.otherAmountThreshold), 6),
      solOutflowLamports: solOutflow.toString(), solOutflowSol: formatUnits(solOutflow, 9),
      solOutflowCapLamports: '3000000', feeLamports: Number.isSafeInteger(tx.meta.fee) ? tx.meta.fee.toString() : null,
      balances: balances.public, audit: { verdict: audit.verdict, chain: audit.chain, counts: audit.counts,
        candidate: { status: transactions[0].status, lines: transactions[0].lines,
          callIds: transactions[0].callIds, approvedMessageSha256: transactions[0].approvedMessageSha256,
          observedMessageSha256: transactions[0].observedMessageSha256 },
        executeAttemptLine: attempt.seq, orderReviewLine: quote.seq, approvedLine: approved.seq },
      checks: { mainnetGenesis: true, finalizedStatus: true, ledgerSignatures: true,
        exactApprovedMessage: true, approverSignature: true, minimumUsdc: true,
        nativeAndWrappedSolCap: true, strictAudit: true } };
  } catch (error) {
    return { ...summary, status: 'FAILED', reason: error instanceof VerificationError ? error.code : 'VERIFICATION_UNAVAILABLE' };
  }
}

function savedRpc() {
  let endpoint;
  try { endpoint = (process.env.SFGATE_UPSTREAM_RPC_URL
    ?? readFileSync(path.join(homedir(), '.sfgate/mainnet-rpc.url'), 'utf8')).trim(); }
  catch { throw new VerificationError('RPC_FILE_UNREADABLE'); }
  let url;
  try { url = new URL(endpoint); } catch { throw new VerificationError('INVALID_SAVED_RPC_URL'); }
  requireThat(url.protocol === 'https:' && url.hostname === 'mainnet.helius-rpc.com'
    && !url.username && !url.password && !url.hash && !/\s/.test(endpoint)
    && url.searchParams.get('api-key')?.trim(), 'INVALID_SAVED_HELIUS_MAINNET_RPC');
  let id = 0;
  return { async call(method, params = []) {
    requireThat(['getGenesisHash', 'getSignatureStatuses', 'getTransaction'].includes(method), 'RPC_WRITE_FORBIDDEN');
    try {
      const requestId = ++id;
      const response = await fetch(endpoint, { method: 'POST', redirect: 'error',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }),
        signal: AbortSignal.timeout(25000) });
      requireThat(response.ok, 'RPC_HTTP_FAILED');
      const body = await response.json();
      requireThat(body && body.jsonrpc === '2.0' && body.id === requestId && !body.error
        && Object.hasOwn(body, 'result'), 'RPC_RESPONSE_FAILED');
      return body.result;
    } catch (error) {
      throw new VerificationError(error instanceof VerificationError ? error.code : 'RPC_REQUEST_FAILED');
    }
  } };
}

async function main() {
  let result;
  const signature = process.argv[2];
  try {
    requireThat(process.argv.length === 3, 'USAGE_PUBLIC_SIGNATURE_REQUIRED');
    checkSignature(signature);
    const auditText = readFileSync(AUDIT_PATH, 'utf8');
    result = await verifyCandidate({ signature, auditText, rpc: savedRpc() });
  } catch (error) {
    result = { status: 'FAILED', reason: error instanceof VerificationError ? error.code : 'LOCAL_VERIFICATION_UNAVAILABLE',
      automaticRetries: 0, simulationRequests: 0, executionRequests: 0 };
  }
  result.checkedAt = new Date().toISOString();
  mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== 'VERIFIED') process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('Verification output unavailable; no transaction was submitted or retried.'); process.exitCode = 1; });
}
