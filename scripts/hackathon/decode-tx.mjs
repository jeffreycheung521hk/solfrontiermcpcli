#!/usr/bin/env node
// Print a decoded summary of a base64 Solana transaction.
//
//   node scripts/hackathon/decode-tx.mjs <base64>
//   pbpaste | node scripts/hackathon/decode-tx.mjs
//
// Offline by default: v0 lookup-table accounts are shown as `<table>#<index>`.
// With SFGATE_UPSTREAM_RPC_URL set, the tables are fetched (getMultipleAccounts)
// and resolved -- that is the only network call this script makes, and it is
// human-run only; tests never set the variable. The URL is never printed.
import process from 'node:process';

import { decodeTransaction, messageSha256, resolveAccountKeys, verifySignatures } from '../../src/solana/tx.mjs';
import { fetchLookupTables } from '../../src/solana/alt.mjs';
import { describeInstructions } from '../../src/solana/instructions.mjs';

async function readInput() {
  if (process.argv[2]) return process.argv[2];
  if (process.stdin.isTTY) return '';
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

/** Offline stand-in tables: placeholders long enough for every index used. */
function placeholderTables(decoded) {
  const tables = new Map();
  for (const l of decoded.addressTableLookups) {
    const max = Math.max(...l.writableIndexes, ...l.readonlyIndexes);
    tables.set(l.accountKey, Array.from({ length: max + 1 }, (_, i) => `${l.accountKey}#${i}`));
  }
  return tables;
}

async function main() {
  const input = (await readInput()).trim();
  if (!input) {
    process.stderr.write('usage: decode-tx.mjs <base64-transaction>   (or pipe it on stdin)\n');
    return 2;
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(input)) {
    process.stderr.write('input is not base64\n');
    return 2;
  }
  const decoded = decodeTransaction(new Uint8Array(Buffer.from(input, 'base64')));

  let tables = placeholderTables(decoded);
  let lookupSource = decoded.addressTableLookups.length ? 'unresolved (set SFGATE_UPSTREAM_RPC_URL to resolve)' : 'none';
  const url = (process.env.SFGATE_UPSTREAM_RPC_URL ?? '').trim();
  if (url && decoded.addressTableLookups.length) {
    const { SolanaRpc } = await import('../../src/solana/rpc.mjs');
    tables = await fetchLookupTables(new SolanaRpc({ url }), decoded.addressTableLookups.map((l) => l.accountKey));
    lookupSource = 'resolved via RPC';
  }

  const resolved = resolveAccountKeys(decoded, tables);
  const sigs = verifySignatures(decoded);
  const summary = {
    version: decoded.version,
    messageSha256: messageSha256(decoded),
    feePayer: decoded.staticAccountKeys[0],
    recentBlockhash: decoded.recentBlockhash,
    header: decoded.header,
    signatures: { complete: sigs.complete, valid: sigs.valid },
    lookupTables: lookupSource,
    accounts: resolved.keys.map((key, i) => ({
      key, signer: resolved.signer[i], writable: resolved.writable[i],
    })),
    instructions: describeInstructions(decoded, resolved),
  };
  process.stdout.write(`${JSON.stringify(summary, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2)}\n`);
  return 0;
}

main().then(
  (code) => { process.exitCode = code; },
  (err) => {
    // Only the message: an RPC error is already scrubbed of the URL by SolanaRpc.
    process.stderr.write(`decode-tx: ${err.message}\n`);
    process.exitCode = 1;
  },
);
