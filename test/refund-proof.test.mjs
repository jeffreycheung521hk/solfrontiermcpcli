// Refund verification, driven by the real captured mainnet payload reversed.
//
// The fixture is the actual 2026-08-02 funding transaction. Reversing it -- swap
// source and destination, swap the signer, negate the deltas -- produces a
// transaction shaped exactly like a real refund, which is a far better test
// subject than something hand-written to match the verifier.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { verifyRefundTransaction, findRefundMatches, refundRecoveryDecision } from '../src/solana/refund-proof.mjs';
import { ROOT } from './helpers.mjs';

const FIXTURE = JSON.parse(
  readFileSync(path.join(ROOT, 'scripts', 'demo', 'fixtures', 'funding-20260802.json'), 'utf8'),
);

const RAIL = {
  amountRaw: '200000',
  controlledWallet: 'BPfDMmeMBmCbMC1rWh7hwigMBoKGBrKwXxSeUu9hhs5L',
  controlledAta: '7LFdKcSV7JQYi3or5y9phHVPjhGigu5DDjUakAFbBmk3',
  userWallet: 'C4QQjzWxnJ5QFAbkzhQJ3wTzyX6nw1vyFvJwbPXJGPNW',
  userAta: '4bDArC4UVoBjecHUZaCKqhuhTYPoiKS4qpQQpxuvm1qn',
  mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  decimals: 6,
  notBeforeSlot: 1000,
  memo: null,
};

/** The captured funding payload, turned around into a refund. */
function refundTx({ slot = 2000, amount = '200000', memo = null } = {}) {
  const tx = JSON.parse(JSON.stringify(FIXTURE.transaction));
  tx.slot = slot;
  const msg = tx.transaction.message;

  // The controlled wallet signs a refund; the user wallet does not.
  for (const k of msg.accountKeys) {
    if (typeof k !== 'object') continue;
    if (k.pubkey === RAIL.userWallet) { k.signer = false; }
  }
  msg.accountKeys.unshift({ pubkey: RAIL.controlledWallet, signer: true, writable: true });

  // Reverse the transfer.
  msg.instructions = msg.instructions
    .filter((i) => i.parsed?.type !== 'memo' && i.program !== 'spl-memo')
    .map((i) => {
      if (i.parsed?.type !== 'transferChecked') return i;
      const c = JSON.parse(JSON.stringify(i));
      c.parsed.info.source = RAIL.controlledAta;
      c.parsed.info.destination = RAIL.userAta;
      c.parsed.info.authority = RAIL.controlledWallet;
      c.parsed.info.tokenAmount.amount = amount;
      return c;
    });
  if (memo !== null) {
    msg.instructions.unshift({
      programId: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
      program: 'spl-memo',
      parsed: memo,
    });
  }

  // Reverse the balances. accountIndex must follow the unshifted key.
  const bump = (rows) => (rows ?? []).map((r) => ({ ...r, accountIndex: r.accountIndex + 1 }));
  const pre = bump(tx.meta.preTokenBalances);
  const post = bump(tx.meta.postTokenBalances);
  const idx = (ata) => msg.accountKeys.findIndex((k) => (typeof k === 'string' ? k : k?.pubkey) === ata);
  const amt = BigInt(amount);
  const set = (rows, ata, owner, value) => {
    const i = idx(ata);
    const row = rows.find((r) => r.accountIndex === i);
    const target = { accountIndex: i, mint: RAIL.mint, owner, uiTokenAmount: { amount: String(value), decimals: 6 } };
    if (row) Object.assign(row, target); else rows.push(target);
  };
  set(pre, RAIL.controlledAta, RAIL.controlledWallet, amt);
  set(post, RAIL.controlledAta, RAIL.controlledWallet, 0n);
  set(pre, RAIL.userAta, RAIL.userWallet, 0n);
  set(post, RAIL.userAta, RAIL.userWallet, amt);
  tx.meta.preTokenBalances = pre;
  tx.meta.postTokenBalances = post;
  return tx;
}

describe('refund proof', () => {
  test('a correct refund verifies, with both deltas exact', () => {
    const v = verifyRefundTransaction(refundTx(), RAIL);
    assert.equal(v.ok, true, `reason: ${v.reason} ${JSON.stringify(v.detail ?? {})}`);
    assert.equal(v.proof.controlledDelta, '-200000');
    assert.equal(v.proof.userDelta, '200000');
  });

  test('the funding transaction is never mistaken for its own refund', () => {
    // Direction, signer and slot floor each independently reject it.
    const funding = JSON.parse(JSON.stringify(FIXTURE.transaction));
    funding.slot = 5000;
    const v = verifyRefundTransaction(funding, RAIL);
    assert.equal(v.ok, false);
  });

  test('a refund that predates the funding it returns is refused', () => {
    const v = verifyRefundTransaction(refundTx({ slot: RAIL.notBeforeSlot }), RAIL);
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'predates_funding');
  });

  test('a wrong amount is refused, in either direction', () => {
    for (const amount of ['199999', '200001', '400000']) {
      const v = verifyRefundTransaction(refundTx({ amount }), { ...RAIL });
      assert.equal(v.ok, false, `amount ${amount} must not verify`);
    }
  });

  test('the memo expectation must be declared, not guessed', () => {
    const { memo, ...withoutMemoField } = RAIL;
    const v = verifyRefundTransaction(refundTx(), withoutMemoField);
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'memo_expectation_not_declared');
  });

  test('an unexpected memo is refused when none was declared', () => {
    const v = verifyRefundTransaction(refundTx({ memo: 'anything' }), RAIL);
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'unexpected_memo');
  });

  test('a declared memo must match exactly', () => {
    const expected = { ...RAIL, memo: 'claw:refund:5b00' };
    assert.equal(verifyRefundTransaction(refundTx({ memo: 'claw:refund:5b00' }), expected).ok, true);
    assert.equal(verifyRefundTransaction(refundTx({ memo: 'claw:refund:5b01' }), expected).ok, false);
  });

  test('a refund to the wrong wallet is refused', () => {
    const v = verifyRefundTransaction(refundTx(), {
      ...RAIL, userAta: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    });
    assert.equal(v.ok, false);
  });

  test('a failed transaction never verifies', () => {
    const tx = refundTx();
    tx.meta.err = { InstructionError: [0, 'Custom'] };
    assert.equal(verifyRefundTransaction(tx, RAIL).reason, 'transaction_failed');
  });

  test('two refunds are both reported, never silently reduced to one', async () => {
    // Funding takes the earliest of several matches; a refund must not, because
    // a second match means the money has already left twice.
    const a = refundTx({ slot: 2000 });
    const b = refundTx({ slot: 2100 });
    const matches = await findRefundMatches({
      rows: [{ signature: 'A' }, { signature: 'B' }],
      expected: RAIL,
      getTransaction: (s) => Promise.resolve(s === 'A' ? a : b),
    });
    assert.equal(matches.length, 2, 'a double refund must be visible, not deduplicated');
  });
});

describe('refund crash recovery', () => {
  const base = {
    signature: 'SIG', journalReadable: true, onChain: 'absent',
    currentBlockHeight: 100, lastValidBlockHeight: 200,
  };

  test('an unreadable journal halts: neither resend nor re-sign is safe', () => {
    // The daemon cannot tell "never sent" from "sent and lost". Both available
    // moves can be wrong, so the only correct action is to stop.
    const d = refundRecoveryDecision({ ...base, journalReadable: false });
    assert.equal(d.action, 'halt');
    assert.equal(d.mayResend, false);
    assert.equal(d.maySignNew, false);
  });

  test('a signature still within its blockhash validity is RESENT, never re-signed', () => {
    const d = refundRecoveryDecision(base);
    assert.equal(d.action, 'resend_same');
    assert.equal(d.maySignNew, false, 're-signing here is how a double refund happens');
  });

  test('an expired blockhash makes signing fresh provably safe', () => {
    // Past lastValidBlockHeight no validator will accept those bytes, so a
    // transaction that has not landed can never land.
    const d = refundRecoveryDecision({ ...base, currentBlockHeight: 201 });
    assert.equal(d.action, 'sign_new');
    assert.equal(d.reason, 'blockhash_expired');
  });

  test('the boundary is exclusive: still valid at exactly lastValidBlockHeight', () => {
    assert.equal(refundRecoveryDecision({ ...base, currentBlockHeight: 200 }).action, 'resend_same');
  });

  test('a transaction already on chain is reconciled, not resent', () => {
    const d = refundRecoveryDecision({ ...base, onChain: 'found' });
    assert.equal(d.action, 'reconcile');
    assert.equal(d.mayResend, false);
  });

  test('unknown chain state halts rather than guessing', () => {
    assert.equal(refundRecoveryDecision({ ...base, onChain: 'unknown' }).action, 'halt');
  });

  test('unknown expiry halts even when the chain says absent', () => {
    const d = refundRecoveryDecision({ ...base, lastValidBlockHeight: null });
    assert.equal(d.action, 'halt');
    assert.equal(d.reason, 'expiry_unknown');
  });

  test('a readable journal with no signature is the only provably fresh start', () => {
    const d = refundRecoveryDecision({ ...base, signature: null });
    assert.equal(d.action, 'sign_new');
    assert.equal(d.reason, 'nothing_was_signed');
  });
});
