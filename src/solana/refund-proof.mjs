// Refund verification and crash-recovery decisions, as pure functions.
//
// This file signs nothing, broadcasts nothing and touches no database. It is
// the half of a refund rail that can be built and proven without reopening the
// concluded server repository, and it is the half that has to exist first:
// step 5 of the agreed order is "mark refunded only after `finalized` with both
// balance deltas exact", and this is what "exact" means.
//
// A refund is the funding transaction in reverse, and the asymmetries matter:
//
//   funding                          refund
//   -------                          ------
//   user wallet signs                CONTROLLED wallet signs (it owns the ATA)
//   user ATA -> controlled ATA       controlled ATA -> user ATA
//   several attempts are survivable  a SECOND one is a double refund
//
// That last row is why this module treats multiple matches as a hard error
// rather than picking the earliest, which is what the funding path does.
import { ataTokenDelta, outerMemoTexts, TOKEN_PROGRAM_ID } from './funding-proof.mjs';

/**
 * Verify that a transaction is exactly the refund we intended to make.
 *
 * Every field is pinned. A near-miss is a rejection with a reason, never a
 * partial credit -- there is no such thing as an approximately correct refund.
 *
 * @param {object} transaction  a jsonParsed getTransaction result
 * @param {object} expected
 * @param {string} expected.amountRaw         exact base units, as a string
 * @param {string} expected.controlledWallet  signer and owner of the source ATA
 * @param {string} expected.controlledAta     source
 * @param {string} expected.userWallet        owner of the destination ATA
 * @param {string} expected.userAta           destination
 * @param {string} expected.mint
 * @param {number} expected.decimals
 * @param {number} expected.notBeforeSlot     the funding slot: a refund cannot
 *                                            precede the payment it returns
 * @param {string|null} expected.memo         exact memo, or null to require none.
 *                                            There is deliberately no default.
 */
export function verifyRefundTransaction(transaction, expected) {
  const fail = (reason, detail) => ({ ok: false, reason, ...(detail ? { detail } : {}) });

  if (!transaction) return fail('no_transaction');
  if (transaction.meta?.err) return fail('transaction_failed');

  // 0. A refund cannot predate the funding it returns. Same defence as the
  //    funding slot floor, and it also excludes the funding transaction itself
  //    from ever being mistaken for its own refund.
  const slot = Number(transaction.slot);
  if (!Number.isFinite(slot)) return fail('no_slot');
  if (!Number.isFinite(expected.notBeforeSlot)) return fail('no_slot_floor');
  if (slot <= expected.notBeforeSlot) return fail('predates_funding', { slot });

  // 1. The controlled wallet must have signed. Nothing else can move funds out
  //    of its ATA, so a transaction lacking that signature is not our refund
  //    however well the balances line up.
  const keys = transaction.transaction?.message?.accountKeys ?? [];
  const signer = keys.find(
    (k) => typeof k === 'object' && k?.pubkey === expected.controlledWallet && k.signer === true,
  );
  if (!signer) return fail('controlled_wallet_did_not_sign');

  // 2. Memo, by explicit expectation only.
  const memos = outerMemoTexts(transaction);
  if (expected.memo === null) {
    if (memos.length !== 0) return fail('unexpected_memo', { memos });
  } else if (typeof expected.memo === 'string') {
    if (memos.length !== 1) return fail('memo_count', { count: memos.length });
    if (memos[0] !== expected.memo) return fail('memo_mismatch', { saw: memos[0] });
  } else {
    // Refusing to guess is the point: a caller who has not decided whether the
    // refund carries a memo has not finished designing the refund.
    return fail('memo_expectation_not_declared');
  }

  // 3. Exactly one transferChecked, every field pinned, direction reversed.
  const instructions = transaction.transaction?.message?.instructions ?? [];
  const transfers = instructions.filter(
    (i) => i.programId === TOKEN_PROGRAM_ID && i.parsed?.type === 'transferChecked',
  );
  if (transfers.length !== 1) return fail('transfer_count', { count: transfers.length });
  const info = transfers[0].parsed?.info ?? {};
  if (info.source !== expected.controlledAta) return fail('wrong_source', { saw: info.source });
  if (info.destination !== expected.userAta) return fail('wrong_destination', { saw: info.destination });
  if (info.authority !== expected.controlledWallet) return fail('wrong_authority', { saw: info.authority });
  if (info.mint !== expected.mint) return fail('wrong_mint', { saw: info.mint });
  if (String(info.tokenAmount?.amount) !== String(expected.amountRaw)) {
    return fail('wrong_amount', { saw: info.tokenAmount?.amount });
  }
  if (Number(info.tokenAmount?.decimals) !== Number(expected.decimals)) {
    return fail('wrong_decimals', { saw: info.tokenAmount?.decimals });
  }

  // 4. Both balances moved by exactly the amount, bound by accountIndex rather
  //    than by owner+mint first match. The instruction says what was asked for;
  //    the balances say what happened.
  const amount = BigInt(expected.amountRaw);
  const from = ataTokenDelta(
    transaction, expected.controlledAta, expected.controlledWallet, expected.mint, Number(expected.decimals),
  );
  const to = ataTokenDelta(
    transaction, expected.userAta, expected.userWallet, expected.mint, Number(expected.decimals),
  );
  if (!from) return fail('source_balance_unreadable');
  if (!to) return fail('destination_balance_unreadable');
  if (from.delta !== -amount) return fail('source_delta_mismatch', { delta: from.delta.toString() });
  if (to.delta !== amount) return fail('destination_delta_mismatch', { delta: to.delta.toString() });

  return {
    ok: true,
    proof: {
      slot,
      controlledDelta: from.delta.toString(),
      userDelta: to.delta.toString(),
      amountRaw: String(expected.amountRaw),
    },
  };
}

/**
 * Scan candidate transactions for refunds of one intent.
 *
 * Returns ALL matches. The caller must treat more than one as a double refund
 * that has already happened -- unlike funding, where several attempts are
 * survivable and the earliest simply wins.
 */
export async function findRefundMatches({ rows, expected, getTransaction }) {
  const matches = [];
  for (const row of rows ?? []) {
    if (row?.err) continue;
    const transaction = await getTransaction(row.signature);
    const verdict = verifyRefundTransaction(transaction, expected);
    if (verdict.ok) matches.push({ signature: row.signature, proof: verdict.proof });
  }
  return matches;
}

/**
 * What to do about a refund whose outcome is unknown.
 *
 * This is the crash window the frozen repository cannot close on its own:
 * `refund_signature` is written by `mark_refunded_if_refunding`, which runs
 * AFTER confirmation, so a daemon that signs, broadcasts and then dies leaves a
 * row in `refunding` with no record of what it sent. Re-signing at that point
 * produces a second transaction with a fresh blockhash, and if the first one
 * landed, that is a double refund out of a shared controlled wallet.
 *
 * The resolver is blockhash expiry, which is a fact about the chain rather than
 * a promise about our own bookkeeping. A signed transaction is valid only until
 * `lastValidBlockHeight`; past it, one that has not landed can never land. So:
 *
 *   - signature known and found on chain      -> reconcile against the proof
 *   - signature known, absent, still valid    -> RESEND THE SAME BYTES
 *   - signature known, absent, expired        -> safe to sign a new one
 *   - signature unknown, journal readable     -> recover it, then as above
 *   - signature unknown, journal unreadable   -> STOP, reconcile by hand
 *
 * The last case is why the signature and its `lastValidBlockHeight` have to be
 * persisted BEFORE broadcast. Without that record there is no safe automatic
 * move: the daemon cannot distinguish "never sent" from "sent and lost", and
 * both re-signing and giving up can be wrong.
 *
 * @param {object} p
 * @param {string|null} p.signature            recovered from the pre-broadcast journal
 * @param {boolean} p.journalReadable          false if the journal is missing or corrupt
 * @param {'found'|'absent'|'unknown'} p.onChain result of getSignatureStatuses
 * @param {number|null} p.currentBlockHeight
 * @param {number|null} p.lastValidBlockHeight
 */
export function refundRecoveryDecision({
  signature,
  journalReadable,
  onChain,
  currentBlockHeight,
  lastValidBlockHeight,
}) {
  if (!journalReadable) {
    return { action: 'halt', mayResend: false, maySignNew: false, reason: 'journal_unreadable' };
  }
  if (!signature) {
    // The journal is readable and says nothing was ever signed, which is the
    // one case where signing fresh is provably safe.
    return { action: 'sign_new', mayResend: false, maySignNew: true, reason: 'nothing_was_signed' };
  }
  if (onChain === 'found') {
    return { action: 'reconcile', mayResend: false, maySignNew: false, reason: 'already_on_chain', signature };
  }
  if (onChain !== 'absent') {
    return { action: 'halt', mayResend: false, maySignNew: false, reason: 'chain_state_unknown', signature };
  }
  const heightsKnown = Number.isFinite(currentBlockHeight) && Number.isFinite(lastValidBlockHeight);
  if (!heightsKnown) {
    return { action: 'halt', mayResend: false, maySignNew: false, reason: 'expiry_unknown', signature };
  }
  if (currentBlockHeight > lastValidBlockHeight) {
    // The signed bytes can no longer be accepted by any validator, so the
    // ambiguity is resolved by the chain rather than by our confidence.
    return { action: 'sign_new', mayResend: false, maySignNew: true, reason: 'blockhash_expired', signature };
  }
  return { action: 'resend_same', mayResend: true, maySignNew: false, reason: 'still_valid', signature };
}
