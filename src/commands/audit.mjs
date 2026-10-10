// `audit <acceptance-document.md>` — verify a published claim against the chain.
//
// Acceptance documents assert things: this transaction finalized at that slot,
// this account moved exactly that many units, this memo bound the transfer to
// that intent. Normally a reader either trusts the author or does hours of
// manual explorer work.
//
// This command reads the document, extracts every checkable assertion, and
// re-derives each one from the ledger. It exits 0 only if every extracted
// claim holds. Claims it cannot check are reported as UNVERIFIED rather than
// quietly counted as passes — an audit tool that hides its own blind spots is
// worse than none.
//
// `audit --log <sfgate-audit.jsonl>` applies the same discipline to the
// evidence SolFrontier Gate writes (SPEC §5.8); see the second half of this
// file. The document mode above it is unchanged.
import { readFileSync, existsSync } from 'node:fs';
import process from 'node:process';
import { SolanaRpc } from '../solana/rpc.mjs';
import { decodeTransaction, messageSha256 } from '../solana/tx.mjs';
import { encode as b58encode, decode as b58decode } from '../solana/base58.mjs';
import { verifyChainText } from '../gate/audit-log.mjs';
import { createRedactor } from '../gate/config.mjs';
import { redactSensitive } from '../mcp/session.mjs';
import { redact as redactRpcUrls } from '../config.mjs';
import { emitResult, info, table, style, isJsonMode } from '../cli/output.mjs';
import { EXIT, UsageError } from '../cli/exit-codes.mjs';

export const spec = {
  name: 'audit',
  summary: 'Verify an acceptance document, or a Gate audit log, against the ledger',
  usage:
    'audit <path-to-document.md> [--commitment finalized]\n' +
    '  sfcli audit --log <sfgate-audit.jsonl> [--commitment confirmed|finalized] [--rpc-env NAME]',
  options: {
    commitment: { type: 'string' },
    log: { type: 'string' },
    'rpc-env': { type: 'string' },
  },
  notes: [
    '--log: verify the hash chain, then fetch every transaction the log says was sent and check',
    '  it landed, succeeded, and carries exactly the message bytes the human approved.',
    '--rpc-env names the environment variable holding the RPC URL (default SFGATE_UPSTREAM_RPC_URL).',
    '  If the default is unset, only the chain is checked and transactions are UNVERIFIED.',
  ],
};

const SIGNATURE_RE = /[1-9A-HJ-NP-Za-km-z]{86,90}/g;
const MEMO_RE = /claw:w5h:([0-9a-f]{32}):([0-9a-f]{64})/g;

const PASS = 'PASS';
const FAIL = 'FAIL';
const UNVERIFIED = 'UNVERIFIED';

/** Pull every checkable assertion out of the document text. */
export function extractClaims(markdown) {
  const signatures = [...new Set((markdown.match(SIGNATURE_RE) ?? []))];

  const memos = [];
  for (const m of markdown.matchAll(MEMO_RE)) {
    memos.push({ memo: m[0], intentId: m[1], ruleHash: m[2] });
  }

  // Slots asserted anywhere as `number` or plain digits following "slot".
  const slots = new Set();
  for (const m of markdown.matchAll(/slot[^0-9]{0,20}`?(\d[\d,]{5,})`?/gi)) {
    slots.add(Number(m[1].replace(/,/g, '')));
  }

  // Balance-delta rows: | account | pre | post | delta |
  //
  // Prose documents are typeset, not machine-generated: thousands separators,
  // typographic minus (U+2212), en dashes and non-breaking spaces all show up
  // where a naive parser expects ASCII. Normalize before matching, or the
  // table silently contributes zero claims — which would look like a pass.
  const normalizeNumber = (cell) =>
    cell
      .replace(/[`*\s ]/g, '')
      .replace(/[−‒–—]/g, '-')
      .replace(/,/g, '')
      .replace(/^\+/, '');

  const deltas = [];
  for (const line of markdown.split(/\r?\n/)) {
    const cells = line.split('|').map((c) => c.trim());
    if (cells.length < 5) continue;
    const nums = cells.slice(2, 5).map(normalizeNumber);
    if (/^\d+$/.test(nums[0]) && /^\d+$/.test(nums[1]) && /^-?\d+$/.test(nums[2])) {
      const account = cells[1].replace(/[`*]/g, '').trim();
      deltas.push({ account, pre: nums[0], post: nums[1], delta: nums[2] });
    }
  }

  return { signatures, memos, slots: [...slots], deltas };
}

function row(claim, status, expected, observed, note = '') {
  return { claim, status, expected, observed, note };
}

export async function run({ flags, positionals, env = process.env }) {
  if (flags.log !== undefined) return runLog({ flags, positionals, env });
  if (flags['rpc-env'] !== undefined) throw new UsageError('--rpc-env only applies to `audit --log`');

  const docPath = positionals[1];
  if (!docPath) throw new UsageError('audit needs a path to an acceptance document');
  if (!existsSync(docPath)) throw new UsageError(`no such file: ${docPath}`);
  const commitment = flags.commitment ?? 'finalized';

  const markdown = readFileSync(docPath, 'utf8');
  const claims = extractClaims(markdown);
  if (claims.signatures.length === 0) {
    throw new UsageError('no transaction signatures found in that document — is it an acceptance record?');
  }

  const rpc = new SolanaRpc({ timeoutMs: 20000 });
  const results = [];
  const transactions = [];

  info(
    `auditing ${style.bold(docPath)}: ${claims.signatures.length} transaction(s), ` +
      `${claims.memos.length} memo binding(s), ${claims.deltas.length} balance row(s)`,
  );
  info('');

  for (const signature of claims.signatures) {
    const short = `${signature.slice(0, 8)}…`;

    let tx;
    try {
      tx = await rpc.getTransaction(signature, commitment);
    } catch (err) {
      results.push(row(`${short} exists`, FAIL, 'retrievable', err.message));
      continue;
    }
    if (!tx) {
      results.push(row(`${short} exists`, FAIL, `retrievable at ${commitment}`, 'not found'));
      continue;
    }
    results.push(row(`${short} exists`, PASS, `retrievable at ${commitment}`, `slot ${tx.slot}`));

    // Finality, independently of what the document says about it.
    let statusInfo = null;
    try {
      const status = await rpc.getSignatureStatus(signature);
      statusInfo = status?.value?.[0] ?? null;
    } catch {
      /* fall through to UNVERIFIED below */
    }
    results.push(
      statusInfo
        ? row(
            `${short} finality`,
            statusInfo.confirmationStatus === 'finalized' ? PASS : FAIL,
            'finalized',
            String(statusInfo.confirmationStatus),
          )
        : row(`${short} finality`, UNVERIFIED, 'finalized', 'status unavailable'),
    );

    results.push(
      row(`${short} succeeded`, tx.meta?.err == null ? PASS : FAIL, 'err: null', JSON.stringify(tx.meta?.err ?? null)),
    );

    // Slot: does the document assert this transaction's actual slot anywhere?
    results.push(
      claims.slots.includes(tx.slot)
        ? row(`${short} slot`, PASS, `${tx.slot} asserted in document`, String(tx.slot))
        : row(`${short} slot`, UNVERIFIED, 'a matching slot in the document', String(tx.slot),
            'document does not assert this slot'),
    );

    // Memo binding: if the document publishes a memo, the chain must match.
    const logs = (tx.meta?.logMessages ?? []).join('\n');
    for (const { memo, intentId } of claims.memos) {
      if (!logs.includes(memo)) continue;
      results.push(row(`${short} memo binds intent ${intentId.slice(0, 8)}…`, PASS, memo, 'present in transaction logs'));
    }

    transactions.push({
      signature,
      slot: tx.slot,
      blockTime: tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : null,
      err: tx.meta?.err ?? null,
      fee: tx.meta?.fee ?? null,
      confirmationStatus: statusInfo?.confirmationStatus ?? null,
      balances: (tx.meta?.postTokenBalances ?? []).map((post) => {
        const pre = (tx.meta?.preTokenBalances ?? []).find((p) => p.accountIndex === post.accountIndex);
        return {
          owner: post.owner,
          mint: post.mint,
          pre: pre?.uiTokenAmount.amount ?? '0',
          post: post.uiTokenAmount.amount,
        };
      }),
    });
  }

  // Balance deltas: match each documented row against any transaction's
  // observed pre/post pair. A row that matches nothing is a real failure.
  for (const claimed of claims.deltas) {
    const matched = transactions.some((tx) =>
      tx.balances.some(
        (b) =>
          b.pre === claimed.pre &&
          b.post === claimed.post &&
          String(BigInt(b.post) - BigInt(b.pre)) === String(BigInt(claimed.delta)),
      ),
    );
    results.push(
      matched
        ? row(`balance ${claimed.account}`, PASS, `${claimed.pre} → ${claimed.post}`, 'matched on chain')
        : row(
            `balance ${claimed.account}`,
            UNVERIFIED,
            `${claimed.pre} → ${claimed.post}`,
            'no audited transaction shows this pair',
            'may belong to a transaction outside this document',
          ),
    );
  }

  const failed = results.filter((r) => r.status === FAIL);
  const unverified = results.filter((r) => r.status === UNVERIFIED);
  const passed = results.filter((r) => r.status === PASS);

  if (isJsonMode()) {
    emitResult({
      document: docPath,
      verdict: failed.length === 0 ? 'VERIFIED' : 'CONTRADICTED',
      counts: { passed: passed.length, failed: failed.length, unverified: unverified.length },
      results,
      transactions,
    });
  } else {
    table(
      ['', 'claim', 'expected', 'observed'],
      results.map((r) => [
        r.status === PASS ? style.green('PASS') : r.status === FAIL ? style.red('FAIL') : style.yellow('UNVER'),
        r.claim,
        r.expected,
        r.observed + (r.note ? style.dim(` (${r.note})`) : ''),
      ]),
    );
    info('');
    info(
      failed.length === 0
        ? `${style.green('VERIFIED')} — ${passed.length} claims re-derived from the ledger, ` +
            `${unverified.length} not independently checkable`
        : `${style.red('CONTRADICTED')} — ${failed.length} claim(s) do not match the chain`,
    );
    info(style.dim('Off-chain steps (simulation, policy, CAS lease, operator activation) leave no'));
    info(style.dim('ledger trace and are outside what any tool can verify from public data.'));
  }

  return failed.length === 0 ? EXIT.OK : EXIT.FAILED;
}

// ---------------------------------------------------------------------------
// `audit --log <sfgate-audit.jsonl>` — re-verify Gate's evidence (SPEC §5.8).
//
// Two questions, answered independently:
//
//   1. Was the file edited? verifyChainText() re-derives every hash from
//      genesis. That proves internal consistency only: there is no external
//      anchor, so a log cut short at a record boundary still verifies, and
//      the output says so.
//   2. Did every transaction the log says was sent land, succeed, and carry
//      exactly the message bytes the human approved? The approved
//      messageSha256 is found through the log's own correlation ids
//      (hold_approved → tx_review), the transaction is fetched from the
//      ledger as base64 and decoded with the same strict decoder Gate reviews
//      with, and the two hashes are compared. Nothing the RPC "parses" for us
//      is trusted: jsonParsed output is a rendering, not the signed bytes.
//
// The log is Gate talking about itself, so a contradiction inside it is a
// FAIL even without an RPC: a send forwarded with no approval on record is
// exactly what I2 says can never happen. Absence of a link is different: a
// tool result that carries a signature Gate never reviewed (a server that
// posted its own transaction elsewhere, SPEC L1) is UNVERIFIED — reported,
// never counted as a pass.

export const DEFAULT_RPC_ENV = 'SFGATE_UPSTREAM_RPC_URL';
const LOG_COMMITMENTS = ['confirmed', 'finalized'];
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;

const short = (text, n = 8) => `${String(text).slice(0, n)}…`;
const isId = (value) => typeof value === 'string' && value !== '';

/** A 64-byte base58 signature. Length-capped first: base58 decoding is quadratic. */
function isSignature(text) {
  if (typeof text !== 'string' || text.length < 64 || text.length > 100) return false;
  try {
    return b58decode(text).length === 64;
  } catch {
    return false;
  }
}

/** Every correlation id a record answers to: callId, sendId and any parentIds. */
function idsOf(record) {
  const ids = [record.callId, record.sendId];
  if (Array.isArray(record.parentIds)) ids.push(...record.parentIds);
  return ids.filter(isId);
}

function indexRecords(records) {
  const approvals = [];
  const reviews = [];
  const created = new Map(); // holdId -> hold_created records
  for (const r of records) {
    if (r.type === 'hold_approved') approvals.push(r);
    else if (r.type === 'tx_review') reviews.push(r);
    else if (r.type === 'hold_created' && isId(r.holdId)) {
      created.set(r.holdId, [...(created.get(r.holdId) ?? []), r]);
    }
  }
  return { approvals, reviews, created };
}

/**
 * The message hash one hold_approved record approved. The hold's parent id
 * (sendId, else callId) leads to the tx_review that produced the hold. If a
 * hold record states the hash itself, it must agree with a review; if none
 * does, the parent must have exactly one held review — with two, nothing in
 * the log says which one the human signed for, and guessing is how an
 * auditor ends up vouching for the wrong transaction.
 */
function approvedHashOf(approval, index) {
  const label = `hold ${isId(approval.holdId) ? approval.holdId : '?'} (line ${approval.seq})`;
  const parent = isId(approval.sendId) ? approval.sendId : isId(approval.callId) ? approval.callId : null;
  if (!parent) return { problem: `${label} names no sendId or callId` };

  // Order matters (I6): review, then hold, then approval.
  const held = index.reviews.filter(
    (r) => (r.sendId === parent || r.callId === parent) && r.verdict === 'hold' && r.seq < approval.seq,
  );
  if (held.some((r) => !HEX64_RE.test(String(r.messageSha256)))) {
    return { problem: `${label}: a tx_review under ${parent} has a malformed messageSha256` };
  }
  const stated = [approval, ...(index.created.get(approval.holdId) ?? []).filter((c) => c.seq < approval.seq)]
    .filter((r) => r.messageSha256 !== undefined)
    .map((r) => r.messageSha256);
  if (stated.some((h) => !HEX64_RE.test(String(h)))) return { problem: `${label}: malformed messageSha256` };
  if (new Set(stated).size > 1) return { problem: `${label}: hold records disagree on the message hash` };
  if (stated.length) {
    if (!held.some((r) => r.messageSha256 === stated[0])) {
      return { problem: `${label}: no tx_review with verdict "hold" for message ${short(stated[0], 12)} under ${parent}` };
    }
    return { hash: stated[0] };
  }
  const distinct = [...new Set(held.map((r) => r.messageSha256))];
  if (distinct.length === 0) return { problem: `${label}: no tx_review with verdict "hold" under ${parent}` };
  if (distinct.length > 1) {
    return { problem: `${label}: ${distinct.length} reviewed messages under ${parent}; the log does not say which was approved` };
  }
  return { hash: distinct[0] };
}

/**
 * Approved message hashes linked to `id` by approvals logged before line
 * `beforeSeq`. → { kind: 'none' } | { kind: 'ok', hashes } | { kind: 'broken', problems }
 */
function approvalsFor(id, beforeSeq, index) {
  const linked = index.approvals.filter((a) => idsOf(a).includes(id));
  const before = linked.filter((a) => a.seq < beforeSeq);
  if (before.length === 0) {
    return linked.length
      ? { kind: 'broken', problems: [`approval for ${id} logged after line ${beforeSeq} (line ${linked[0].seq}), I6`] }
      : { kind: 'none' };
  }
  const hashes = new Set();
  const problems = [];
  for (const approval of before) {
    const found = approvedHashOf(approval, index);
    if (found.hash) hashes.add(found.hash);
    else problems.push(found.problem);
  }
  return problems.length ? { kind: 'broken', problems } : { kind: 'ok', hashes };
}

/**
 * Every transaction a Gate audit log says was sent, linked to what the human
 * approved. Pure: no RPC. One entry per distinct signature, in order of first
 * appearance — a tool result that returns a signature Gate itself forwarded
 * is the same transaction, reported once.
 *
 * @param {object[]} records parsed, chain-verified records
 * @returns {{ signature: string|null, lines: number[], sendIds: string[], callIds: string[],
 *             forwarded: boolean, link: 'ok'|'none'|'broken'|'malformed', approved: string[], problems: string[] }[]}
 */
export function collectSentTransactions(records) {
  const index = indexRecords(records);
  const groups = [];
  const bySignature = new Map();
  for (const r of records) {
    const forwarded = r.type === 'rpc_send_forwarded';
    if (!forwarded && !(r.type === 'tool_result' && r.signature !== undefined)) continue;
    const key = typeof r.signature === 'string' ? r.signature : null;
    let group = key === null ? null : bySignature.get(key);
    if (!group) {
      group = { signature: key, sources: [] };
      groups.push(group);
      if (key !== null) bySignature.set(key, group);
    }
    group.sources.push(r);
  }
  return groups.map((group) => linkGroup(group, index));
}

function linkGroup({ signature, sources }, index) {
  const sends = sources.filter((r) => r.type === 'rpc_send_forwarded');
  const tools = sources.filter((r) => r.type === 'tool_result');
  const base = {
    signature,
    lines: sources.map((r) => r.seq),
    sendIds: [...new Set(sends.map((r) => r.sendId).filter(isId))],
    callIds: [...new Set(tools.map((r) => r.callId).filter(isId))],
    forwarded: sends.length > 0,
  };
  const result = (link, approved = [], problems = []) => ({ ...base, link, approved: [...approved], problems });

  if (!isSignature(signature)) {
    // Gate derives a forwarded signature from the bytes it sent, so a bad one
    // is a broken record. A tool result's is extracted by pattern from free
    // text, and a near-miss there is not evidence of anything.
    const problem = signature === null ? 'record carries no signature string' : 'not a 64-byte base58 signature';
    return result(sends.length ? 'broken' : 'malformed', [], [problem]);
  }

  if (sends.length) {
    // Every forward of this signature must be backed by an approval for it.
    let approved = null;
    const problems = [];
    for (const send of sends) {
      if (!isId(send.sendId)) {
        problems.push(`rpc_send_forwarded (line ${send.seq}) carries no sendId`);
        continue;
      }
      const found = approvalsFor(send.sendId, send.seq, index);
      if (found.kind === 'none') problems.push(`forwarded (line ${send.seq}) with no approval on record for ${send.sendId} (I2)`);
      else if (found.kind === 'broken') problems.push(...found.problems);
      else approved = approved === null ? found.hashes : new Set([...approved].filter((h) => found.hashes.has(h)));
    }
    if (!problems.length && approved.size === 0) problems.push('forwards of one signature were approved for different messages');
    return problems.length ? result('broken', [], problems) : result('ok', approved);
  }

  // Tool results only. A later call that merely mentions the signature (a
  // status lookup) links to nothing and is ignored; a broken link is not.
  const approved = new Set();
  const problems = [];
  for (const tool of tools) {
    if (!isId(tool.callId)) continue;
    const found = approvalsFor(tool.callId, tool.seq, index);
    if (found.kind === 'broken') problems.push(...found.problems);
    else if (found.kind === 'ok') for (const h of found.hashes) approved.add(h);
  }
  if (problems.length) return result('broken', [], problems);
  return approved.size ? result('ok', approved) : result('none');
}

/** Fetch the landed transaction and compare it with what was approved. */
async function checkLanded(rpc, signature, approved, commitment) {
  let tx;
  try {
    tx = await rpc.call('getTransaction', [
      signature,
      { encoding: 'base64', maxSupportedTransactionVersion: 0, commitment },
    ]);
  } catch (err) {
    const message = String(err?.message ?? err);
    return { status: FAIL, observed: message.includes('getTransaction') ? message : `getTransaction failed: ${message}` };
  }
  if (!tx) return { status: FAIL, observed: `not found at ${commitment}` };

  const [b64, encoding] = Array.isArray(tx.transaction) ? tx.transaction : [];
  if (typeof b64 !== 'string' || encoding !== 'base64') {
    return { status: FAIL, observed: 'the RPC returned no base64 transaction' };
  }
  let decoded;
  try {
    decoded = decodeTransaction(new Uint8Array(Buffer.from(b64, 'base64')));
  } catch (err) {
    return { status: FAIL, observed: `the ledger transaction does not decode: ${err.message}` };
  }
  // The first signature is the transaction id. An RPC that answers with a
  // different transaction must not get to vouch for this one.
  const first = decoded.signatures.length ? b58encode(decoded.signatures[0]) : null;
  if (first !== signature) {
    return { status: FAIL, observed: `the RPC returned a different transaction (${first ? short(first) : 'unsigned'})` };
  }

  const hash = messageSha256(decoded);
  const slot = Number.isSafeInteger(tx.slot) ? tx.slot : null;
  const problems = [];
  if (!approved.has(hash)) problems.push(`message ${short(hash, 12)} ≠ approved`);
  if (!tx.meta || typeof tx.meta !== 'object') problems.push('no status metadata (success unprovable)');
  else if (tx.meta.err != null) problems.push(`err ${JSON.stringify(tx.meta.err)}`);
  return problems.length
    ? { status: FAIL, observed: `slot ${slot}: ${problems.join('; ')}`, slot, observedMessageSha256: hash }
    : { status: PASS, observed: `slot ${slot} · message matches · err null`, slot, observedMessageSha256: hash };
}

function describeSources(group) {
  const ids = [...group.sendIds.map((id) => `send ${id}`), ...group.callIds.map((id) => `call ${id}`)];
  return `${ids.join(', ') || 'no id'}; line ${group.lines.join(', ')}`;
}

/**
 * Verify a Gate audit log: the hash chain, then every transaction it says
 * was sent. Pure apart from `rpc` (anything with `call(method, params)`, e.g.
 * SolanaRpc); `rpc: null` checks the chain only and reports transactions
 * UNVERIFIED. Rows are JSON-safe.
 *
 * @param {{ text: string, rpc?: { call(method: string, params: any[]): Promise<any> } | null,
 *           commitment?: 'confirmed'|'finalized', rpcHint?: string }} input
 * @returns {Promise<{ verdict: 'VERIFIED'|'FAILED', chain: object, counts: object, results: object[], crlf: boolean }>}
 */
export async function verifyAuditLog({ text, rpc = null, commitment = 'finalized', rpcHint = 'no RPC configured' }) {
  // A git checkout with core.autocrlf rewrites "\n" as "\r\n". The hash never
  // covers the line terminator, and a canonical JSON line cannot contain a raw
  // CR, so converting back changes no record; any other stray CR still fails.
  const crlf = text.includes('\r\n');
  const normalized = crlf ? text.replace(/\r\n/g, '\n') : text;

  const results = [];
  const chain = verifyChainText(normalized);
  results.push(
    chain.ok
      ? row('chain', PASS, 'hash-chained from genesis', `${chain.count} records`)
      : row('chain', FAIL, 'hash-chained from genesis', `FAIL at line ${chain.firstBadLine}: ${chain.reason}`),
  );

  // Only the verified prefix is evidence. Records from the first bad line on
  // are not read at all: an edited record must not get to claim anything.
  const lines = normalized.split('\n').slice(0, chain.ok ? chain.count : chain.firstBadLine - 1);
  const records = lines.map((line) => JSON.parse(line));
  if (!chain.ok) {
    results.push(
      row(`records from line ${chain.firstBadLine}`, UNVERIFIED, 'part of the chain', 'not read',
        'the chain is broken there, so they are not evidence'),
    );
  }

  for (const group of collectSentTransactions(records)) {
    const claim = `tx ${group.signature === null ? '(none)' : short(group.signature)}`;
    const extra = {
      signature: group.signature,
      lines: group.lines,
      sendIds: group.sendIds,
      callIds: group.callIds,
      approvedMessageSha256: group.approved,
    };
    const note = describeSources(group);

    if (group.link === 'broken') {
      results.push({ ...row(claim, FAIL, 'an approval on record for this exact message', group.problems.join('; '), note), ...extra });
      continue;
    }
    if (group.link === 'malformed') {
      results.push({ ...row(claim, UNVERIFIED, 'a 64-byte signature', group.problems.join('; '), note), ...extra });
      continue;
    }
    if (group.link === 'none') {
      results.push({
        ...row(claim, UNVERIFIED, 'an approved tx_review linked to the call', 'none: Gate never reviewed this transaction', note),
        ...extra,
      });
      continue;
    }

    const expected = group.approved.length === 1
      ? `message ${short(group.approved[0], 12)} approved, err null`
      : `one of ${group.approved.length} approved messages, err null`;
    if (!rpc) {
      results.push({ ...row(claim, UNVERIFIED, expected, `not checked: ${rpcHint}`, note), ...extra });
      continue;
    }
    const landed = await checkLanded(rpc, group.signature, new Set(group.approved), commitment);
    results.push({
      ...row(claim, landed.status, expected, landed.observed, note),
      ...extra,
      slot: landed.slot ?? null,
      observedMessageSha256: landed.observedMessageSha256 ?? null,
    });
  }

  const counts = {
    passed: results.filter((r) => r.status === PASS).length,
    failed: results.filter((r) => r.status === FAIL).length,
    unverified: results.filter((r) => r.status === UNVERIFIED).length,
  };
  return {
    verdict: counts.failed === 0 ? 'VERIFIED' : 'FAILED',
    chain: chain.ok
      ? { ok: true, records: chain.count }
      : { ok: false, records: chain.count, firstBadLine: chain.firstBadLine, reason: chain.reason },
    counts,
    results,
    crlf,
  };
}

/** Deep copy with every string passed through `fn` (keys included). */
function redactDeep(value, fn) {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, fn));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[fn(k)] = redactDeep(v, fn);
    return out;
  }
  return value;
}

async function runLog({ flags, positionals, env }) {
  const file = flags.log;
  if (positionals.length > 1) throw new UsageError('audit takes a document or --log <file>, not both');
  if (!file) throw new UsageError('--log needs the path of a Gate audit log');
  if (!existsSync(file)) throw new UsageError(`no such file: ${file}`);

  const commitment = flags.commitment ?? 'finalized';
  if (!LOG_COMMITMENTS.includes(commitment)) {
    throw new UsageError(`--commitment must be ${LOG_COMMITMENTS.join(' or ')}`);
  }

  // --rpc-env takes a NAME. Someone pasting the URL itself must not see it
  // echoed back in the error (I4), so the value is never quoted here.
  const rpcEnv = flags['rpc-env'] ?? DEFAULT_RPC_ENV;
  if (!ENV_NAME_RE.test(rpcEnv)) {
    throw new UsageError('--rpc-env takes the NAME of an environment variable (letters, digits, _), not its value');
  }
  const rawUrl = env[rpcEnv] ?? '';
  const url = rawUrl.trim();
  if (!url && flags['rpc-env'] !== undefined) {
    // An explicit request for a ledger check that cannot happen is refused,
    // not quietly downgraded to chain-only.
    throw new UsageError(`${rpcEnv} is not set`, { hint: `export ${rpcEnv}, or omit --rpc-env for a chain-only check` });
  }

  // The URL may embed an API key (I4). Every string that leaves this command
  // goes through this: the exact URL and its key-looking parts, any env value
  // that looks like a URL or a secret, and any remaining http(s) URL.
  const known = createRedactor(url ? [rawUrl, url] : []);
  const scrub = (text) => redactRpcUrls(redactSensitive(known(text), env), env);

  const text = readFileSync(file, 'utf8');
  if (text === '') throw new UsageError(`${file} is empty: there is nothing to verify`);

  const rpc = url ? new SolanaRpc({ url, timeoutMs: 20000 }) : null;
  info(
    scrub(
      `auditing ${style.bold(file)}: ` +
        (rpc ? `ledger via ${rpcEnv} at ${commitment}` : `chain only (${rpcEnv} is not set)`),
    ),
  );
  info('');

  const report = redactDeep(
    await verifyAuditLog({ text, rpc, commitment, rpcHint: `no RPC (set ${rpcEnv})` }),
    scrub,
  );
  const { results, counts } = report;
  const rederived = results.filter((r) => r.signature !== undefined && r.status === PASS).length;

  if (isJsonMode()) {
    emitResult({
      log: scrub(file),
      verdict: report.verdict,
      rpc: rpc ? { env: rpcEnv, commitment } : null,
      chain: report.chain,
      counts,
      crlfNormalized: report.crlf,
      results,
    });
  } else {
    table(
      ['', 'claim', 'expected', 'observed'],
      results.map((r) => [
        r.status === PASS ? style.green('PASS') : r.status === FAIL ? style.red('FAIL') : style.yellow('UNVER'),
        r.claim,
        r.expected,
        r.observed + (r.note ? style.dim(` (${r.note})`) : ''),
      ]),
    );
    info('');
    if (report.crlf) info(style.dim('CRLF line endings were read as LF (a git autocrlf checkout); no record changes.'));
    info(
      counts.failed === 0
        ? `${style.green('VERIFIED')} — chain intact (${report.chain.records} records), ` +
            `${rederived} transaction(s) re-derived from the ledger, ${counts.unverified} not independently checkable`
        : `${style.red('FAILED')} — ${counts.failed} row(s) do not hold`,
    );
    info(style.dim('The chain proves the file was not edited from genesis to its last line; it cannot'));
    info(style.dim('prove that no records were cut from the end. UNVERIFIED rows are not passes.'));
  }

  return counts.failed === 0 ? EXIT.OK : EXIT.FAILED;
}
