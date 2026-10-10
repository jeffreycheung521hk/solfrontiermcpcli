#!/usr/bin/env node
// Create (or inspect) the petty-cash keypair that SolFrontier Gate hands to downstream servers.
//
// The petty-cash wallet is the only key an agent-side process ever touches. Keep its balance
// small: whatever it holds is the worst case if a downstream server turns out to be malicious.
//
//   node scripts/hackathon/new-petty-cash.mjs                 create ~/.sfgate/petty-cash.json
//   node scripts/hackathon/new-petty-cash.mjs --out <path>    create at another path
//   node scripts/hackathon/new-petty-cash.mjs --show          print the existing public key
//   node scripts/hackathon/new-petty-cash.mjs --export-base58 print the secret key, base58
//                                                             (only for testing a third-party
//                                                             server directly; never paste it
//                                                             into chat or commit it)
//
// File format: Solana CLI keypair JSON (64 numbers: 32-byte seed, then 32-byte public key).
// Zero dependencies. Never overwrites an existing file: a funded key lost to an overwrite is gone.
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58(bytes) {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  return '1'.repeat(zeros) + out;
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function keyObjectsFromSecret(secret64) {
  const seed = secret64.subarray(0, 32);
  const pub = secret64.subarray(32, 64);
  const privateKey = createPrivateKey({
    key: { kty: 'OKP', crv: 'Ed25519', d: b64url(seed), x: b64url(pub) },
    format: 'jwk',
  });
  const publicKey = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: b64url(pub) }, format: 'jwk' });
  return { privateKey, publicKey };
}

/** Prove the file's two halves belong together before anyone funds the address. */
function selfCheck(secret64) {
  const { privateKey, publicKey } = keyObjectsFromSecret(secret64);
  const derived = Buffer.from(createPublicKey(privateKey).export({ format: 'jwk' }).x, 'base64url');
  if (!derived.equals(Buffer.from(secret64.subarray(32)))) throw new Error('public key does not match seed');
  const probe = Buffer.from('solfrontier-gate petty-cash self-check');
  if (!verify(null, probe, publicKey, sign(null, probe, privateKey))) throw new Error('sign/verify failed');
}

function readKeypair(file) {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(raw) || raw.length !== 64 || raw.some((v) => !Number.isInteger(v) || v < 0 || v > 255)) {
    throw new Error(`${file} is not a Solana CLI keypair (expected a JSON array of 64 bytes)`);
  }
  const secret64 = Uint8Array.from(raw);
  selfCheck(secret64);
  return secret64;
}

function main(argv) {
  const outIndex = argv.indexOf('--out');
  const file = path.resolve(outIndex >= 0 && argv[outIndex + 1] ? argv[outIndex + 1] : path.join(homedir(), '.sfgate', 'petty-cash.json'));

  if (argv.includes('--show') || argv.includes('--export-base58')) {
    if (!existsSync(file)) {
      process.stderr.write(`no keypair at ${file} — run without flags to create one\n`);
      return 2;
    }
    const secret64 = readKeypair(file);
    if (argv.includes('--export-base58')) {
      process.stderr.write(
        'WARNING: the next line is the petty-cash SECRET KEY. Use it only to test a third-party\n' +
          'server directly, keep the balance small, never paste it into chat, never commit it.\n',
      );
      process.stdout.write(`${base58(secret64)}\n`);
    } else {
      process.stdout.write(`${base58(secret64.subarray(32))}\n`);
    }
    return 0;
  }

  if (existsSync(file)) {
    process.stderr.write(
      `refusing to overwrite ${file}\n` +
        'An existing petty-cash key may hold funds. Move it aside first if you really want a new one,\n' +
        `or print its address with: node scripts/hackathon/new-petty-cash.mjs --show${outIndex >= 0 ? ` --out ${file}` : ''}\n`,
    );
    return 2;
  }

  const { privateKey } = generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' });
  const secret64 = new Uint8Array(64);
  secret64.set(Buffer.from(jwk.d, 'base64url'), 0);
  secret64.set(Buffer.from(jwk.x, 'base64url'), 32);
  selfCheck(secret64);

  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(Array.from(secret64))}\n`, { mode: 0o600, flag: 'wx' });
  chmodSync(file, 0o600);

  const pubkey = base58(secret64.subarray(32));
  process.stderr.write(
    `created ${file} (permissions 600)\n` +
      'Fund it with a SMALL amount only: devnet via https://faucet.solana.com, mainnet ≤ 0.03 SOL.\n' +
      'Point Gate at it with:  export SFGATE_PETTY_CASH_PATH="' + file + '"\n' +
      'Petty-cash address (safe to share):\n',
  );
  process.stdout.write(`${pubkey}\n`);
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`error: ${err.message}\n`);
  process.exitCode = 1;
}
