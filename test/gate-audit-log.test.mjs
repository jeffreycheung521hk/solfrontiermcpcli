// Audit log: chain integrity, tamper detection at every byte, redaction.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

import { AuditLog, verifyChainText, scrubArgs, recordHash, GENESIS } from '../src/gate/audit-log.mjs';
import { createRedactor } from '../src/gate/config.mjs';

let dir;
before(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'sfgate-audit-'));
});
after(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
const fresh = () => path.join(dir, `log-${++n}`, 'audit.jsonl');

function fixedClock() {
  let t = Date.parse('2026-10-10T03:12:45.123Z');
  return () => new Date((t += 1000));
}

describe('AuditLog', () => {
  test('N appends verify; seq = line number; first prev is 64 zeros', () => {
    const file = fresh();
    const log = AuditLog.open(file, { clock: fixedClock() });
    const records = [];
    for (let i = 0; i < 12; i++) records.push(log.append('tool_call', { callId: `c${i}`, n: i, nested: { a: [1, 'x'] } }));
    const text = readFileSync(file, 'utf8');
    const result = verifyChainText(text);
    assert.deepEqual(result, { ok: true, count: 12, lastHash: records[11].hash, lastSeq: 12 });
    assert.equal(records[0].prev, GENESIS);
    assert.equal(records[0].seq, 1);
    const first = JSON.parse(text.split('\n')[0]);
    assert.deepEqual(Object.keys(first).slice(0, 5), ['v', 'seq', 'ts', 'prev', 'type']);
    assert.equal(Object.keys(first).at(-1), 'hash');
    const { hash, ...rest } = first;
    assert.equal(hash, createHash('sha256').update(`${GENESIS}\n${JSON.stringify(rest)}`).digest('hex'));
    assert.equal(recordHash(GENESIS, rest), hash);
  });

  test('re-open continues seq and prev', () => {
    const file = fresh();
    const a = AuditLog.open(file);
    a.append('gate_start', {});
    const last = a.append('gate_stop', {});
    const b = AuditLog.open(file);
    const next = b.append('gate_start', {});
    assert.equal(next.seq, 3);
    assert.equal(next.prev, last.hash);
    assert.equal(verifyChainText(readFileSync(file, 'utf8')).count, 3);
  });

  test('flipping one byte anywhere names that line', () => {
    const file = fresh();
    const log = AuditLog.open(file, { clock: fixedClock() });
    for (let i = 0; i < 4; i++) log.append(i % 2 ? 'tool_result' : 'tool_call', { callId: `c${i}`, ok: i % 2 === 0, v2: null });
    const original = readFileSync(file);
    // Line number of each byte offset (the newline belongs to its line).
    const lineOf = [];
    let line = 1;
    for (const byte of original) {
      lineOf.push(line);
      if (byte === 0x0a) line++;
    }
    for (let offset = 0; offset < original.length; offset++) {
      for (const mask of [0x01, 0x20]) {
        const tampered = Buffer.from(original);
        tampered[offset] ^= mask;
        const result = verifyChainText(tampered.toString('latin1'));
        assert.equal(result.ok, false, `offset ${offset} mask ${mask} went unnoticed`);
        assert.equal(result.firstBadLine, lineOf[offset], `offset ${offset} mask ${mask}: ${result.reason}`);
      }
    }
  });

  test('deleting, reordering or truncating lines is detected', () => {
    const file = fresh();
    const log = AuditLog.open(file);
    for (let i = 0; i < 3; i++) log.append('x', { i });
    const lines = readFileSync(file, 'utf8').split('\n').slice(0, 3);
    assert.equal(verifyChainText(`${lines[0]}\n${lines[2]}\n`).firstBadLine, 2);
    assert.equal(verifyChainText(`${lines[1]}\n${lines[0]}\n`).firstBadLine, 1);
    assert.equal(verifyChainText(`${lines[0]}\n${lines[1]}`).firstBadLine, 2);
    assert.equal(verifyChainText(`${lines[0]}\n\n`).firstBadLine, 2);
    assert.deepEqual(verifyChainText(''), { ok: true, count: 0, lastHash: GENESIS, lastSeq: 0 });
    // Same content, non-canonical whitespace.
    assert.equal(verifyChainText(`${lines[0].replace('{"v":1', '{"v": 1')}\n`).reason, 'not in canonical form');
  });

  test('opening a broken log -> exit 2 naming the first bad line', () => {
    const file = fresh();
    const log = AuditLog.open(file);
    log.append('a', {});
    log.append('b', {});
    const text = readFileSync(file, 'utf8');
    writeFileSync(file, text.replace('"type":"b"', '"type":"c"'));
    assert.throws(() => AuditLog.open(file), (err) => err.exitCode === 2 && /line 2/.test(err.message));
  });

  test('BigInt becomes a decimal string; reserved fields are refused', () => {
    const file = fresh();
    const log = AuditLog.open(file);
    const rec = log.append('tx_review', { lamports: 5000000000n, nested: [1n] });
    assert.equal(rec.lamports, '5000000000');
    assert.deepEqual(rec.nested, ['1']);
    assert.throws(() => log.append('x', { seq: 9 }), /reserved/);
    assert.throws(() => log.append('x', { hash: 'f' }), /reserved/);
    assert.ok(verifyChainText(readFileSync(file, 'utf8')).ok);
  });

  test('secrets are redacted before hashing, in keys and values', () => {
    const file = fresh();
    const apiKey = randomBytes(12).toString('hex');
    const url = ['https://rpc.example.test/?api-key=', apiKey].join('');
    const log = AuditLog.open(file, { redact: createRedactor([url]) });
    log.append('downstream_failed', { error: `fetch ${url} failed`, [apiKey]: 1 });
    const text = readFileSync(file, 'utf8');
    assert.ok(!text.includes(apiKey));
    assert.ok(text.includes('<redacted>'));
    assert.ok(verifyChainText(text).ok);
  });

  test('a record whose serialisation still contains a secret is not written', () => {
    const file = fresh();
    // A redactor that cannot see through JSON escaping: the escaped form
    // survives sanitize() but the final check on the line catches it.
    const needle = 'line1\\nline2-secret';
    const log = AuditLog.open(file, { redact: (t) => t.split(needle).join('<redacted>') });
    assert.throws(() => log.append('x', { s: 'line1\nline2-secret' }), /not written/);
    assert.ok(!existsSync(file) || readFileSync(file, 'utf8') === '');
  });
});

describe('scrubArgs', () => {
  test('strings over 200 chars become { sha256, length }; others pass', () => {
    const long = 'A'.repeat(201);
    const out = scrubArgs({ transaction: long, to: 'short', n: 1, deep: [long], big: 2n, exact: 'B'.repeat(200) });
    assert.deepEqual(out.transaction, { sha256: createHash('sha256').update(long).digest('hex'), length: 201 });
    assert.equal(out.to, 'short');
    assert.equal(out.deep[0].length, 201);
    assert.equal(out.big, '2');
    assert.equal(out.exact.length, 200);
  });
});
