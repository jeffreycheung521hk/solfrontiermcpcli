import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { encode, decode, decodePublicKey } from '../src/solana/base58.mjs';

describe('base58', () => {
  test('the System program id is 32 zero bytes, both ways', () => {
    const sys = '11111111111111111111111111111111';
    assert.deepEqual(decode(sys), new Uint8Array(32));
    assert.equal(encode(new Uint8Array(32)), sys);
  });

  test('known vectors', () => {
    assert.equal(encode(new TextEncoder().encode('Hello World!')), '2NEpo7TZRRrLZSi2U');
    assert.equal(encode(Uint8Array.from([0, 0, 0x28, 0x7f, 0xb4, 0xcd])), '11233QC4');
    assert.equal(encode(new Uint8Array(0)), '');
    assert.deepEqual(decode(''), new Uint8Array(0));
    assert.equal(encode(Uint8Array.from([0])), '1');
    assert.equal(encode(Uint8Array.from([57])), 'z');
    assert.equal(encode(Uint8Array.from([58])), '21');
  });

  test('random round trips, including leading zero bytes', () => {
    for (let i = 0; i < 200; i++) {
      const lead = i % 5;
      const body = randomBytes(i % 70);
      const bytes = new Uint8Array(lead + body.length);
      bytes.set(body, lead);
      const text = encode(bytes);
      assert.deepEqual(decode(text), bytes);
      assert.equal(encode(decode(text)), text);
    }
  });

  test('invalid characters throw', () => {
    for (const bad of ['0', 'O', 'I', 'l', '1 1', 'abc!', 'ab\n', '+/=']) {
      assert.throws(() => decode(bad), /invalid base58/, bad);
    }
    assert.throws(() => decode(42), TypeError);
    assert.throws(() => encode('abc'), TypeError);
  });

  test('decodePublicKey insists on 32 bytes', () => {
    const key = randomBytes(32);
    assert.deepEqual(decodePublicKey(encode(key)), new Uint8Array(key));
    assert.throws(() => decodePublicKey(encode(randomBytes(31))), /32-byte/);
    assert.throws(() => decodePublicKey('2NEpo7TZRRrLZSi2U'), /32-byte/);
  });
});
