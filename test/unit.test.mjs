// Unit tests for pure logic: money math, schema coercion, guardrails,
// reserve decoding, and claim extraction.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { toRawAmount, defaultMessage, draftParams } from '../src/commands/intent.mjs';
import { coerce, buildArguments } from '../src/commands/call.mjs';
import { loadConfig, redact } from '../src/config.mjs';
import { extractClaims } from '../src/commands/audit.mjs';
import { supplyAprWad, utilizationWad, aprBpsFromWad } from '../src/solana/solend.mjs';
import { UsageError, GuardrailError } from '../src/cli/exit-codes.mjs';

describe('money math never uses floats', () => {
  test('exact conversions at both mint precisions', () => {
    assert.equal(toRawAmount('0.5', 9), '500000000');
    assert.equal(toRawAmount('0.2', 6), '200000');
    assert.equal(toRawAmount('1', 6), '1000000');
    assert.equal(toRawAmount('0.000001', 6), '1');
  });

  test('values a float would corrupt survive intact', () => {
    // 0.1 + 0.2 !== 0.3 in binary floating point; string math is unbothered.
    assert.equal(toRawAmount('0.123456789', 9), '123456789');
    assert.equal(toRawAmount('999999999.999999', 6), '999999999999999');
    assert.equal(toRawAmount('0.3', 9), '300000000');
  });

  test('rejects more precision than the mint carries', () => {
    assert.equal(toRawAmount('0.1234567', 6), null);
    assert.equal(toRawAmount('0.0000000001', 9), null);
  });

  test('rejects non-numeric and negative input', () => {
    for (const bad of ['abc', '', '-1', '1e5', '0x10', '1.2.3', ' 1 ']) {
      assert.equal(toRawAmount(bad, 6), null, `should reject ${JSON.stringify(bad)}`);
    }
  });
});

describe('draft message binding', () => {
  test('the derived message encodes the threshold as a percentage', () => {
    assert.equal(defaultMessage('0.2', 90), 'Deposit 0.2 USDC into Solend when Save APY is above 0.90%');
    assert.equal(defaultMessage('1', 1234), 'Deposit 1 USDC into Solend when Save APY is above 12.34%');
  });

  test('draftParams pins the rail and carries only the varying fields', () => {
    const p = draftParams({ amount: '0.2', 'threshold-bps': '90' });
    assert.equal(p.action, 'deposit');
    assert.equal(p.protocol, 'solend');
    assert.equal(p.asset, 'USDC');
    assert.equal(p.comparison, 'gt');
    assert.equal(p.expiry_seconds_after_finalize, 180);
    assert.equal(p.threshold_bps, 90);
    assert.equal(p.amount, '0.2');
  });

  test('an explicit message overrides the derived one verbatim', () => {
    const p = draftParams({ amount: '0.2', 'threshold-bps': '90', message: 'custom text' });
    assert.equal(p.original_user_message, 'custom text');
  });

  test('invalid amounts and thresholds are usage errors', () => {
    assert.throws(() => draftParams({ amount: '0.1234567', 'threshold-bps': '90' }), UsageError);
    assert.throws(() => draftParams({ amount: '0.2', 'threshold-bps': '0' }), UsageError);
    assert.throws(() => draftParams({ amount: '0.2', 'threshold-bps': '10001' }), UsageError);
    assert.throws(() => draftParams({ amount: '0.2' }), UsageError);
  });
});

describe('schema-driven coercion', () => {
  test('coerces each declared JSON type', () => {
    assert.equal(coerce('42', 'integer'), 42);
    assert.equal(coerce('4.5', 'number'), 4.5);
    assert.equal(coerce('true', 'boolean'), true);
    assert.equal(coerce('no', 'boolean'), false);
    assert.deepEqual(coerce('[1,2]', 'array'), [1, 2]);
    assert.equal(coerce('plain', 'string'), 'plain');
    assert.equal(coerce('unchanged', undefined), 'unchanged');
  });

  test('rejects values that do not fit the declared type', () => {
    assert.throws(() => coerce('4.5', 'integer'), UsageError);
    assert.throws(() => coerce('abc', 'number'), UsageError);
    assert.throws(() => coerce('maybe', 'boolean'), UsageError);
    assert.throws(() => coerce('{oops', 'object'), UsageError);
  });

  test('buildArguments enforces required fields and rejects unknown keys', () => {
    const schema = { properties: { a: { type: 'string' }, b: { type: 'integer' } }, required: ['a'] };
    assert.deepEqual(buildArguments(schema, ['a=x', 'b=2']), { a: 'x', b: 2 });
    assert.throws(() => buildArguments(schema, ['b=2']), /missing required/);
    assert.throws(() => buildArguments(schema, ['a=x', 'c=1']), /unknown argument/);
    assert.throws(() => buildArguments(schema, ['noequals']), /key=value/);
  });

  test('a schema with no declared properties accepts anything', () => {
    assert.deepEqual(buildArguments({}, ['whatever=1']), { whatever: '1' });
  });
});

describe('guardrails', () => {
  const base = { serverBin: 'C:/fake/server.exe' };

  test('acceptance database paths are refused', () => {
    assert.throws(
      () => loadConfig({ ...base, bin: base.serverBin, db: 'C:/x/solfrontiermcpskeleton/data/acceptance/p.db' }, {}),
      GuardrailError,
    );
  });

  test('any .db under an acceptance directory is refused', () => {
    assert.throws(() => loadConfig({ bin: base.serverBin, db: '/srv/acceptance/run.db' }, {}), GuardrailError);
  });

  test('an ordinary scratch path is allowed', () => {
    const cfg = loadConfig({ bin: base.serverBin, db: 'scratch/dev.db' }, {});
    assert.match(cfg.dbPath, /dev\.db$/);
  });

  test('secret-bearing keys in a config file are refused', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'sfcfg-'));
    try {
      for (const key of ['rpcUrl', 'apiKey', 'keypairPath', 'privateKey']) {
        const file = path.join(dir, `${key}.json`);
        await writeFile(file, JSON.stringify({ serverBin: 'x', [key]: 'leak' }));
        assert.throws(() => loadConfig({ config: file }, {}), GuardrailError, `should refuse ${key}`);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('serverArgs containing watch are refused', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'sfcfg-'));
    try {
      const file = path.join(dir, 'c.json');
      await writeFile(file, JSON.stringify({ serverBin: 'x', serverArgs: ['watch', '--execute'] }));
      assert.throws(() => loadConfig({ config: file }, {}), GuardrailError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a non-numeric timeout is a usage error', () => {
    assert.throws(() => loadConfig({ bin: 'x', 'timeout-ms': 'abc' }, {}), UsageError);
    assert.throws(() => loadConfig({ bin: 'x', 'timeout-ms': '-5' }, {}), UsageError);
  });

  test('config reports env presence without ever exposing values', () => {
    const cfg = loadConfig({ bin: 'x' }, {
      SOLFRONTIER_RPC_URL: 'https://secret.example/key123',
      SOLFRONTIER_CONTROLLED_WALLET_KEYPAIR: 'C:/keys/wallet.json',
    });
    assert.equal(cfg.rpcUrlPresent, true);
    assert.equal(cfg.controlledKeypairEnvPresent, true);
    const serialized = JSON.stringify(cfg);
    assert.ok(!serialized.includes('secret.example'), 'endpoint must not appear anywhere in config');
    assert.ok(!serialized.includes('key123'));
    assert.ok(!serialized.includes('wallet.json'), 'keypair path must not appear anywhere in config');
  });
});

describe('redaction', () => {
  test('removes the configured endpoint and any other URL', () => {
    const env = { SOLFRONTIER_RPC_URL: 'https://rpc.example/abc123' };
    assert.equal(redact('failed to reach https://rpc.example/abc123 now', env), 'failed to reach <rpc-redacted> now');
    assert.match(redact('see https://other.example/x', {}), /<url-redacted>/);
  });
});

describe('Solend APR math', () => {
  // A synthetic reserve whose arithmetic can be checked by hand.
  const reserve = {
    availableAmount: 1_000_000n,
    borrowedAmountWads: 1_000_000n * 10n ** 18n, // 50% utilization
    optimalUtilizationRate: 80,
    minBorrowRate: 0,
    optimalBorrowRate: 10,
    maxBorrowRate: 100,
    protocolTakeRate: 0,
    maxUtilizationRate: 90,
    superMaxBorrowRate: 300n,
  };

  test('utilization is exact at the 50% point', () => {
    assert.equal(utilizationWad(reserve), 5n * 10n ** 17n);
  });

  test('supply APR with no protocol take is borrowRate * utilization', () => {
    // util 0.5, below optimal 0.8 -> borrow = 0.5/0.8 * 10% = 6.25%
    // supply = 6.25% * 0.5 = 3.125% = 312 bps (floored)
    assert.equal(aprBpsFromWad(supplyAprWad(reserve)), 312);
  });

  test('a protocol take rate reduces supply APR proportionally', () => {
    const taxed = { ...reserve, protocolTakeRate: 20 };
    assert.equal(aprBpsFromWad(supplyAprWad(taxed)), 250); // 312.5 * 0.8
  });

  test('zero borrows means zero utilization and zero supply APR', () => {
    assert.equal(aprBpsFromWad(supplyAprWad({ ...reserve, borrowedAmountWads: 0n })), 0);
  });
});

describe('audit claim extraction', () => {
  const doc = `
# Acceptance

| Deposit transaction | [\`hpVwPcMwy6RWATk2ks7HPEo8bS4zGAPaL7gx4BcdpBqgs4d27NrD6YF73T8nk9gokiatT7iGx2YdrNupzcdx6J4\`](https://explorer.solana.com/tx/hpVwPcMwy6RWATk2ks7HPEo8bS4zGAPaL7gx4BcdpBqgs4d27NrD6YF73T8nk9gokiatT7iGx2YdrNupzcdx6J4) |
| Deposit slot | \`436548513\` |

\`\`\`text
claw:w5h:5a000000400d0300000000009a62dace:a28eaf630890d0830ca822c754766689eb75549ed559025d404cb46dec08f1d5
\`\`\`

| Account | Pre | Post | Delta |
|---|---:|---:|---:|
| Controlled USDC ATA | 1,253,487 | 1,053,487 | -200,000 |
`;

  test('finds the transaction signature exactly once', () => {
    const claims = extractClaims(doc);
    assert.equal(claims.signatures.length, 1);
    assert.match(claims.signatures[0], /^hpVwPcMw/);
  });

  test('finds the asserted slot', () => {
    assert.ok(extractClaims(doc).slots.includes(436548513));
  });

  test('parses the memo into intent id and rule hash', () => {
    const [memo] = extractClaims(doc).memos;
    assert.equal(memo.intentId, '5a000000400d0300000000009a62dace');
    assert.equal(memo.ruleHash.length, 64);
  });

  test('parses balance rows with thousands separators', () => {
    const [delta] = extractClaims(doc).deltas;
    assert.equal(delta.pre, '1253487');
    assert.equal(delta.post, '1053487');
    assert.equal(delta.delta, '-200000');
  });

  test('typographic minus and non-breaking spaces are normalized', () => {
    // Real acceptance documents are typeset: U+2212 MINUS SIGN, en dashes and
    // NBSPs appear where a parser naively expects ASCII. Failing to normalize
    // yields zero claims, which reads as a pass — the worst failure mode.
    const typeset = [
      '| Account | Pre | Post | Delta |',
      '|---|---:|---:|---:|',
      '| Controlled ATA | 1,253,487 | 1,053,487 | −200,000 |',
      '| Obligation | 2,121,745 | 2,275,267 | +153,522 |',
    ].join('\n');
    const { deltas } = extractClaims(typeset);
    assert.equal(deltas.length, 2);
    assert.equal(deltas[0].delta, '-200000');
    assert.equal(deltas[1].delta, '153522');
  });

  test('a document with no signatures yields nothing rather than throwing', () => {
    const claims = extractClaims('# nothing here');
    assert.deepEqual(claims.signatures, []);
  });
});
