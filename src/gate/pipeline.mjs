// One decision path for host calls and checkpoint sends (SPEC §5.9).
// Register calls before invoking a downstream: it can send an RPC immediately.
// Every effect follows a synchronous audit append, including refusals (I6).
import { createHash, randomBytes } from 'node:crypto';
import { encode, decode } from '../solana/base58.mjs';
import { decodeTransaction } from '../solana/tx.mjs';
import { scrubArgs } from './audit-log.mjs';
import { splitToolName } from './downstreams.mjs';
import { decideTool, refusal } from './tool-policy.mjs';
import { reviewTransaction } from './review.mjs';
import { notifyHold } from './notify.mjs';

const newId = () => randomBytes(6).toString('hex');
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{86,90}$/;
const SIGNATURE_KEYS = new Set(['signature', 'transactionId', 'txid', 'tx']);

function findSignature(value) {
  if (!value || typeof value !== 'object') return null;
  for (const [key, child] of Object.entries(value)) {
    if (SIGNATURE_KEYS.has(key) && typeof child === 'string' && SIGNATURE.test(child)) return child;
    const nested = findSignature(child);
    if (nested) return nested;
  }
  return null;
}

/** Hash the exact result, extracting signatures only from named JSON fields. */
export function summarizeResult(result) {
  let signature = null;
  for (const content of result?.content ?? []) {
    if (typeof content?.text !== 'string') continue;
    try { signature = findSignature(JSON.parse(content.text)); } catch { /* free text is not a signature claim */ }
    if (signature) break;
  }
  signature ??= findSignature(result?.structuredContent);
  return {
    resultSha256: createHash('sha256').update(JSON.stringify(result ?? null)).digest('hex'),
    isError: result?.isError === true,
    ...(signature ? { signature } : {}),
  };
}

// The reviewed bytes must be exactly the bytes a downstream decoder receives.
function transactionBytes(text, encoding) {
  if (typeof text !== 'string' || !text || text.length > 4096) throw new Error('invalid transaction encoding');
  if (encoding === 'base58') return decode(text);
  if (encoding !== 'base64' || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) throw new Error('invalid transaction encoding');
  const bytes = Buffer.from(text, 'base64');
  if (bytes.toString('base64') !== text) throw new Error('invalid transaction encoding');
  return bytes;
}

/**
 * Wire policy, review, holds and cancellation. getDownstreams is lazy because
 * the checkpoint must listen before any downstream is spawned.
 */
export function createPipeline({ config, getDownstreams, audit, pettyCash, policy, txPolicy, rpc,
  holds, approvalUrl = null, log = () => {}, redact = (text) => text, notify = notifyHold }) {
  const inFlight = new Map(); // server -> Map<callId, AbortSignal>
  const running = new Set();
  let closed = false;
  const track = (fn) => (...args) => {
    const work = fn(...args);
    running.add(work);
    work.then(() => running.delete(work), () => running.delete(work));
    return work;
  };
  const unavailable = () => !pettyCash || !txPolicy || !rpc || !approvalUrl;
  const stopped = (signals) => closed || signals.some((s) => s?.aborted);

  async function review(bytes, signed, correlation) {
    let result;
    try {
      result = await reviewTransaction({ bytes, signed, wallet: pettyCash.publicKey, rpc, txPolicy,
        lists: config.lists, cluster: config.cluster });
    } catch {
      // A caller/service error cannot be mistaken for a transaction approval.
      result = { messageSha256: null, summaryLine: 'review unavailable', verdict: 'deny', warnings: [],
        violations: [{ code: 'rpc_unavailable', path: 'review', observed: 'unavailable', bound: 'a successful review', message: 'transaction review failed' }] };
    }
    // The approval HTTP page is an output boundary too, so it receives the
    // same scrubbed review as the audit log, never upstream error fragments.
    result = JSON.parse(redact(JSON.stringify(result)));
    audit.append('tx_review', { ...correlation, ...result });
    return result;
  }

  async function waitForApproval(result, kind, correlation, signals, tool = null, cancelled = () => stopped(signals)) {
    if (cancelled()) return { code: 'approval_rejected', reason: 'cancelled' };
    let hold;
    try {
      hold = holds.add({ kind, tool, review: result, cluster: config.cluster,
        timeoutSec: config.approval.timeoutSec, parentIds: correlation.parentIds });
    } catch {
      return { code: 'approval_unavailable' };
    }
    const fields = { ...correlation, holdId: hold.id, messageSha256: result.messageSha256 };
    const cancel = () => holds.cancelWhere((h) => h.id === hold.id, 'request cancelled');
    try {
      audit.append('hold_created', { ...fields, kind, tool, cluster: hold.cluster,
        summaryLine: result.summaryLine, expiresAt: hold.expiresAt, approvalMessage: hold.approvalMessage });
      for (const signal of signals) signal?.addEventListener('abort', cancel, { once: true });
      if (cancelled()) cancel();
      if (config.approval.notify || config.approval.openBrowser) {
        notify({ body: result.summaryLine, url: approvalUrl, enabled: true, openUrl: config.approval.openBrowser });
      }
      const outcome = await holds.waitFor(hold.id);
      const type = { approved: 'hold_approved', rejected: 'hold_rejected', expired: 'hold_expired', cancelled: 'hold_cancelled' }[outcome.status];
      audit.append(type, { ...fields, ...(outcome.reason ? { reason: outcome.reason } : {}),
        ...(outcome.approval ? { publicKey: outcome.approval.publicKey,
          signature: outcome.approval.signature ? encode(outcome.approval.signature) : null,
          method: outcome.approval.method } : {}) });
      // Approval may have won the queue race, but cancellation still forbids the effect.
      if (cancelled()) return { code: 'approval_rejected', reason: 'cancelled' };
      if (outcome.status === 'approved') return null;
      return { code: outcome.status === 'expired' ? 'approval_timeout' : 'approval_rejected', reason: outcome.status };
    } finally {
      for (const signal of signals) signal?.removeEventListener('abort', cancel);
      // An audit/notification failure must not leave an approvable orphan.
      holds.cancelWhere((h) => h.id === hold.id, 'request finished');
    }
  }

  async function onToolCall({ name, args, requestId, signal }) {
    const callId = newId();
    const parts = splitToolName(name);
    const decision = decideTool(policy, { server: parts?.server ?? null, tool: parts?.tool ?? name, args });
    const fields = { callId, requestId, tool: name, server: parts?.server ?? null, mode: decision.mode, rule: decision.rule };
    const refuse = (code, violations = [], hint) => refusal({ code, tool: name, rule: decision.rule, violations, hint });
    const deny = (code, violations = [], hint) => {
      audit.append('tool_call', { ...fields, decision: 'deny', code, violations, args: scrubArgs(args),
        ...(decision.txArg ? { txArg: decision.txArg.name } : {}) });
      return refuse(code, violations, hint);
    };
    if (decision.violations.length) return deny(decision.code, decision.violations, decision.hint);
    if (decision.txArg && unavailable()) return deny('approval_unavailable');
    if (stopped([signal])) return deny('approval_rejected');
    const downstreams = getDownstreams();
    await downstreams.ready;
    if (stopped([signal])) return deny('approval_rejected');
    if (!parts || !downstreams.list().some((t) => t.name === name)) return deny('unknown_tool');
    audit.append('tool_call', { ...fields, decision: decision.mode, args: scrubArgs(args) });

    let calls;
    const cancel = () => holds.cancelWhere((h) => h.parentIds.includes(callId), 'host cancelled');
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      if (decision.txArg) {
        let bytes;
        try { bytes = transactionBytes(args[decision.txArg.name], decision.txArg.encoding); } catch { bytes = new Uint8Array(); }
        const correlation = { callId, parentIds: [callId], server: parts.server, tool: name };
        const result = await review(bytes, false, correlation);
        if (result.verdict === 'deny') return refuse(result.violations[0]?.code ?? 'tx_decode_failed', result.violations);
        if (result.verdict === 'hold') {
          const failure = await waitForApproval(result, 'tool-arg', correlation, [signal], name);
          if (failure) return refuse(failure.code);
        }
      }
      if (stopped([signal])) return refuse('approval_rejected');
      // Only calls actually forwarded are eligible parents of checkpoint sends.
      calls = inFlight.get(parts.server) ?? new Map();
      inFlight.set(parts.server, calls);
      calls.set(callId, signal);
      let result;
      try {
        result = await downstreams.call(parts.server, parts.tool, args, { signal, timeoutMs: config.servers[parts.server].timeoutMs });
      } catch (err) {
        // A failed/timed-out downstream can no longer release a held send.
        cancel();
        audit.append('tool_result', { callId, isError: true, ...(signal?.aborted ? { cancelled: true } : {}) });
        log(`[gate] ${name} failed: ${err?.message ?? err}`);
        return refuse('downstream_error');
      }
      audit.append('tool_result', { callId, ...summarizeResult(result) });
      return result;
    } finally {
      calls?.delete(callId);
      if (calls && !calls.size) inFlight.delete(parts.server);
      signal?.removeEventListener('abort', cancel);
      cancel();
    }
  }

  async function onRpcSend(bytes, meta) {
    const sendId = newId();
    const parents = [...(inFlight.get(meta.server) ?? [])];
    const fields = { sendId, requestId: meta.requestId, server: meta.server, parentIds: parents.map(([id]) => id) };
    const signals = [meta.signal, ...parents.map(([, signal]) => signal)];
    // A downstream timeout does not abort the host signal. Losing any captured
    // parent still cancels this send, even if it happened during review.
    const cancelled = () => stopped(signals) || parents.some(([id]) => !inFlight.get(meta.server)?.has(id));
    const refuse = (code, violations = [], reason) => {
      audit.append('rpc_send_refused', { ...fields, code, violations, ...(reason ? { reason } : {}) });
      return { forward: false, code: -32099, message: code, data: { code, violations, ...(reason ? { reason } : {}) } };
    };
    if (!parents.length) return refuse('unsolicited_send');
    if (cancelled()) return refuse('approval_rejected', [], 'cancelled');
    if (unavailable()) return refuse('approval_unavailable');
    const result = await review(bytes, true, fields);
    if (result.verdict === 'deny') return refuse(result.violations[0]?.code ?? 'tx_decode_failed', result.violations);
    if (result.verdict === 'hold') {
      const failure = await waitForApproval(result, 'rpc-send', fields, signals, null, cancelled);
      if (failure) return refuse(failure.code, [], failure.reason);
    }
    // No await between the last cancellation check, log, and forward decision.
    // T5 intentionally trusts this decision even if the client has disconnected.
    if (cancelled()) return refuse('approval_rejected', [], 'cancelled');
    const signature = encode(decodeTransaction(bytes).signatures[0]);
    audit.append('rpc_send_forwarded', { ...fields, messageSha256: result.messageSha256, signature });
    return { forward: true };
  }

  return {
    onToolCall: track(onToolCall),
    onRpcSend: track(onRpcSend),
    pendingHolds: () => holds.listPending().map((h) => ({ id: h.id, summaryLine: h.review.summaryLine,
      secondsLeft: Math.max(0, Math.ceil((Date.parse(h.expiresAt) - holds.nowMs()) / 1000)) })),
    async close() {
      closed = true;
      holds.close();
      await Promise.allSettled([...running]);
    },
  };
}
