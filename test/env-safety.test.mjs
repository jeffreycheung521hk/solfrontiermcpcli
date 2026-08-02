// The client can be pointed at any binary with --bin. It must not hand that
// binary the parent environment: doing so would pass an arbitrary executable
// the path to the controlled wallet's keypair, among other secrets. It also
// must not echo secrets back through server logs or protocol frames, which
// are attacker-influenced and operator-visible.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizedChildEnv, redactSensitive } from '../src/mcp/session.mjs';

const SECRETS = {
  SOLFRONTIER_CONTROLLED_WALLET_KEYPAIR: 'C:/keys/controlled-wallet.json',
  SOLFRONTIER_RPC_URL: 'https://rpc.example.test/abcdef0123456789',
  MY_API_KEY: 'sk_live_0123456789abcdef',
  DEPLOY_SECRET: 's3cr3t-value-long-enough',
  GITHUB_TOKEN: 'ghp_0123456789abcdefghij',
  DB_PASSWORD: 'hunter2hunter2hunter2',
  WALLET_MNEMONIC: 'abandon abandon abandon abandon',
  SOME_PRIVATE_KEY: 'PRIVATEKEYMATERIAL0123456789',
};
const HARMLESS = { PATH: '/usr/bin', HOME: '/home/x', LANG: 'en_US.UTF-8', SFCLI_DB: 'scratch/dev.db' };

describe('child environment', () => {
  const env = { ...HARMLESS, ...SECRETS };
  const child = sanitizedChildEnv(env);

  test('the controlled wallet keypair path never reaches a spawned binary', () => {
    assert.equal(child.SOLFRONTIER_CONTROLLED_WALLET_KEYPAIR, undefined);
    assert.ok(!JSON.stringify(child).includes('controlled-wallet.json'));
  });

  test('every secret-shaped variable is withheld', () => {
    for (const key of Object.keys(SECRETS)) {
      if (key === 'SOLFRONTIER_RPC_URL') continue; // the server legitimately needs this
      assert.equal(child[key], undefined, `${key} leaked to the child`);
    }
  });

  test('ordinary variables still pass through, so the server can run', () => {
    for (const [key, value] of Object.entries(HARMLESS)) {
      assert.equal(child[key], value, `${key} was wrongly withheld`);
    }
  });

  test('the RPC endpoint is still provided: the server needs it to work', () => {
    assert.equal(child.SOLFRONTIER_RPC_URL, SECRETS.SOLFRONTIER_RPC_URL);
  });
});

describe('redaction of server output', () => {
  const env = { ...HARMLESS, ...SECRETS };

  test('a secret echoed by a server log line is replaced', () => {
    const line = `INFO loaded keypair from ${SECRETS.SOLFRONTIER_CONTROLLED_WALLET_KEYPAIR}`;
    const out = redactSensitive(line, env);
    assert.ok(!out.includes('controlled-wallet.json'), out);
    assert.match(out, /redacted/);
  });

  test('the RPC endpoint is replaced wherever it appears', () => {
    const out = redactSensitive(`GET ${SECRETS.SOLFRONTIER_RPC_URL} failed`, env);
    assert.ok(!out.includes('abcdef0123456789'), out);
  });

  test('credentials embedded in any URL are stripped', () => {
    const out = redactSensitive('connecting to https://user:p4ssw0rd@example.test/x', env);
    assert.ok(!out.includes('p4ssw0rd'), out);
    assert.match(out, /<credentials-redacted>@/);
  });

  test('ordinary text is left intact', () => {
    const line = 'INFO database migrations applied';
    assert.equal(redactSensitive(line, env), line);
  });

  test('short values are not used as needles, to avoid mangling everything', () => {
    // A one-character secret would otherwise redact half the output.
    const out = redactSensitive('a normal sentence', { TINY_SECRET: 'a' });
    assert.equal(out, 'a normal sentence');
  });
});
