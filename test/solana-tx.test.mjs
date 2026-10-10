import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  decodeTransaction, messageSha256, resolveAccountKeys, verifySignatures,
} from '../src/solana/tx.mjs';
import { parseLookupTable, fetchLookupTables } from '../src/solana/alt.mjs';
import {
  SYSTEM, TOKEN, ALT_PROGRAM, keypair, randomAddress, message, transaction, data,
  lookupTableData, rpcAccount,
} from './solana-builders.mjs';

function legacyTransfer() {
  const payer = keypair();
  const to = randomAddress();
  const blockhash = randomAddress();
  const msg = message({
    header: [1, 0, 1],
    keys: [payer.address, to, SYSTEM],
    blockhash,
    instructions: [{ p: 2, a: [0, 1], d: data.systemTransfer(1_000_000n) }],
  });
  return { payer, to, blockhash, msg, bytes: transaction(msg, [payer]) };
}

function v0WithLookup() {
  const payer = keypair();
  const cosigner = keypair(); // readonly signer
  const writableStatic = randomAddress();
  const tableKey = randomAddress();
  const table = Array.from({ length: 6 }, randomAddress);
  const msg = message({
    version: 0,
    header: [2, 1, 1],
    keys: [payer.address, cosigner.address, writableStatic, TOKEN],
    instructions: [{ p: 3, a: [0, 1, 2, 4, 5, 6, 7], d: [1, 2, 3] }],
    lookups: [{ key: tableKey, w: [3, 1], r: [5, 0] }],
  });
  return {
    payer, cosigner, writableStatic, tableKey, table, msg,
    bytes: transaction(msg, [payer, cosigner]),
  };
}

describe('decodeTransaction', () => {
  test('legacy System transfer decodes to what was encoded', () => {
    const v = legacyTransfer();
    const d = decodeTransaction(v.bytes);
    assert.equal(d.version, 'legacy');
    assert.deepEqual(d.header, { numRequiredSignatures: 1, numReadonlySigned: 0, numReadonlyUnsigned: 1 });
    assert.deepEqual(d.staticAccountKeys, [v.payer.address, v.to, SYSTEM]);
    assert.equal(d.recentBlockhash, v.blockhash);
    assert.equal(d.signatures.length, 1);
    assert.equal(d.instructions.length, 1);
    assert.equal(d.instructions[0].programIdIndex, 2);
    assert.deepEqual(d.instructions[0].accountIndexes, [0, 1]);
    assert.deepEqual([...d.instructions[0].data], data.systemTransfer(1_000_000n));
    assert.deepEqual(d.addressTableLookups, []);
    assert.deepEqual(d.messageBytes, v.msg);
  });

  test('v0 with one lookup table (writable + readonly lookups)', () => {
    const v = v0WithLookup();
    const d = decodeTransaction(v.bytes);
    assert.equal(d.version, 0);
    assert.deepEqual(d.header, { numRequiredSignatures: 2, numReadonlySigned: 1, numReadonlyUnsigned: 1 });
    assert.deepEqual(d.addressTableLookups, [{ accountKey: v.tableKey, writableIndexes: [3, 1], readonlyIndexes: [5, 0] }]);
    assert.deepEqual(d.instructions[0].accountIndexes, [0, 1, 2, 4, 5, 6, 7]);
    assert.deepEqual(d.messageBytes, v.msg);
  });

  test('accepts a Buffer and a subarray view', () => {
    const v = legacyTransfer();
    const padded = new Uint8Array(v.bytes.length + 10);
    padded.set(v.bytes, 5);
    const view = padded.subarray(5, 5 + v.bytes.length);
    assert.deepEqual(decodeTransaction(view).messageBytes, v.msg);
    assert.deepEqual(decodeTransaction(Buffer.from(v.bytes)).messageBytes, v.msg);
  });

  test('rejects malformed input', () => {
    const v = legacyTransfer();
    const bad = (bytes, re) => assert.throws(() => decodeTransaction(bytes), re);
    bad('not bytes', TypeError);
    bad(new Uint8Array(0), /truncated/);
    bad(v.bytes.subarray(0, v.bytes.length - 1), /truncated/);
    bad(Uint8Array.from([...v.bytes, 0]), /trailing/);
    // overlong shortvec: 1 encoded as 0x81 0x00
    bad(Uint8Array.from([0x81, 0x00, ...v.bytes.subarray(1)]), /overlong/);
    bad(Uint8Array.from([0xff, 0xff, 0xff, 0x01]), /longer than 3|out of range/);
    bad(Uint8Array.from([0xff, 0xff, 0x7f]), /out of range/);
    // signature count must equal numRequiredSignatures
    bad(transaction(v.msg, [v.payer, v.payer]), /requires 1 signature/);
    // unsupported version
    const v1 = Uint8Array.from(v.msg);
    const versioned = Uint8Array.from([0x81, ...v1]);
    bad(transaction(versioned, [v.payer]), /unsupported transaction version 1/);
  });

  test('rejects structural violations the runtime would refuse', () => {
    const p = keypair();
    const a = randomAddress();
    const tx = (m) => transaction(message(m), [p]);
    const bad = (m, re) => assert.throws(() => decodeTransaction(tx(m)), re);
    bad({ header: [1, 0, 1], keys: [p.address, a, SYSTEM], instructions: [{ p: 2, a: [0, 3], d: [] }] }, /account index 3 out of range/);
    bad({ header: [1, 0, 1], keys: [p.address, a, SYSTEM], instructions: [{ p: 5, a: [], d: [] }] }, /program id index out of range/);
    bad({ header: [1, 0, 0], keys: [p.address, a], instructions: [{ p: 0, a: [], d: [] }] }, /fee payer cannot be a program/);
    bad({ header: [1, 1, 0], keys: [p.address, a], instructions: [] }, /writable signer/);
    bad({ header: [1, 0, 3], keys: [p.address, a], instructions: [] }, /exceed/);
    bad({ header: [1, 0, 0], keys: [p.address, a, a], instructions: [] }, /duplicate/);
    // program id living in a lookup table
    bad({
      version: 0, header: [1, 0, 0], keys: [p.address, a], instructions: [{ p: 2, a: [], d: [] }],
      lookups: [{ key: randomAddress(), w: [], r: [0] }],
    }, /lookup table/);
    bad({
      version: 0, header: [1, 0, 0], keys: [p.address, a], instructions: [],
      lookups: [{ key: randomAddress(), w: [], r: [] }],
    }, /empty address table lookup/);
  });
});

describe('messageSha256', () => {
  test('stable, and changes when any message byte changes', () => {
    const v = legacyTransfer();
    const d = decodeTransaction(v.bytes);
    const h = messageSha256(d);
    assert.match(h, /^[0-9a-f]{64}$/);
    assert.equal(messageSha256(decodeTransaction(v.bytes)), h);
    // Signatures are not part of the message.
    assert.equal(messageSha256(decodeTransaction(transaction(v.msg, [null]))), h);
    for (let i = 0; i < v.msg.length; i++) {
      const m = Uint8Array.from(v.msg);
      m[i] ^= 0x01;
      assert.notEqual(messageSha256({ messageBytes: m }), h, `byte ${i}`);
    }
  });
});

describe('verifySignatures', () => {
  test('valid', () => {
    const v = v0WithLookup();
    assert.deepEqual(verifySignatures(decodeTransaction(v.bytes)), { complete: true, valid: [true, true] });
  });

  test('tampered message', () => {
    const v = legacyTransfer();
    const bytes = Uint8Array.from(v.bytes);
    bytes[bytes.length - 1] ^= 0xff; // last byte of the transfer amount
    assert.deepEqual(verifySignatures(decodeTransaction(bytes)), { complete: false, valid: [false] });
  });

  test('signature by the wrong key', () => {
    const v = legacyTransfer();
    const other = keypair();
    assert.deepEqual(verifySignatures(decodeTransaction(transaction(v.msg, [other]))), { complete: false, valid: [false] });
  });

  test('missing (all-zero) signature', () => {
    const v = v0WithLookup();
    const d = decodeTransaction(transaction(v.msg, [v.payer, null]));
    assert.deepEqual(verifySignatures(d), { complete: false, valid: [true, false] });
  });
});

describe('resolveAccountKeys', () => {
  test('legacy: static keys and header writability', () => {
    const v = legacyTransfer();
    const r = resolveAccountKeys(decodeTransaction(v.bytes));
    assert.deepEqual(r.keys, [v.payer.address, v.to, SYSTEM]);
    assert.deepEqual(r.signer, [true, false, false]);
    assert.deepEqual(r.writable, [true, true, false]);
  });

  test('v0: static, then writable lookups, then readonly lookups', () => {
    const v = v0WithLookup();
    const r = resolveAccountKeys(decodeTransaction(v.bytes), new Map([[v.tableKey, v.table]]));
    assert.deepEqual(r.keys, [
      v.payer.address, v.cosigner.address, v.writableStatic, TOKEN,
      v.table[3], v.table[1], v.table[5], v.table[0],
    ]);
    assert.deepEqual(r.signer, [true, true, false, false, false, false, false, false]);
    // payer writable signer; cosigner readonly signer; writableStatic writable;
    // TOKEN readonly unsigned; two writable lookups; two readonly lookups.
    assert.deepEqual(r.writable, [true, false, true, false, true, true, false, false]);
  });

  test('two lookup tables: all writables of both precede all readonlys', () => {
    const p = keypair();
    const t1 = randomAddress();
    const t2 = randomAddress();
    const a = Array.from({ length: 3 }, randomAddress);
    const b = Array.from({ length: 3 }, randomAddress);
    const d = decodeTransaction(transaction(message({
      version: 0, header: [1, 0, 0], keys: [p.address], instructions: [],
      lookups: [{ key: t1, w: [0], r: [1] }, { key: t2, w: [2], r: [0] }],
    }), [p]));
    const r = resolveAccountKeys(d, new Map([[t1, a], [t2, b]]));
    assert.deepEqual(r.keys, [p.address, a[0], b[2], a[1], b[0]]);
    assert.deepEqual(r.writable, [true, true, true, false, false]);
  });

  test('missing table or index past the end throws', () => {
    const v = v0WithLookup();
    const d = decodeTransaction(v.bytes);
    assert.throws(() => resolveAccountKeys(d), /not provided/);
    assert.throws(() => resolveAccountKeys(d, new Map([[v.tableKey, v.table.slice(0, 4)]])), /no index 5/);
  });
});

describe('address lookup tables', () => {
  test('parseLookupTable reads the keys after the 56-byte meta', () => {
    const keys = Array.from({ length: 4 }, randomAddress);
    assert.deepEqual(parseLookupTable(lookupTableData(keys)), keys);
    assert.deepEqual(parseLookupTable(lookupTableData([])), []);
  });

  test('parseLookupTable rejects malformed data', () => {
    assert.throws(() => parseLookupTable(new Uint8Array(55)), /too short/);
    assert.throws(() => parseLookupTable(new Uint8Array(57)), /whole number/);
    const uninit = lookupTableData([randomAddress()]);
    uninit[0] = 0;
    assert.throws(() => parseLookupTable(uninit), /not an initialized/);
  });

  test('fetchLookupTables uses getMultipleAccounts base64 and checks the owner', async () => {
    const t1 = randomAddress();
    const t2 = randomAddress();
    const k1 = [randomAddress(), randomAddress()];
    const k2 = [randomAddress()];
    const calls = [];
    const rpc = {
      async call(method, params) {
        calls.push({ method, params });
        return { context: { slot: 1 }, value: [
          rpcAccount({ owner: ALT_PROGRAM, data: lookupTableData(k1) }),
          rpcAccount({ owner: ALT_PROGRAM, data: lookupTableData(k2) }),
        ] };
      },
    };
    const tables = await fetchLookupTables(rpc, [t1, t2, t1]);
    assert.deepEqual([...tables.entries()], [[t1, k1], [t2, k2]]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'getMultipleAccounts');
    assert.deepEqual(calls[0].params[0], [t1, t2]);
    assert.equal(calls[0].params[1].encoding, 'base64');

    const none = await fetchLookupTables({ call: () => assert.fail('no rpc for no tables') }, []);
    assert.equal(none.size, 0);
  });

  test('fetchLookupTables fails closed', async () => {
    const t = randomAddress();
    const reply = (value) => ({ call: async () => ({ value }) });
    await assert.rejects(fetchLookupTables(reply([null]), [t]), /does not exist/);
    await assert.rejects(fetchLookupTables(reply([rpcAccount({ owner: SYSTEM, data: lookupTableData([]) })]), [t]), /not owned/);
    await assert.rejects(fetchLookupTables(reply([]), [t]), /malformed/);
    await assert.rejects(fetchLookupTables({ call: async () => { throw new Error('boom'); } }, [t]), /boom/);
    await assert.rejects(fetchLookupTables(reply([]), ['not-base58!']), /base58/);
  });
});
