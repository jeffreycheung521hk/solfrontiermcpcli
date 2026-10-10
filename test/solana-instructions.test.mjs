import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { decodeTransaction, resolveAccountKeys } from '../src/solana/tx.mjs';
import { describeInstructions } from '../src/solana/instructions.mjs';
import {
  SYSTEM, TOKEN, TOKEN_2022, ATA, COMPUTE_BUDGET, MEMO, keypair, randomAddress, message,
  transaction, data,
} from './solana-builders.mjs';

/**
 * Build a legacy transaction with `extra` accounts after the payer and the
 * given program ids at the end, decode it end to end, and describe it.
 */
function describe1({ programs, extra = [], instructions, version = 'legacy', lookups, tables }) {
  const payer = keypair();
  const keys = [payer.address, ...extra, ...programs];
  const bytes = transaction(message({
    version, header: [1, 0, programs.length], keys, instructions, lookups,
  }), [payer]);
  const decoded = decodeTransaction(bytes);
  return { payer, ixs: describeInstructions(decoded, resolveAccountKeys(decoded, tables)) };
}

describe('describeInstructions', () => {
  test('System transfer: lamports as BigInt, [from, to]', () => {
    const to = randomAddress();
    const { payer, ixs } = describe1({
      extra: [to], programs: [SYSTEM],
      instructions: [{ p: 2, a: [0, 1], d: data.systemTransfer(18_446_744_073_709_551_615n) }],
    });
    assert.deepEqual(ixs, [{
      index: 0, programId: SYSTEM, program: 'system', kind: 'transfer',
      lamports: 18_446_744_073_709_551_615n, source: payer.address, destination: to,
    }]);
  });

  test('System createAccount', () => {
    const acct = keypair();
    const payer = keypair();
    const bytes = transaction(message({
      header: [2, 0, 1], keys: [payer.address, acct.address, SYSTEM],
      instructions: [{ p: 2, a: [0, 1], d: data.systemCreateAccount(2_039_280n, 165, TOKEN) }],
    }), [payer, acct]);
    const d = decodeTransaction(bytes);
    const [ix] = describeInstructions(d, resolveAccountKeys(d));
    assert.equal(ix.kind, 'createAccount');
    assert.equal(ix.lamports, 2_039_280n);
    assert.equal(ix.source, payer.address);
    assert.equal(ix.destination, acct.address);
  });

  test('SPL transferChecked: [source, mint, destination, authority], amount and decimals', () => {
    const [src, mint, dst] = [randomAddress(), randomAddress(), randomAddress()];
    const { payer, ixs } = describe1({
      extra: [src, dst], programs: [mint, TOKEN],
      instructions: [{ p: 4, a: [1, 3, 2, 0], d: data.splTransferChecked(1_234_567n, 6) }],
    });
    assert.deepEqual(ixs[0], {
      index: 0, programId: TOKEN, program: 'spl-token', kind: 'transferChecked',
      amount: 1_234_567n, decimals: 6, source: src, mint, destination: dst, authority: payer.address,
    });
  });

  test('Token-2022 is recognised as its own program', () => {
    const [src, mint, dst] = [randomAddress(), randomAddress(), randomAddress()];
    const { ixs } = describe1({
      extra: [src, dst], programs: [mint, TOKEN_2022],
      instructions: [{ p: 4, a: [1, 3, 2, 0], d: data.splTransferChecked(5n, 9) }],
    });
    assert.equal(ixs[0].program, 'spl-token-2022');
    assert.equal(ixs[0].kind, 'transferChecked');
    assert.equal(ixs[0].amount, 5n);
  });

  test('SPL approve and approveChecked: delegate and amount', () => {
    const [src, delegate, mint] = [randomAddress(), randomAddress(), randomAddress()];
    const { payer, ixs } = describe1({
      extra: [src], programs: [delegate, mint, TOKEN],
      instructions: [
        { p: 4, a: [1, 2, 0], d: data.splApprove(1_000n) },
        { p: 4, a: [1, 3, 2, 0], d: data.splApproveChecked(2_000n, 6) },
      ],
    });
    assert.deepEqual(ixs[0], {
      index: 0, programId: TOKEN, program: 'spl-token', kind: 'approve',
      amount: 1_000n, source: src, delegate, authority: payer.address,
    });
    assert.equal(ixs[1].kind, 'approveChecked');
    assert.equal(ixs[1].amount, 2_000n);
    assert.equal(ixs[1].decimals, 6);
    assert.equal(ixs[1].mint, mint);
    assert.equal(ixs[1].delegate, delegate);
  });

  test('legacy SPL transfer: [source, destination, authority], no mint', () => {
    const [src, dst] = [randomAddress(), randomAddress()];
    const { payer, ixs } = describe1({
      extra: [src, dst], programs: [TOKEN],
      instructions: [{ p: 3, a: [1, 2, 0], d: data.splTransfer(42n) }],
    });
    assert.deepEqual(ixs[0], {
      index: 0, programId: TOKEN, program: 'spl-token', kind: 'transfer',
      amount: 42n, source: src, destination: dst, authority: payer.address,
    });
    assert.equal(ixs[0].mint, undefined);
  });

  test('setAuthority, closeAccount, syncNative', () => {
    const [acct, newOwner] = [randomAddress(), randomAddress()];
    const { payer, ixs } = describe1({
      extra: [acct], programs: [TOKEN],
      instructions: [
        { p: 2, a: [1, 0], d: data.splSetAuthority(2, newOwner) },
        { p: 2, a: [1, 0], d: data.splSetAuthority(3, null) },
        { p: 2, a: [1, 0, 0], d: data.splCloseAccount() },
        { p: 2, a: [1], d: data.splSyncNative() },
      ],
    });
    assert.deepEqual(ixs.map((i) => i.kind), ['setAuthority', 'setAuthority', 'closeAccount', 'syncNative']);
    assert.equal(ixs[0].authorityType, 'accountOwner');
    assert.equal(ixs[0].newAuthority, newOwner);
    assert.equal(ixs[0].source, acct);
    assert.equal(ixs[0].authority, payer.address);
    assert.equal(ixs[1].authorityType, 'closeAccount');
    assert.equal(ixs[1].newAuthority, null);
    assert.equal(ixs[2].destination, payer.address);
    assert.equal(ixs[3].source, acct);
  });

  test('ATA create and createIdempotent', () => {
    const [ata, owner, mint] = [randomAddress(), randomAddress(), randomAddress()];
    const { payer, ixs } = describe1({
      extra: [ata], programs: [owner, mint, SYSTEM, TOKEN, ATA],
      instructions: [
        { p: 6, a: [0, 1, 2, 3, 4, 5], d: data.ataCreate() },
        { p: 6, a: [0, 1, 2, 3, 4, 5], d: data.ataCreateIdempotent() },
      ],
    });
    assert.deepEqual(ixs.map((i) => [i.program, i.kind]), [['ata', 'create'], ['ata', 'createIdempotent']]);
    assert.deepEqual(
      { source: ixs[1].source, destination: ixs[1].destination, authority: ixs[1].authority, mint: ixs[1].mint },
      { source: payer.address, destination: ata, authority: owner, mint },
    );
  });

  test('compute budget pair and memo', () => {
    const { ixs } = describe1({
      programs: [COMPUTE_BUDGET, MEMO],
      instructions: [
        { p: 1, a: [], d: data.computeUnitLimit(200_000) },
        { p: 1, a: [], d: data.computeUnitPrice(50_000n) },
        { p: 2, a: [], d: data.memo('order 42 · ok') },
      ],
    });
    assert.deepEqual(ixs[0], { index: 0, programId: COMPUTE_BUDGET, program: 'compute-budget', kind: 'setComputeUnitLimit', units: 200_000 });
    assert.deepEqual(ixs[1], { index: 1, programId: COMPUTE_BUDGET, program: 'compute-budget', kind: 'setComputeUnitPrice', microLamports: 50_000n });
    assert.deepEqual(ixs[2], { index: 2, programId: MEMO, program: 'memo', kind: 'memo', text: 'order 42 · ok' });
  });

  test('accounts from a lookup table are resolved into the description', () => {
    const tableKey = randomAddress();
    const table = [randomAddress(), randomAddress()];
    const { payer, ixs } = describe1({
      version: 0, programs: [SYSTEM],
      instructions: [{ p: 1, a: [0, 2], d: data.systemTransfer(7n) }],
      lookups: [{ key: tableKey, w: [1], r: [] }],
      tables: new Map([[tableKey, table]]),
    });
    assert.equal(ixs[0].source, payer.address);
    assert.equal(ixs[0].destination, table[1]);
  });

  test('unknown program and unknown tags are kind "unknown" without amounts', () => {
    const prog = randomAddress();
    const { ixs } = describe1({
      programs: [prog, TOKEN, SYSTEM],
      instructions: [
        { p: 1, a: [0], d: [3, 1, 2, 3, 4, 5, 6, 7, 8] },
        { p: 2, a: [], d: [250] },
        { p: 3, a: [], d: [...data.systemTransfer(1n).slice(0, 4).map((b, i) => (i === 0 ? 99 : b))] },
      ],
    });
    assert.deepEqual(ixs.map((i) => [i.program, i.kind]), [['unknown', 'unknown'], ['spl-token', 'unknown'], ['system', 'unknown']]);
    assert.ok(ixs.every((i) => i.amount === undefined && i.lamports === undefined));
  });

  test('truncated data or missing accounts of a known instruction throw', () => {
    const to = randomAddress();
    const run = (instructions, programs = [SYSTEM]) => () => describe1({ extra: [to], programs, instructions });
    assert.throws(run([{ p: 2, a: [0, 1], d: data.systemTransfer(1n).slice(0, 11) }]), /data too short/);
    assert.throws(run([{ p: 2, a: [0], d: data.systemTransfer(1n) }]), /needs 2 accounts/);
    assert.throws(run([{ p: 2, a: [1, 0], d: data.splTransferChecked(1n, 6).slice(0, 9) }], [TOKEN]), /data too short/);
    assert.throws(run([{ p: 2, a: [], d: [0xff, 0xfe] }], [MEMO]), /UTF-8/);
    assert.throws(run([{ p: 2, a: [], d: [2, 1, 0] }], [COMPUTE_BUDGET]), /data too short/);
  });
});
