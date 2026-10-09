# T3 — Solana kit: decode, resolve, describe, simulate

> **給 Jeff**：Agent B（Codex / GPT）週五晚上跑，接著做 T4。預估 4–6 小時。這是最需要 Solana
> 細節正確的一張卡。驗收方法：`npm test` 全綠；週六你用 `scripts/hackathon/decode-tx.mjs`
> 解一筆真的 Jupiter order，看結果是否合理。

Branch: `gate/tx` · Depends on: nothing · Blocks: T4, I1

## Goal

Pure, dependency-free modules that turn transaction bytes into something a policy can judge:
decoded message, resolved accounts, described instructions, and simulated balance changes of
the wallet's own accounts.

## You own

- `src/solana/base58.mjs`, `src/solana/tx.mjs`, `src/solana/alt.mjs`,
  `src/solana/instructions.mjs`, `src/solana/simulate.mjs`
- `src/solana/rpc.mjs` — only the backwards-compatible `{ url }` option
- `test/solana-base58.test.mjs`, `test/solana-tx.test.mjs`, `test/solana-instructions.test.mjs`,
  `test/solana-simulate.test.mjs`, `test/solana-builders.mjs` (test-only encoders)
- `scripts/hackathon/decode-tx.mjs` — prints a decoded summary of a base64 tx given on argv or
  stdin; with `SFGATE_UPSTREAM_RPC_URL` set it also resolves lookup tables (network, human-run)

## Read first

SPEC §5.4 (exact signatures), I7, I9. Existing `src/solana/rpc.mjs` and its tests.

## Build notes (wire format)

- Transaction = shortvec(#signatures) ‖ 64-byte signatures ‖ message.
- Message: if `byte0 & 0x80` → versioned, `version = byte0 & 0x7f`, must be 0, header follows;
  else legacy, header is byte0..2. Header = `numRequiredSignatures`, `numReadonlySigned`,
  `numReadonlyUnsigned`. Then shortvec account keys (32 bytes each), 32-byte recent blockhash,
  shortvec instructions (`programIdIndex` u8, shortvec account indexes u8, shortvec data), and
  for v0 shortvec address table lookups (32-byte key, shortvec writable u8, shortvec readonly u8).
- shortvec = compact-u16 (7 bits per byte, little end first, max 3 bytes). Reject overlong or
  out-of-range encodings, trailing bytes, and indexes past the key list.
- Writability of static key `i`: signer if `i < numRequiredSignatures`; writable signer if
  `i < numRequiredSignatures − numReadonlySigned`; writable non-signer if
  `numRequiredSignatures ≤ i < staticLen − numReadonlyUnsigned`. Lookup writable ⇒ writable.
- Program ids are always static keys in valid messages; if `programIdIndex` points into lookup
  keys, throw.
- Signature verification: Ed25519 over `messageBytes` with `createPublicKey({ key: { kty: 'OKP',
  crv: 'Ed25519', x: base64url(pubkey) }, format: 'jwk' })`. An all-zero signature = not present.
- Lookup table account data: 56-byte meta header, then 32-byte addresses.
- `simulateWithDeltas` details are in SPEC §5.4. The `rpc` argument is any object with
  `call(method, params)`; tests pass an in-process fake, never HTTP.

## Acceptance

- [ ] base58: round trips (incl. leading zero bytes); `11111111111111111111111111111111` ↔ 32 zero bytes; invalid characters throw.
- [ ] Vectors built at runtime with fresh keys: legacy System transfer; v0 with one lookup table
      (writable + readonly lookups); SPL `transferChecked`; SPL `approve`; legacy SPL `transfer`;
      memo; compute budget pair. Decoding each matches what was encoded.
- [ ] `messageSha256` is stable and changes when any message byte changes.
- [ ] `verifySignatures`: valid, tampered message, missing signature.
- [ ] `resolveAccountKeys`: v0 ordering and writability exactly per the rules above.
- [ ] `describeInstructions` returns the documented `kind`s and BigInt amounts.
- [ ] `simulateWithDeltas` against a fake rpc: lamport delta; two token mints; a token account
      that does not exist before and is owned by the wallet after (counts as own); decimals read
      from mint data; `err` passed through; RPC throw ⇒ rejects (caller fails closed).
- [ ] `new SolanaRpc({ url })` uses `url`; without it, behaviour and existing tests unchanged.
- [ ] No network anywhere in `npm test`.

## Launch prompt

```
You are Agent B in this repository. Read AGENTS.md, docs/hackathon/SPEC.md and
docs/hackathon/tasks/T3-solana-kit.md. Work on branch gate/tx. Implement T3 completely, with
tests, committing after each green step, until every Acceptance box is ticked. Then continue
with docs/hackathon/tasks/T4-review-and-tx-policy.md on the same branch. Do not add any npm
dependency. Finish by opening a PR listing what is verified, what is UNVERIFIED, and needs from
other cards.
```
