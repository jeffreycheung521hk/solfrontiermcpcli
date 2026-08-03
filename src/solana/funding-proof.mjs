// Proving that one on-chain transaction is a specific funding payment.
//
// This module exists because of a real loss. On 2026-08-02 a funding
// transaction was correct and on time -- exact memo, exact amount, right
// payer, finalized 159 seconds inside the window -- and the client never
// looked at it. The detection loop accepted "any successful signature on the
// destination ATA after the baseline", and separately a prefilter compared
// the RPC's memo summary for exact equality. The money left the wallet and
// the database never recorded it.
//
// Two rules follow, and both are load-bearing:
//
//   Selection may only exclude what is provably irrelevant. It must never
//   judge content. The RPC's memo field is a SUMMARY -- formatted as
//   "[byte_len] memo", with multiple memos joined by "; " -- so neither
//   equality nor endsWith over it is a correctness gate.
//
//   Validation reads the instructions, and binds balances to the exact token
//   account by its index in the transaction's own accountKeys. Matching on
//   owner+mint and taking the first row is wrong: a wallet may hold several
//   token accounts for one mint.

/** Solana programs whose instructions this proof inspects. */
export const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

/**
 * Which signature rows deserve a getTransaction call.
 *
 * Pure, and deliberately blind to memo content. The only legitimate
 * exclusions are: the transaction failed on chain, it existed before this
 * run began, or it has already been fetched and judged.
 *
 * @param {Array} rows getSignaturesForAddress result
 * @param {Set<string>} baseline signatures present before this run
 * @param {Set<string>} seen signatures already fetched and rejected
 * @returns {string[]}
 */
export function selectCandidateSignatures(rows, baseline = new Set(), seen = new Set()) {
  const out = [];
  for (const row of rows ?? []) {
    if (!row || row.err) continue;
    const signature = String(row.signature ?? '');
    if (!signature) continue;
    if (baseline.has(signature) || seen.has(signature)) continue;
    out.push(signature);
  }
  return out;
}

/** Every outer Memo instruction's exact text, from the instruction itself. */
export function outerMemoTexts(transaction) {
  const out = [];
  for (const ix of transaction?.transaction?.message?.instructions ?? []) {
    if (ix?.programId !== MEMO_PROGRAM_ID) continue;
    // jsonParsed renders the Memo payload into `parsed` as a plain string.
    if (typeof ix.parsed === 'string') out.push(ix.parsed);
  }
  return out;
}

/**
 * Balance movement of one exact token account, bound by accountIndex.
 *
 * Missing-row rules are explicit. A missing PRE row means the account was
 * created inside this transaction, so its prior balance is zero. A missing
 * POST row means the transaction proves nothing about the final balance and
 * is fatal, rather than being read as zero.
 */
export function ataTokenDelta(transaction, ata, expectedOwner, mint, decimals) {
  const keys = transaction?.transaction?.message?.accountKeys ?? [];
  const index = keys.findIndex((k) => (typeof k === 'string' ? k : k?.pubkey) === ata);
  if (index < 0) return null;

  const pick = (rows) => (rows ?? []).find((r) => r.accountIndex === index && r.mint === mint) ?? null;
  const preRow = pick(transaction?.meta?.preTokenBalances);
  const postRow = pick(transaction?.meta?.postTokenBalances);
  if (!postRow) return null;

  for (const row of [preRow, postRow]) {
    if (!row) continue;
    if (row.owner !== expectedOwner) return null;
    if (Number(row.uiTokenAmount?.decimals) !== decimals) return null;
  }

  const pre = preRow ? BigInt(preRow.uiTokenAmount.amount) : 0n;
  const post = BigInt(postRow.uiTokenAmount.amount);
  return { accountIndex: index, pre, post, delta: post - pre };
}

/**
 * Prove a transaction is exactly this run's funding payment.
 *
 * Returns a proof object, or null with a machine-readable reason. The server
 * re-verifies all of this independently; this exists so the client never
 * hands confirm_funding a transaction that is not the one it is waiting for,
 * and never stops looking because it grabbed the wrong one.
 *
 * @returns {{ok: true, proof: object} | {ok: false, reason: string}}
 */
export function verifyFundingTransaction(transaction, expected) {
  const {
    memo,
    amountRaw,
    userWallet,
    userAta,
    controlledWallet,
    controlledAta,
    mint,
    decimals = 6,
    notBeforeSlot = null,
  } = expected;

  if (!transaction) return { ok: false, reason: 'no_transaction' };
  if (transaction.meta?.err != null) return { ok: false, reason: 'on_chain_error' };

  // A payment for this intent cannot predate the intent. Without this bound,
  // an OLD transaction can satisfy a NEW run: intent ids are deterministic
  // from (threshold_bps, amount_raw), so re-running the same parameters
  // produces the same memo, and the server's confirm_funding only checks
  // that a payment is not too LATE -- it has no lower bound at all.
  //
  // A baseline set of recent signatures is not sufficient for this: it is a
  // fixed window, so anything older than its depth is invisible to it. A
  // slot floor captured before the intent existed is exact and depth-free.
  if (notBeforeSlot != null) {
    const slot = Number(transaction.slot);
    if (!Number.isFinite(slot)) return { ok: false, reason: 'no_slot' };
    if (slot <= Number(notBeforeSlot)) return { ok: false, reason: 'predates_intent' };
  }

  // 1. The registered payer must have signed.
  const keys = transaction.transaction?.message?.accountKeys ?? [];
  const signed = keys.some((k) => typeof k === 'object' && k.pubkey === userWallet && k.signer === true);
  if (!signed) return { ok: false, reason: 'payer_did_not_sign' };

  // 2. Exactly one outer Memo instruction, exactly this run's text.
  const memos = outerMemoTexts(transaction);
  if (memos.length !== 1) return { ok: false, reason: memos.length === 0 ? 'no_outer_memo' : 'multiple_outer_memos' };
  if (memos[0] !== memo) return { ok: false, reason: 'memo_mismatch' };

  // 3. Exactly one outer transferChecked, every field pinned.
  const transfers = (transaction.transaction?.message?.instructions ?? []).filter(
    (ix) => ix?.programId === TOKEN_PROGRAM_ID && ix?.parsed?.type === 'transferChecked',
  );
  if (transfers.length !== 1) {
    return { ok: false, reason: transfers.length === 0 ? 'no_transfer_checked' : 'multiple_transfers' };
  }
  const info = transfers[0].parsed.info ?? {};
  if (info.source !== userAta) return { ok: false, reason: 'wrong_source' };
  if (info.destination !== controlledAta) return { ok: false, reason: 'wrong_destination' };
  if (info.mint !== mint) return { ok: false, reason: 'wrong_mint' };
  if (info.authority !== userWallet) return { ok: false, reason: 'wrong_authority' };
  if (String(info.tokenAmount?.amount) !== String(amountRaw)) return { ok: false, reason: 'wrong_amount' };
  if (Number(info.tokenAmount?.decimals) !== decimals) return { ok: false, reason: 'wrong_decimals' };

  // 4. Both pinned token accounts moved by exactly the pinned amount.
  const controlled = ataTokenDelta(transaction, controlledAta, controlledWallet, mint, decimals);
  const user = ataTokenDelta(transaction, userAta, userWallet, mint, decimals);
  if (!controlled) return { ok: false, reason: 'controlled_balance_unprovable' };
  if (!user) return { ok: false, reason: 'user_balance_unprovable' };
  if (controlled.delta !== BigInt(amountRaw)) return { ok: false, reason: 'controlled_delta_mismatch' };
  if (user.delta !== -BigInt(amountRaw)) return { ok: false, reason: 'user_delta_mismatch' };

  return {
    ok: true,
    proof: {
      slot: transaction.slot,
      blockTime: transaction.blockTime ?? null,
      memo: memos[0],
      controlledPre: controlled.pre.toString(),
      controlledPost: controlled.post.toString(),
      controlledDelta: controlled.delta.toString(),
      userDelta: user.delta.toString(),
    },
  };
}

/**
 * One pass of the funding search: select, fetch, validate.
 *
 * `getTransaction` is injected so the whole path can be driven offline from
 * captured payloads -- the layer where the 2026-08-02 loss occurred is the
 * layer that must be regression-tested.
 *
 * A signature that cannot be fetched yet is left alone for the next pass; a
 * signature that is fetched and fails validation is recorded in `seen` so it
 * is not fetched again.
 */
export async function findFundingMatches({
  rows, expected, baseline = new Set(), seen = new Set(), getTransaction, onRejected,
}) {
  const matches = [];
  for (const signature of selectCandidateSignatures(rows, baseline, seen)) {
    const transaction = await getTransaction(signature);
    if (!transaction) continue; // not yet visible; retry next pass
    const result = verifyFundingTransaction(transaction, expected);
    if (result.ok) {
      matches.push({ signature, proof: result.proof });
      continue;
    }
    // Report BEFORE blacklisting. A rejection is the only evidence of why a
    // payment was not detected, and this loop used to discard it: on
    // 2026-08-03 a correct payment sat unmatched for 220 seconds and the run
    // could not afterwards say which check refused it, because nothing had
    // recorded the reason. A search that cannot explain a miss cannot be
    // debugged from its own output.
    if (typeof onRejected === 'function') {
      onRejected({ signature, reason: result.reason, detail: result.detail ?? null });
    }
    seen.add(signature);
  }
  return matches;
}
