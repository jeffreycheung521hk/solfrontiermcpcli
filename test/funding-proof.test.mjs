// Regressions for the funding proof, driven by the real 2026-08-02 payload.
//
// On that date a correct, on-time funding transaction was ignored and 0.2
// USDC was stranded. Two defects combined: detection accepted "any new
// successful signature", and a prefilter compared the RPC's memo SUMMARY
// (formatted "[byte_len] memo") for exact equality, blacklisting the one
// transaction that mattered before the validator ever saw it.
//
// These tests drive the real captured signature row -- prefix and all --
// through selection, fetch and validation. A reintroduced memo prefilter
// fails them; validator-only tests would not.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  selectCandidateSignatures,
  verifyFundingTransaction,
  findFundingMatches,
  ataTokenDelta,
  outerMemoTexts,
  MEMO_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '../src/solana/funding-proof.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FIXTURE = path.join(ROOT, 'scripts', 'demo', 'fixtures', 'funding-20260802.json');
const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'));

const MEMO =
  'claw:w5h:58000000400d0300000000009a62dace:711e70b5cb235df2b16c494ab8a21bb0c22bfce27a885b08ad41845c81368d10';
const EXPECTED = {
  memo: MEMO,
  amountRaw: '200000',
  userWallet: 'C4QQjzWxnJ5QFAbkzhQJ3wTzyX6nw1vyFvJwbPXJGPNW',
  userAta: '4bDArC4UVoBjecHUZaCKqhuhTYPoiKS4qpQQpxuvm1qn',
  controlledWallet: 'BPfDMmeMBmCbMC1rWh7hwigMBoKGBrKwXxSeUu9hhs5L',
  controlledAta: '7LFdKcSV7JQYi3or5y9phHVPjhGigu5DDjUakAFbBmk3',
  mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  decimals: 6,
};

/** Deep clone so a mutation in one test cannot leak into another. */
const clone = (v) => JSON.parse(JSON.stringify(v));

describe('the real 2026-08-02 payload', () => {
  test('the fixture still carries the length-prefixed RPC memo summary', () => {
    // If this ever stops holding, the regression below has quietly stopped
    // reproducing the conditions that caused the loss.
    assert.equal(fixture.row.memo, `[${MEMO.length}] ${MEMO}`);
    assert.notEqual(fixture.row.memo, MEMO);
  });

  test('selection keeps the real row despite its memo summary', () => {
    const selected = selectCandidateSignatures([fixture.row]);
    assert.deepEqual(selected, [fixture.signature]);
  });

  test('validation proves the real transaction', () => {
    const result = verifyFundingTransaction(fixture.transaction, EXPECTED);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.proof.controlledDelta, '200000');
    assert.equal(result.proof.userDelta, '-200000');
    assert.equal(result.proof.memo, MEMO);
    assert.equal(result.proof.slot, 436774687);
  });

  test('the full path selects, fetches and matches it', async () => {
    const fetched = [];
    const matches = await findFundingMatches({
      rows: [fixture.row],
      expected: EXPECTED,
      getTransaction: async (sig) => {
        fetched.push(sig);
        return sig === fixture.signature ? fixture.transaction : null;
      },
    });
    assert.deepEqual(fetched, [fixture.signature], 'the real signature was never fetched');
    assert.equal(matches.length, 1);
    assert.equal(matches[0].signature, fixture.signature);
  });

  test('balances bind to the pinned ATAs by accountIndex', () => {
    const controlled = ataTokenDelta(
      fixture.transaction, EXPECTED.controlledAta, EXPECTED.controlledWallet, EXPECTED.mint, 6,
    );
    assert.equal(controlled.accountIndex, 2);
    assert.equal(controlled.pre, 1053487n);
    assert.equal(controlled.post, 1253487n);
    const user = ataTokenDelta(fixture.transaction, EXPECTED.userAta, EXPECTED.userWallet, EXPECTED.mint, 6);
    assert.equal(user.accountIndex, 1);
    assert.equal(user.delta, -200000n);
  });

  test('the outer memo comes from the instruction, unprefixed', () => {
    assert.deepEqual(outerMemoTexts(fixture.transaction), [MEMO]);
  });

  test('a foreign memo is rejected and the signature is recorded as seen', async () => {
    const seen = new Set();
    const matches = await findFundingMatches({
      rows: [fixture.row],
      expected: { ...EXPECTED, memo: MEMO.replace('58000000', '5a000000') },
      seen,
      getTransaction: async () => fixture.transaction,
    });
    assert.equal(matches.length, 0);
    assert.ok(seen.has(fixture.signature));
  });
});

describe('an old payment cannot satisfy a new intent', () => {
  // Intent ids are deterministic from (threshold_bps, amount_raw), so
  // re-running the same parameters produces the same memo. The server checks
  // only that a payment is not too LATE; it has no lower bound. Without a
  // slot floor the previous run's transaction is a perfect forgery of this
  // run's, and it is already on chain.
  const SLOT = 436774687;

  test('the real transaction is rejected when it predates the intent', () => {
    const r = verifyFundingTransaction(fixture.transaction, { ...EXPECTED, notBeforeSlot: SLOT });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'predates_intent');
  });

  test('a transaction in the same slot as the floor is rejected', () => {
    const r = verifyFundingTransaction(fixture.transaction, { ...EXPECTED, notBeforeSlot: SLOT - 1 + 1 });
    assert.equal(r.reason, 'predates_intent');
  });

  test('a transaction after the floor is accepted', () => {
    const r = verifyFundingTransaction(fixture.transaction, { ...EXPECTED, notBeforeSlot: SLOT - 1 });
    assert.equal(r.ok, true, JSON.stringify(r));
  });

  test('the floor defeats a replay that the signature baseline misses', async () => {
    // The baseline was 25 deep while the search scanned 100. Model an
    // identical pre-run payment ranked beyond the baseline's depth: the
    // baseline cannot exclude it, so the slot floor must.
    const shallowBaseline = new Set(['some-other-signature']);
    const withoutFloor = await findFundingMatches({
      rows: [fixture.row],
      expected: EXPECTED,
      baseline: shallowBaseline,
      getTransaction: async () => fixture.transaction,
    });
    assert.equal(withoutFloor.length, 1, 'precondition: the baseline does not exclude it');

    const withFloor = await findFundingMatches({
      rows: [fixture.row],
      expected: { ...EXPECTED, notBeforeSlot: SLOT },
      baseline: shallowBaseline,
      getTransaction: async () => fixture.transaction,
    });
    assert.equal(withFloor.length, 0, 'the slot floor must reject a payment older than the intent');
  });

  test('a transaction with no slot is rejected when a floor is set', () => {
    const tx = clone(fixture.transaction);
    delete tx.slot;
    assert.equal(verifyFundingTransaction(tx, { ...EXPECTED, notBeforeSlot: 1 }).reason, 'no_slot');
  });
});

describe('selection excludes only what is provably irrelevant', () => {
  test('honours the baseline', () => {
    const s = selectCandidateSignatures([fixture.row], new Set([fixture.signature]));
    assert.deepEqual(s, []);
  });

  test('honours the seen set', () => {
    const s = selectCandidateSignatures([fixture.row], new Set(), new Set([fixture.signature]));
    assert.deepEqual(s, []);
  });

  test('drops transactions that failed on chain', () => {
    const s = selectCandidateSignatures([{ ...fixture.row, err: { InstructionError: [0, 'Custom'] } }]);
    assert.deepEqual(s, []);
  });

  test('never judges memo content', () => {
    for (const memo of [null, '', 'unrelated', `[3] abc`, `${MEMO}; other`]) {
      const s = selectCandidateSignatures([{ ...fixture.row, memo }]);
      assert.deepEqual(s, [fixture.signature], `selection judged memo ${JSON.stringify(memo)}`);
    }
  });

  test('a signature that is not yet visible is retried, not blacklisted', async () => {
    const seen = new Set();
    const matches = await findFundingMatches({
      rows: [{ signature: 'NotYetVisible', err: null }],
      expected: EXPECTED,
      seen,
      getTransaction: async () => null,
    });
    assert.equal(matches.length, 0);
    assert.equal(seen.size, 0, 'an unfetchable signature must stay eligible for the next pass');
  });
});

describe('validation rejects near misses', () => {
  const reasons = (mutate) => {
    const tx = clone(fixture.transaction);
    mutate(tx);
    return verifyFundingTransaction(tx, EXPECTED);
  };

  test('an on-chain error', () => {
    assert.equal(reasons((tx) => { tx.meta.err = { InstructionError: [0, 'Custom'] }; }).reason, 'on_chain_error');
  });

  test('the payer did not sign', () => {
    assert.equal(reasons((tx) => { tx.transaction.message.accountKeys[0].signer = false; }).reason, 'payer_did_not_sign');
  });

  test('a length-prefixed memo in the instruction is a different memo', () => {
    const r = reasons((tx) => {
      const ix = tx.transaction.message.instructions.find((i) => i.programId === MEMO_PROGRAM_ID);
      ix.parsed = `[${MEMO.length}] ${MEMO}`;
    });
    assert.equal(r.reason, 'memo_mismatch');
  });

  test('an extra memo, in either position', () => {
    const before = reasons((tx) => {
      tx.transaction.message.instructions.unshift({ programId: MEMO_PROGRAM_ID, parsed: 'unrelated' });
    });
    assert.equal(before.reason, 'multiple_outer_memos');
    const after = reasons((tx) => {
      tx.transaction.message.instructions.push({ programId: MEMO_PROGRAM_ID, parsed: 'unrelated' });
    });
    assert.equal(after.reason, 'multiple_outer_memos');
  });

  test('a superset memo', () => {
    const r = reasons((tx) => {
      const ix = tx.transaction.message.instructions.find((i) => i.programId === MEMO_PROGRAM_ID);
      ix.parsed = `${MEMO}:extra`;
    });
    assert.equal(r.reason, 'memo_mismatch');
  });

  test('wrong destination, authority, amount and decimals', () => {
    const info = () => clone(fixture.transaction).transaction.message.instructions.find(
      (i) => i.programId === TOKEN_PROGRAM_ID,
    );
    assert.ok(info(), 'fixture has a transferChecked instruction');
    assert.equal(reasons((tx) => {
      tx.transaction.message.instructions.find((i) => i.programId === TOKEN_PROGRAM_ID).parsed.info.destination = EXPECTED.userAta;
    }).reason, 'wrong_destination');
    assert.equal(reasons((tx) => {
      tx.transaction.message.instructions.find((i) => i.programId === TOKEN_PROGRAM_ID).parsed.info.authority = EXPECTED.controlledWallet;
    }).reason, 'wrong_authority');
    assert.equal(reasons((tx) => {
      tx.transaction.message.instructions.find((i) => i.programId === TOKEN_PROGRAM_ID).parsed.info.tokenAmount.amount = '199999';
    }).reason, 'wrong_amount');
    assert.equal(reasons((tx) => {
      tx.transaction.message.instructions.find((i) => i.programId === TOKEN_PROGRAM_ID).parsed.info.tokenAmount.decimals = 9;
    }).reason, 'wrong_decimals');
  });

  test('a decoy token account for the same owner and mint does not fool it', () => {
    // Placed first, so an owner+mint first-match implementation reads it.
    const r = reasons((tx) => {
      tx.transaction.message.accountKeys.push({ pubkey: 'DecoyAta1111111111111111111111111111111111', signer: false });
      const decoyIndex = tx.transaction.message.accountKeys.length - 1;
      const decoy = {
        accountIndex: decoyIndex,
        owner: EXPECTED.controlledWallet,
        mint: EXPECTED.mint,
        uiTokenAmount: { amount: '999', decimals: 6 },
      };
      tx.meta.preTokenBalances.unshift(decoy);
      tx.meta.postTokenBalances.unshift({ ...decoy });
    });
    assert.equal(r.ok, true, JSON.stringify(r));
  });

  test('a missing post-balance row is fatal, not read as zero', () => {
    const r = reasons((tx) => {
      tx.meta.postTokenBalances = tx.meta.postTokenBalances.filter((b) => b.accountIndex !== 2);
    });
    assert.equal(r.reason, 'controlled_balance_unprovable');
  });

  test('a missing pre-balance row means the ATA was created in this transaction', () => {
    // Removing the controlled pre row makes its prior balance zero, so the
    // delta becomes the full post balance and no longer equals the amount.
    const r = reasons((tx) => {
      tx.meta.preTokenBalances = tx.meta.preTokenBalances.filter((b) => b.accountIndex !== 2);
    });
    assert.equal(r.reason, 'controlled_delta_mismatch');
  });

  test('a credit without the matching debit from the registered payer', () => {
    const r = reasons((tx) => {
      const row = tx.meta.postTokenBalances.find((b) => b.accountIndex === 1);
      row.uiTokenAmount.amount = '1650000'; // user never actually paid
    });
    assert.equal(r.reason, 'user_delta_mismatch');
  });

  test('a balance row whose owner does not match the pinned wallet', () => {
    const r = reasons((tx) => {
      tx.meta.postTokenBalances.find((b) => b.accountIndex === 2).owner = EXPECTED.userWallet;
    });
    assert.equal(r.reason, 'controlled_balance_unprovable');
  });
});
