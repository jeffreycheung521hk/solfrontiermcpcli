// Local prototype: the only signer is the user's Phantom wallet. This module
// accepts injected read-only RPC and Jupiter transports; it has no key or I/O path.
import { createHash, randomBytes } from 'node:crypto';
import { compileToolPolicy } from '../../../src/gate/tool-policy.mjs';
import { compileTxPolicy } from '../../../src/gate/tx-policy.mjs';
import { createPipeline } from '../../../src/gate/pipeline.mjs';
import { reviewTransaction } from '../../../src/gate/review.mjs';
import { decodeTransaction, messageSha256, verifySignatures } from '../../../src/solana/tx.mjs';
import { encode, decodePublicKey } from '../../../src/solana/base58.mjs';

export const WALLET = 'J3rFAMrr2GDNhDg2x3Cn2K9iNKyrGh4WcqbmNG9xKaRj';
export const APPROVER = '6N7UYBzKmdHYtUssw45QDbGd1No2xUVTFkkVwnovTd3M';
export const SOL = 'So11111111111111111111111111111111111111112';
export const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';

const TOOL = 'jup__execute-ultra-order';
const READ_METHODS = new Set(['getGenesisHash', 'isBlockhashValid', 'getMultipleAccounts',
  'getTokenAccountsByOwner', 'simulateTransaction']);
const ZERO = (bytes) => bytes.every((value) => value === 0);
const copy = (value) => JSON.parse(JSON.stringify(value));
const requireThat = (condition, code) => { if (!condition) throw new Error(code); };
// Diagnostics are local codes only. Never expose arbitrary exception messages
// from an injected RPC, transport or audit writer.
const EXECUTION_REFUSAL_CODES = new Set([
  'unexpected_execution_args', 'request_cancelled', 'order_expired',
  'execution_already_attempted', 'invalid_transaction_encoding', 'invalid_transaction',
  'wallet_not_required_signer', 'invalid_transaction_signatures', 'transaction_message_changed',
  'missing_cosigner_signature', 'invalid_original_signature', 'original_signature_changed',
  'execution_message_mismatch', 'human_approval_required', 'transaction_review_refused',
  'review_message_mismatch', 'minimum_usdc_not_received', 'sol_outflow_exceeds_bound',
  'unexpected_asset_outflow', 'invalid_review_amount', 'invalid_review_decimals',
  'blockhash_expired', 'approval_window_expired', 'rpc_unavailable', 'rpc_write_forbidden',
]);

function transaction(text) {
  requireThat(typeof text === 'string' && text.length > 0 && text.length <= 4096
    && /^[A-Za-z0-9+/]+={0,2}$/.test(text), 'invalid_transaction_encoding');
  const bytes = Buffer.from(text, 'base64');
  requireThat(bytes.toString('base64') === text && bytes.length <= 1232, 'invalid_transaction_encoding');
  try { return { bytes, decoded: decodeTransaction(bytes) }; } catch { throw new Error('invalid_transaction'); }
}

// Simulation does not need any valid signature. Sending a fully signed wire
// transaction to an RPC before Gate approval would disclose a payload that
// the RPC could broadcast. Zero every signature without changing the message.
function unsignedSimulationTransaction(text) {
  const { bytes, decoded } = transaction(text);
  const messageStart = bytes.length - decoded.messageBytes.length;
  const signatureStart = messageStart - decoded.signatures.length * 64;
  const unsigned = Buffer.from(bytes);
  unsigned.fill(0, signatureStart, messageStart);
  const checked = decodeTransaction(unsigned);
  requireThat(checked.signatures.every(ZERO)
    && Buffer.from(checked.messageBytes).equals(Buffer.from(decoded.messageBytes)), 'simulation_message_changed');
  return unsigned.toString('base64');
}

/** Verify Phantom only added valid signatures to the exact original message. */
export function validateSignedTransaction(originalBase64, signedBase64, wallet = WALLET) {
  decodePublicKey(wallet);
  const original = transaction(originalBase64).decoded;
  const signed = transaction(signedBase64).decoded;
  requireThat(Buffer.from(original.messageBytes).equals(Buffer.from(signed.messageBytes)), 'transaction_message_changed');
  requireThat(original.staticAccountKeys.slice(0, original.header.numRequiredSignatures).includes(wallet), 'wallet_not_required_signer');
  requireThat(verifySignatures(signed).complete, 'invalid_transaction_signatures');
  const existing = verifySignatures(original).valid;
  original.signatures.forEach((signature, index) => {
    if (ZERO(signature)) {
      requireThat(original.staticAccountKeys[index] === wallet, 'missing_cosigner_signature');
      return;
    }
    requireThat(existing[index], 'invalid_original_signature');
    requireThat(Buffer.from(signature).equals(Buffer.from(signed.signatures[index])), 'original_signature_changed');
  });
  return { signature: encode(signed.signatures[0]), messageSha256: messageSha256(signed) };
}

function rawUnits(value, decimals) {
  requireThat(typeof value === 'string' && /^(0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value), 'invalid_review_amount');
  const [whole, fraction = ''] = value.split('.');
  requireThat(fraction.length <= decimals, 'invalid_review_decimals');
  return BigInt(whole) * (10n ** BigInt(decimals)) + BigInt(fraction.padEnd(decimals, '0') || '0');
}

function checkReview(review, order) {
  requireThat(review?.verdict === 'hold' && review.sim?.ok === true
    && review.sim.err === null && review.violations?.length === 0, 'transaction_review_refused');
  requireThat(review.messageSha256 === order.messageSha256, 'review_message_mismatch');
  requireThat(rawUnits(review.inflow?.[USDC] ?? '0', 6) >= BigInt(order.otherAmountThreshold), 'minimum_usdc_not_received');
  requireThat(rawUnits(review.outflow?.SOL ?? '0', 9) <= 3000000n, 'sol_outflow_exceeds_bound');
  for (const [asset, amount] of Object.entries(review.outflow ?? {})) {
    if (asset !== 'SOL') requireThat(rawUnits(amount, asset === USDC ? 6 : 18) === 0n, 'unexpected_asset_outflow');
  }
}

function mcpResult(body, isError = false) {
  return { content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: body, isError };
}

function unsignedOrder(raw, wallet, now, orderLifetimeMs, executionReserveMs, maxPaymentAgeMs, signStartLimitMs) {
  requireThat(raw && typeof raw === 'object' && !Array.isArray(raw), 'invalid_order');
  requireThat(!raw.error && !raw.errorMessage && !raw.errorCode, 'order_unavailable');
  requireThat(raw.inputMint === SOL && raw.outputMint === USDC && raw.inAmount === '1000000'
    && raw.taker === wallet && raw.swapMode === 'ExactIn', 'unexpected_order');
  for (const key of ['outAmount', 'otherAmountThreshold']) {
    requireThat(typeof raw[key] === 'string' && /^[1-9][0-9]*$/.test(raw[key]) && raw[key].length <= 30, 'invalid_order_amount');
  }
  requireThat(BigInt(raw.otherAmountThreshold) <= BigInt(raw.outAmount), 'invalid_order_threshold');
  requireThat(Number.isInteger(raw.slippageBps) && raw.slippageBps >= 0 && raw.slippageBps <= 100,
    'invalid_order_slippage');
  requireThat(BigInt(raw.otherAmountThreshold) * 100n >= BigInt(raw.outAmount) * 99n,
    'order_threshold_too_low');
  requireThat(typeof raw.requestId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(raw.requestId), 'invalid_request_id');
  const original = transaction(raw.transaction).decoded;
  const signerIndex = original.staticAccountKeys.slice(0, original.header.numRequiredSignatures).indexOf(wallet);
  requireThat(signerIndex >= 0 && ZERO(original.signatures[signerIndex]), 'wallet_signature_required');
  const valid = verifySignatures(original).valid;
  original.signatures.forEach((signature, index) => {
    requireThat(ZERO(signature) || valid[index], 'invalid_original_signature');
    requireThat(index === signerIndex || !ZERO(signature), 'missing_cosigner_signature');
  });
  let expiresAt = now + orderLifetimeMs;
  if (raw.expireAt !== undefined && raw.expireAt !== null) {
    requireThat(typeof raw.expireAt === 'string' && Number.isFinite(Date.parse(raw.expireAt)), 'invalid_order_expiry');
    expiresAt = Math.min(expiresAt, Date.parse(raw.expireAt));
  }
  requireThat(expiresAt > now, 'order_expired');
  const approvalDeadlineMs = expiresAt - executionReserveMs;
  return { id: randomBytes(16).toString('hex'), inputMint: SOL, outputMint: USDC,
    inAmount: '1000000', outAmount: raw.outAmount, otherAmountThreshold: raw.otherAmountThreshold,
    requestId: raw.requestId, transaction: raw.transaction, messageSha256: messageSha256(original),
    recentBlockhash: original.recentBlockhash, expiresAt: new Date(expiresAt).toISOString(), expiresAtMs: expiresAt,
    approvalDeadlineMs, approvalDeadline: new Date(approvalDeadlineMs).toISOString(), executionReserveMs,
    signingDeadline: new Date(Math.min(now + signStartLimitMs, approvalDeadlineMs)).toISOString(),
    paymentSubmissionDeadline: new Date(Math.min(now + maxPaymentAgeMs, approvalDeadlineMs)).toISOString(),
    approvalWindowExpiredAtMs: null,
    receivedAt: new Date(now).toISOString(), receivedAtMs: now,
    blockhash: { checkedAtMs: null, contextSlot: null, expiredAtMs: null } };
}

const isoOrNull = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

/** Create a paused, one-submission keyless Gate prototype. No I/O occurs until explicit methods are called. */
export function createKeylessRuntime({ config, rpc, transport, audit, holds, approvalUrl,
  now = Date.now, wallet = WALLET, approver = APPROVER, blockhashPollMs = 0,
  orderLifetimeMs = 20000, executionReserveMs = 2000, maxPaymentAgeMs = 12000,
  signStartLimitMs = 9000, setTimer = setTimeout, clearTimer = clearTimeout }) {
  decodePublicKey(wallet);
  decodePublicKey(approver);
  requireThat(Number.isInteger(blockhashPollMs) && blockhashPollMs >= 0 && blockhashPollMs <= 10000,
    'invalid_blockhash_poll_interval');
  requireThat(Number.isInteger(orderLifetimeMs) && orderLifetimeMs > 0 && orderLifetimeMs <= 90000,
    'invalid_order_lifetime');
  requireThat(Number.isInteger(executionReserveMs) && executionReserveMs >= 0 && executionReserveMs < orderLifetimeMs,
    'invalid_execution_reserve');
  requireThat(Number.isInteger(maxPaymentAgeMs) && maxPaymentAgeMs > 0 && maxPaymentAgeMs <= 90000,
    'invalid_payment_age_limit');
  requireThat(Number.isInteger(signStartLimitMs) && signStartLimitMs > 0 && signStartLimitMs <= maxPaymentAgeMs,
    'invalid_signing_start_limit');
  requireThat(typeof setTimer === 'function' && typeof clearTimer === 'function', 'invalid_deadline_timer');
  requireThat(config?.cluster === 'mainnet-beta' && config.approver === approver, 'invalid_gate_configuration');
  requireThat(typeof rpc?.call === 'function' && typeof transport?.order === 'function'
    && typeof transport?.execute === 'function' && typeof audit?.append === 'function', 'missing_runtime_dependency');
  requireThat(holds?.approver === approver && typeof holds.cancelWhere === 'function'
    && typeof holds.nowMs === 'function', 'invalid_approver_queue');
  requireThat(typeof approvalUrl === 'string' && /^http:\/\/127\.0\.0\.1:[0-9]+$/.test(approvalUrl), 'invalid_approval_url');
  requireThat(!Object.values(config.servers ?? {}).some((server) => server.walletVar), 'wallet_injection_forbidden');
  const policy = compileToolPolicy(config);
  const txPolicy = compileTxPolicy(config.tx, config.lists);
  requireThat(txPolicy.approval === 'always', 'human_approval_required');
  requireThat(config.tools?.['jup.execute-ultra-order']?.txArg === 'transaction'
    && config.tools['jup.execute-ultra-order'].txArgEncoding === 'base64', 'transaction_checkpoint_required');

  let paused = true;
  let closed = false;
  let phase = 'paused';
  let currentOrder = null;
  let result = null;
  let epoch = 0;
  let busy = false;
  let submitted = false;
  let attempted = false;
  let controller = null;
  let currentCallId = null;
  let finalReview = null;
  let approved = null;
  let activeSubmit = null;
  let activeQuote = null;
  let signedPayload = null;

  const readRpc = { async call(method, params = []) {
    requireThat(READ_METHODS.has(method), 'rpc_write_forbidden');
    requireThat(!closed && !paused && !controller?.signal.aborted, 'request_cancelled');
    if (method === 'simulateTransaction') {
      requireThat(Array.isArray(params) && params.length === 2 && params[1]
        && typeof params[1] === 'object' && !Array.isArray(params[1])
        && params[1].encoding === 'base64' && params[1].sigVerify === false,
      'unsigned_simulation_required');
      params = [unsignedSimulationTransaction(params[0]), { ...params[1] }];
    }
    let answer;
    try { answer = await rpc.call(method, params); } catch { throw new Error('rpc_unavailable'); }
    // An injected transport may be uncancellable, but its completion can never
    // permit the next RPC or effect after the user paused or cancelled.
    requireThat(!closed && !paused && !controller?.signal.aborted, 'request_cancelled');
    return answer;
  } };

  // A signed transaction is broadcast-capable. Never let the Gate argument
  // logger retain it, even a tiny synthetic transaction below its normal cutoff.
  const checkedAudit = { append(type, payload = {}) {
    let safe = payload;
    if (type === 'tool_call' && payload.args?.transaction !== undefined) {
      const encoded = payload.args.transaction;
      safe = { ...payload, args: { ...payload.args, transaction: typeof encoded === 'string'
        ? { sha256: createHash('sha256').update(encoded).digest('hex'), length: encoded.length } : encoded } };
    }
    if (signedPayload) {
      safe = JSON.parse(JSON.stringify(safe).split(signedPayload).join('<signed-transaction-redacted>'));
    }
    const record = audit.append(type, safe);
    if (type === 'tool_call' && payload.tool === TOOL && payload.decision !== 'deny') currentCallId = payload.callId;
    if (type === 'tx_review' && payload.callId === currentCallId) finalReview = copy(payload);
    if (type === 'hold_approved' && payload.callId === currentCallId) approved = copy(payload);
    // The watchdog can see the hash die while Gate is still reviewing the
    // signed bytes; a hold opened after that moment is cancelled at birth.
    if (type === 'hold_created' && payload.callId === currentCallId && currentOrder) {
      if (currentOrder.blockhash.expiredAtMs !== null) {
        holds.cancelWhere((hold) => hold.id === payload.holdId, 'blockhash expired');
      } else if (currentOrder.approvalWindowExpiredAtMs !== null || now() >= currentOrder.approvalDeadlineMs) {
        expireWindow(currentOrder);
        holds.cancelWhere((hold) => hold.id === payload.holdId, 'approval window expired');
      }
    }
    return record;
  } };

  const available = () => requireThat(!closed && !paused, closed ? 'runtime_closed' : 'simulation_paused');
  const fresh = (order) => {
    requireThat(order?.blockhash.expiredAtMs === null, 'blockhash_expired');
    requireThat(order && now() < order.expiresAtMs, 'order_expired');
  };
  const approvalWindow = (order) => {
    fresh(order);
    if (order.approvalWindowExpiredAtMs !== null || now() >= order.approvalDeadlineMs) {
      expireWindow(order);
      throw new Error('approval_window_expired');
    }
  };
  const executionReserve = (order) => {
    fresh(order);
    requireThat(order.approvalWindowExpiredAtMs === null
      && order.expiresAtMs - now() >= order.executionReserveMs, 'approval_window_expired');
  };
  const notCancelled = (signal) => requireThat(!closed && !paused && !signal?.aborted, 'request_cancelled');
  // One read of the order's blockhash. The answer stays on the order, so a
  // refusal can say when and at which slot the chain last answered.
  async function readBlockhash(order) {
    const answer = await readRpc.call('isBlockhashValid', [order.recentBlockhash, { commitment: 'confirmed' }]);
    const contextSlot = Number.isSafeInteger(answer?.context?.slot) ? answer.context.slot : null;
    order.blockhash.checkedAtMs = now();
    order.blockhash.contextSlot = contextSlot;
    return { value: answer?.value, contextSlot };
  }
  async function blockhashValid(order) {
    const { value, contextSlot } = await readBlockhash(order);
    requireThat(value === true, 'blockhash_expired');
    return contextSlot;
  }

  // The local operation cutoff is independent of RPC progress. It reserves
  // submission time from the same receipt-based window used by both signers.
  let deadlineTimer = null;
  let deadlineGeneration = 0;
  function stopDeadlineTimer() {
    deadlineGeneration += 1;
    if (deadlineTimer !== null) clearTimer(deadlineTimer);
    deadlineTimer = null;
  }
  function expireWindow(order) {
    if (order.approvalWindowExpiredAtMs !== null || attempted) return;
    order.approvalWindowExpiredAtMs = now();
    if (order === currentOrder) stopWatchdog();
    try {
      checkedAudit.append('order_window_expired', { callId: order === currentOrder ? currentCallId : null,
        requestId: order.requestId, messageSha256: order.messageSha256,
        receivedAt: order.receivedAt, expiresAt: order.expiresAt,
        approvalDeadline: order.approvalDeadline, executionReserveMs: order.executionReserveMs,
        msSinceOrder: now() - order.receivedAtMs, phase,
        code: 'approval_window_expired' });
    } catch { /* Refusing remains safe even if the local audit writer fails. */ }
    if (order === currentOrder && currentCallId) {
      holds.cancelWhere((hold) => hold.parentIds.includes(currentCallId), 'approval window expired');
    }
  }
  function startDeadlineTimer(order) {
    stopDeadlineTimer();
    const generation = deadlineGeneration;
    const callback = () => {
      if (closed || generation !== deadlineGeneration || currentOrder !== order || attempted) return;
      deadlineTimer = null;
      const remaining = order.approvalDeadlineMs - now();
      if (remaining > 0) deadlineTimer = setTimer(callback, remaining);
      else expireWindow(order);
    };
    const remaining = order.approvalDeadlineMs - now();
    if (remaining <= 0) callback();
    else deadlineTimer = setTimer(callback, remaining);
  }

  // Chain monitoring only refuses earlier. It does not extend the local
  // deadline, replace a message, refresh a quote, or retry a submission.
  let watchdog = null;
  let watchdogGeneration = 0;
  const stopWatchdog = () => {
    watchdogGeneration += 1;
    if (watchdog) clearInterval(watchdog);
    watchdog = null;
  };
  function expireOrder(order) {
    if (order.blockhash.expiredAtMs !== null) return;
    order.blockhash.expiredAtMs = now();
    stopWatchdog();
    stopDeadlineTimer();
    try {
      checkedAudit.append('order_blockhash_expired', { callId: currentCallId, requestId: order.requestId,
        messageSha256: order.messageSha256, recentBlockhash: order.recentBlockhash,
        contextSlot: order.blockhash.contextSlot, receivedAt: order.receivedAt,
        msSinceOrder: order.blockhash.expiredAtMs - order.receivedAtMs, phase });
    } catch { /* Cancelling is a refusal and is safe unlogged; Gate logs hold_cancelled itself. */ }
    if (currentCallId) holds.cancelWhere((hold) => hold.parentIds.includes(currentCallId), 'blockhash expired');
  }
  function startWatchdog(order) {
    stopWatchdog();
    if (!blockhashPollMs) return;
    const generation = watchdogGeneration;
    let inFlight = false;
    // Not unref()'d: it ends itself once the order is decided, replaced or past
    // its local deadline, and pause()/close() stop it.
    const live = () => generation === watchdogGeneration && order === currentOrder && order.blockhash.expiredAtMs === null
      && order.approvalWindowExpiredAtMs === null && !approved && !attempted
      && now() < order.approvalDeadlineMs;
    watchdog = setInterval(async () => {
      if (!live()) {
        if (generation === watchdogGeneration) stopWatchdog();
        return;
      }
      if (inFlight) return;
      inFlight = true;
      try {
        const { value } = await readBlockhash(order);
        // Only an explicit "false" from the chain expires the order; anything
        // else (malformed, RPC trouble, pause) leaves it to the final check.
        if (value === false && live()) expireOrder(order);
      } catch { /* transient RPC trouble or pause */ }
      finally { inFlight = false; }
    }, blockhashPollMs);
  }

  const facade = {
    ready: Promise.resolve(),
    list: () => [{ name: TOOL, server: 'jup', tool: 'execute-ultra-order' }],
    async call(server, tool, args, { signal } = {}) {
      let stage = 'arguments';
      let finalBlockhash = null;
      try {
        requireThat(server === 'jup' && tool === 'execute-ultra-order'
          && Object.keys(args).sort().join(',') === 'requestId,transaction', 'unexpected_execution_args');
        stage = 'availability';
        notCancelled(signal);
        stage = 'order_freshness';
        approvalWindow(currentOrder);
        stage = 'execution_uniqueness';
        requireThat(!attempted && args.requestId === currentOrder.requestId, 'execution_already_attempted');
        stage = 'transaction_signature';
        const candidate = validateSignedTransaction(currentOrder.transaction, args.transaction, wallet);
        stage = 'message_binding';
        requireThat(candidate.messageSha256 === currentOrder.messageSha256, 'execution_message_mismatch');
        stage = 'human_approval';
        requireThat(approved?.callId === currentCallId && approved.messageSha256 === candidate.messageSha256
          && approved.publicKey === approver && approved.method === 'wallet-signature', 'human_approval_required');
        stage = 'final_review';
        checkReview(finalReview, currentOrder);
        stage = 'blockhash_freshness';
        finalBlockhash = await readBlockhash(currentOrder);
        requireThat(finalBlockhash.value === true, 'blockhash_expired');
        stage = 'final_availability';
        notCancelled(signal);
        stage = 'final_order_freshness';
        executionReserve(currentOrder);
        // There is no await between the durable intent, one-use flag and POST.
        stage = 'audit_intent';
        checkedAudit.append('execute_attempt', { callId: currentCallId, requestId: currentOrder.requestId,
          signature: candidate.signature, messageSha256: candidate.messageSha256 });
        stage = 'post_intent_availability';
        notCancelled(signal);
        stage = 'post_intent_execution_reserve';
        executionReserve(currentOrder);
        attempted = true;
        stage = 'submit';
        phase = 'submitting';
        let response;
        try {
          response = await transport.execute({ signedTransaction: args.transaction, requestId: currentOrder.requestId });
        } catch {
          phase = 'outcome-unknown';
          return mcpResult({ status: 'outcome-unknown', signature: candidate.signature,
            error: 'execution_response_unavailable_reconcile_before_retry' }, true);
        }
        if (response?.status !== 'Success' || response.signature !== candidate.signature) {
          phase = 'outcome-unknown';
          return mcpResult({ status: 'outcome-unknown', signature: candidate.signature,
            error: 'execution_response_mismatch_reconcile_before_retry' }, true);
        }
        phase = 'submitted';
        return mcpResult({ status: 'submitted', signature: candidate.signature,
          explorerUrl: `https://explorer.solana.com/tx/${candidate.signature}` });
      } catch (error) {
        if (attempted) {
          phase = 'outcome-unknown';
          const candidate = validateSignedTransaction(currentOrder.transaction, args.transaction, wallet);
          return mcpResult({ status: 'outcome-unknown', signature: candidate.signature,
            error: 'execution_reconciliation_required' }, true);
        }
        const code = EXECUTION_REFUSAL_CODES.has(error?.message)
          ? error.message : 'execution_precondition_failed';
        // Timing and the chain's answer are public facts; with them the next
        // refusal names its guard and shows how late it came (2026-10-11 gap).
        checkedAudit.append('execution_refused', { callId: currentCallId,
          requestId: currentOrder?.requestId ?? null,
          messageSha256: currentOrder?.messageSha256 ?? null, stage, code,
          msSinceOrder: currentOrder ? now() - currentOrder.receivedAtMs : null,
          ...(finalBlockhash ? { blockhashValid: finalBlockhash.value === true,
            blockhashContextSlot: finalBlockhash.contextSlot } : {}) });
        return mcpResult({ status: 'refused', error: code, stage }, true);
      }
    },
  };
  // HoldQueue's timeout is relative to its own clock. Bound methods preserve
  // its private fields; a small padding plus a checked snapshot prevents clock
  // resampling from extending the signed approval message beyond our cutoff.
  const pipelineHolds = new Proxy(holds, { get(target, property) {
    if (property === 'add') return (input) => {
      const order = currentOrder;
      requireThat(order && input.review?.messageSha256 === order.messageSha256, 'review_message_mismatch');
      if (order.approvalWindowExpiredAtMs !== null || now() >= order.approvalDeadlineMs) {
        expireWindow(order);
        throw new Error('approval_window_expired');
      }
      const remaining = order.approvalDeadlineMs - holds.nowMs() - 2;
      if (remaining <= 0) {
        expireWindow(order);
        throw new Error('approval_window_expired');
      }
      const hold = holds.add({ ...input, timeoutSec: Math.min(input.timeoutSec, remaining / 1000) });
      if (Date.parse(hold.expiresAt) > order.approvalDeadlineMs) {
        holds.cancelWhere((candidate) => candidate.id === hold.id, 'approval deadline clock drift');
        expireWindow(order);
        throw new Error('approval_window_expired');
      }
      return hold;
    };
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const pipeline = createPipeline({ config, getDownstreams: () => facade, audit: checkedAudit,
    pettyCash: { publicKey: wallet }, policy, txPolicy, rpc: readRpc, holds: pipelineHolds, approvalUrl,
    log: () => {}, notify: () => {} });

  function state() {
    const publicOrder = currentOrder ? { id: currentOrder.id, inputMint: SOL, outputMint: USDC,
      inAmount: currentOrder.inAmount, outAmount: currentOrder.outAmount,
      otherAmountThreshold: currentOrder.otherAmountThreshold, expiresAt: currentOrder.expiresAt,
      approvalDeadline: currentOrder.approvalDeadline, executionReserveMs: currentOrder.executionReserveMs,
      signingDeadline: currentOrder.signingDeadline,
      paymentSubmissionDeadline: currentOrder.paymentSubmissionDeadline,
      approvalWindowExpiredAt: isoOrNull(currentOrder.approvalWindowExpiredAtMs),
      messageSha256: currentOrder.messageSha256, review: currentOrder.review,
      receivedAt: currentOrder.receivedAt,
      blockhash: { checkedAt: isoOrNull(currentOrder.blockhash.checkedAtMs),
        expiredAt: isoOrNull(currentOrder.blockhash.expiredAtMs) },
      ...(!submitted ? { transaction: currentOrder.transaction } : {}) } : null;
    return copy({ wallet, approver, phase, approvalUrl, paused, order: publicOrder, result,
      canRequote: !closed && !paused && !busy && !submitted && !attempted });
  }
  function resume() {
    requireThat(!closed, 'runtime_closed');
    paused = false;
    if (phase === 'paused') phase = currentOrder && !submitted ? 'awaiting-signature' : 'ready';
    if (currentOrder && !submitted && !attempted) startWatchdog(currentOrder);
    return state();
  }
  function pause() {
    paused = true;
    epoch += 1;
    stopWatchdog();
    controller?.abort();
    holds.cancelWhere(() => true, 'user paused');
    if (!attempted && !submitted) phase = 'paused';
    return state();
  }
  async function performQuote() {
    available();
    requireThat(!busy && !submitted && !attempted, 'submission_restart_required');
    busy = true;
    phase = 'reviewing';
    stopWatchdog();
    stopDeadlineTimer();
    const startedEpoch = epoch;
    try {
      const genesis = await readRpc.call('getGenesisHash');
      requireThat(genesis === MAINNET_GENESIS, 'wrong_rpc_cluster');
      available();
      requireThat(epoch === startedEpoch, 'request_cancelled');
      let raw;
      try { raw = await transport.order({ inputMint: SOL, outputMint: USDC, amount: '1000000', taker: wallet }); }
      catch { throw new Error('order_unavailable'); }
      available();
      requireThat(epoch === startedEpoch, 'request_cancelled');
      const candidate = unsignedOrder(raw, wallet, now(), orderLifetimeMs, executionReserveMs,
        maxPaymentAgeMs, signStartLimitMs);
      checkedAudit.append('order_deadline_chosen', { id: candidate.id, requestId: candidate.requestId,
        messageSha256: candidate.messageSha256, receivedAt: candidate.receivedAt,
        expiresAt: candidate.expiresAt, approvalDeadline: candidate.approvalDeadline,
        executionReserveMs: candidate.executionReserveMs, orderLifetimeMs,
        signingDeadline: candidate.signingDeadline, paymentSubmissionDeadline: candidate.paymentSubmissionDeadline });
      approvalWindow(candidate);
      const quoteSlot = await blockhashValid(candidate);
      const review = await reviewTransaction({ bytes: transaction(candidate.transaction).bytes, signed: false,
        wallet, rpc: readRpc, txPolicy, lists: config.lists, cluster: config.cluster });
      // Keep refusal evidence from this same review; do not rerun simulation
      // merely to explain why a quote failed its policy checks. The blockhash
      // and receipt time are public and let anyone recompute the order's age.
      checkedAudit.append('public_order_review', { id: candidate.id, requestId: candidate.requestId,
        messageSha256: candidate.messageSha256, inAmount: candidate.inAmount,
        otherAmountThreshold: candidate.otherAmountThreshold, review,
        recentBlockhash: candidate.recentBlockhash, receivedAt: candidate.receivedAt,
        blockhashContextSlot: quoteSlot, expiresAt: candidate.expiresAt,
        approvalDeadline: candidate.approvalDeadline, executionReserveMs: candidate.executionReserveMs,
        signingDeadline: candidate.signingDeadline, paymentSubmissionDeadline: candidate.paymentSubmissionDeadline });
      checkReview(review, candidate);
      available();
      requireThat(epoch === startedEpoch, 'request_cancelled');
      approvalWindow(candidate);
      candidate.review = review;
      currentOrder = candidate;
      result = null;
      phase = 'awaiting-signature';
      startDeadlineTimer(candidate);
      startWatchdog(candidate);
      return state().order;
    } catch (error) {
      currentOrder = null;
      phase = closed ? 'closed' : paused ? 'paused' : 'quote-refused';
      throw error;
    } finally { busy = false; }
  }
  function quote() {
    if (busy) return Promise.reject(new Error('submission_restart_required'));
    activeQuote = performQuote();
    return activeQuote;
  }
  async function submit({ id, signedTransaction }, signal) {
    available();
    requireThat(!busy && !submitted && !attempted, 'submission_restart_required');
    requireThat(currentOrder && id === currentOrder.id, 'unexpected_order_id');
    fresh(currentOrder);
    // Check arrival before accepting signed bytes or opening any Gate hold.
    // A late payment cannot spend the remaining time on a doomed approval.
    if (now() > Date.parse(currentOrder.paymentSubmissionDeadline)) {
      checkedAudit.append('payment_signature_rejected', { requestId: currentOrder.requestId,
        messageSha256: currentOrder.messageSha256, code: 'payment_signature_too_late',
        stage: 'payment_signature_age', msSinceOrder: now() - currentOrder.receivedAtMs,
        paymentSubmissionDeadline: currentOrder.paymentSubmissionDeadline });
      throw new Error('payment_signature_too_late');
    }
    approvalWindow(currentOrder);
    validateSignedTransaction(currentOrder.transaction, signedTransaction, wallet);
    requireThat(!signal?.aborted, 'request_cancelled');
    signedPayload = signedTransaction;
    submitted = true;
    busy = true;
    phase = 'gate-approval-pending';
    controller = new AbortController();
    const abort = () => controller?.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const args = Object.freeze({ transaction: signedTransaction, requestId: currentOrder.requestId });
    const order = currentOrder;
    activeSubmit = (async () => {
      try {
        const response = await pipeline.onToolCall({ name: TOOL, args,
          requestId: currentOrder.id, signal: controller.signal });
        const body = response?.structuredContent ?? JSON.parse(response?.content?.[0]?.text ?? '{}');
        result = body.status ? { status: body.status, ...(body.signature ? { signature: body.signature } : {}),
          ...(body.explorerUrl ? { explorerUrl: body.explorerUrl } : {}), ...(body.error ? { error: body.error } : {}),
          ...(body.stage ? { stage: body.stage } : {}) }
          : { status: 'refused', error: body.code ?? 'gate_refused' };
        // A hold the watchdog cancelled reaches us as a generic Gate refusal;
        // name the real reason so the page, audit and person agree.
        if (!attempted && order.blockhash.expiredAtMs !== null && result.status === 'refused'
          && ['approval_rejected', 'approval_unavailable'].includes(result.error)) {
          result = { status: 'refused', error: 'blockhash_expired', stage: 'awaiting_approval' };
        } else if (!attempted && result.status === 'refused'
          && ['approval_rejected', 'approval_unavailable', 'approval_timeout'].includes(result.error)
          && (order.approvalWindowExpiredAtMs !== null || now() >= order.approvalDeadlineMs - 2)) {
          expireWindow(order);
          result = { status: 'refused', error: 'approval_window_expired', stage: 'awaiting_approval' };
        }
        if (!attempted) phase = 'refused';
        return copy(result);
      } catch {
        phase = attempted ? 'outcome-unknown' : 'refused';
        result = { status: phase, error: attempted ? 'execution_reconciliation_required' : 'gate_unavailable' };
        if (attempted) result.signature = validateSignedTransaction(currentOrder.transaction, signedTransaction, wallet).signature;
        return copy(result);
      } finally {
        stopWatchdog();
        stopDeadlineTimer();
        signal?.removeEventListener('abort', abort);
        controller = null;
        busy = false;
      }
    })();
    return activeSubmit;
  }
  async function close() {
    closed = true;
    pause();
    stopDeadlineTimer();
    await pipeline.close();
    await activeSubmit;
    await activeQuote?.catch(() => {});
    currentOrder = null;
    signedPayload = null;
    phase = 'closed';
  }
  return { state, resume, pause, quote, submit, close };
}
