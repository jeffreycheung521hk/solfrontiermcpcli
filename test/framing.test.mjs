// Property-based tests for the framing layer.
//
// The invariant: however the byte stream is chopped up, the frames that come
// out must be exactly the frames that went in. Chunk boundaries are chosen by
// the OS, so this is not a hypothetical — it is the single most likely place
// for a bug that only appears under load, on someone else's machine.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { LineFramer } from '../src/mcp/framing.mjs';

/** Deterministic PRNG so a failure is always reproducible from its seed. */
function makeRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function splitBuffer(buffer, random, maxPieces) {
  const cuts = new Set();
  const pieces = 1 + Math.floor(random() * maxPieces);
  for (let i = 0; i < pieces; i++) cuts.add(Math.floor(random() * (buffer.length + 1)));
  const points = [0, ...[...cuts].sort((a, b) => a - b), buffer.length];
  const chunks = [];
  for (let i = 0; i < points.length - 1; i++) {
    if (points[i + 1] > points[i]) chunks.push(buffer.subarray(points[i], points[i + 1]));
  }
  return chunks;
}

describe('LineFramer invariants', () => {
  test('frames survive every possible chunk boundary (200 randomized splits)', () => {
    const messages = [
      JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, result: { text: 'café ☕ 日本語 🚀' } }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
      JSON.stringify({ jsonrpc: '2.0', id: 3, result: { big: 'x'.repeat(500) } }),
    ];
    const stream = Buffer.from(messages.join('\n') + '\n', 'utf8');

    for (let seed = 1; seed <= 200; seed++) {
      const random = makeRandom(seed);
      const framer = new LineFramer();
      const out = [];
      for (const chunk of splitBuffer(stream, random, 40)) out.push(...framer.push(chunk));
      assert.deepEqual(out, messages, `chunking with seed ${seed} changed the frames`);
      assert.equal(framer.pending, '', `seed ${seed} left data buffered`);
    }
  });

  test('a multi-byte character split across chunks is not corrupted', () => {
    // The emoji is 4 bytes; cut it in half deliberately.
    const line = JSON.stringify({ text: '🚀' }) + '\n';
    const buf = Buffer.from(line, 'utf8');
    const emojiStart = buf.indexOf(Buffer.from('🚀', 'utf8'));

    const framer = new LineFramer();
    const out = [
      ...framer.push(buf.subarray(0, emojiStart + 2)), // mid-character
      ...framer.push(buf.subarray(emojiStart + 2)),
    ];
    assert.equal(out.length, 1);
    assert.equal(JSON.parse(out[0]).text, '🚀');
    assert.ok(!out[0].includes('�'), 'no replacement characters');
  });

  test('byte-at-a-time delivery still reconstructs every frame', () => {
    const messages = [JSON.stringify({ a: 'ünïcødé' }), JSON.stringify({ b: 2 })];
    const buf = Buffer.from(messages.join('\n') + '\n', 'utf8');
    const framer = new LineFramer();
    const out = [];
    for (const byte of buf) out.push(...framer.push(Buffer.from([byte])));
    assert.deepEqual(out, messages);
  });

  test('CRLF line endings are normalized away', () => {
    const framer = new LineFramer();
    assert.deepEqual(framer.push('{"a":1}\r\n{"b":2}\r\n'), ['{"a":1}', '{"b":2}']);
  });

  test('blank and whitespace-only lines are not frames', () => {
    const framer = new LineFramer();
    assert.deepEqual(framer.push('\n   \n{"a":1}\n\n'), ['{"a":1}']);
  });

  test('an unterminated final line stays pending, never half-emitted', () => {
    const framer = new LineFramer();
    assert.deepEqual(framer.push('{"a":1}\n{"b":'), ['{"a":1}']);
    assert.equal(framer.pending, '{"b":');
    assert.deepEqual(framer.push('2}\n'), ['{"b":2}']);
  });

  test('a frame far larger than any chunk is reassembled intact', () => {
    const big = JSON.stringify({ payload: 'y'.repeat(100000) });
    const buf = Buffer.from(big + '\n', 'utf8');
    const framer = new LineFramer();
    const out = [];
    for (let i = 0; i < buf.length; i += 997) out.push(...framer.push(buf.subarray(i, i + 997)));
    assert.deepEqual(out, [big]);
  });
});
