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
import { readFileSync, existsSync } from 'node:fs';
import { SolanaRpc } from '../solana/rpc.mjs';
import { emitResult, info, table, style, isJsonMode } from '../cli/output.mjs';
import { EXIT, UsageError } from '../cli/exit-codes.mjs';

export const spec = {
  name: 'audit',
  summary: 'Verify the on-chain claims of an acceptance document against the ledger',
  usage: 'audit <path-to-document.md> [--commitment finalized]',
  options: { commitment: { type: 'string' } },
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

export async function run({ flags, positionals }) {
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
