# Finalized mainnet swap — 2026-10-12

**VERIFIED:** a human signed a 0.001 SOL → USDC Jupiter Ultra order in Phantom, then a separate Gate Approver signed the exact-message approval. The Gate pipeline released the signed order to a Jupiter HTTP adapter. The transaction finalized on Solana mainnet.

[View the transaction on Solana Explorer](https://explorer.solana.com/tx/55sa9vBAXo1Qh8jYgrqzWf1uZNcGMxyCtM5UVHUcxEEQrJFr7P6zqLFYpA2xort9Ku85Nzt3zL51YW9g2ZmNkDdh).

## What this run demonstrates

The companion browser flow uses the repository's transaction review, tool-argument pipeline, expiring holds, wallet-signature approval, and hash-chained audit components. The recorded transaction ran from the original local source snapshot; the scripts now in this repository are a path/configuration portability port, tested offline. [Source provenance](source-provenance.json) records hashes of the original six tools and six test files, plus the browser bundle used. The server receives only the payer's public address until the human supplies signed transaction bytes. It does not load a wallet key file or give a private key to a downstream process. The payer transaction is signed in Phantom; the separate approver signs a message binding the hold, cluster, exact transaction-message SHA-256, summary and expiry.

The recorded path is:

```text
Jupiter Ultra unsigned order
  → public-address transaction review
  → human payer signs in Phantom
  → Gate tool-argument review + separate approver signMessage
  → final freshness, cancellation and reserve checks
  → one Jupiter HTTP execute request
  → read-only finalized ledger verification
```

This is a companion demonstration of Gate's pipeline with a Jupiter HTTP adapter. It is **not** evidence of an unmodified Jupiter MCP server running end to end, or a Claude Desktop mainnet session. The generic MCP host and RPC checkpoint routes have separate hermetic coverage; this transaction used the tool-argument route and did not broadcast through the RPC checkpoint.

## Result

| Claim | Finalized ledger result |
|---|---|
| Network | `mainnet-beta`, genesis checked |
| Transaction | `55sa9vBAXo1Qh8jYgrqzWf1uZNcGMxyCtM5UVHUcxEEQrJFr7P6zqLFYpA2xort9Ku85Nzt3zL51YW9g2ZmNkDdh` |
| Slot | `455979197` |
| Block time | 2026-10-12 08:22:30 UTC / 17:22:30 JST |
| Swap input | 1,000,000 lamports / **0.001 SOL** |
| Actual USDC received | 111,685 raw / **0.111685 USDC** |
| Bound minimum USDC | 111,463 raw / **0.111463 USDC** |
| SOL asset outflow, including native and wrapped SOL | 2,494,861 lamports / **0.002494861 SOL** |
| SOL outflow cap | 3,000,000 lamports / **0.003 SOL** |
| Transaction fee | 6,421 lamports |
| Native SOL balance | 50,000,000 → 47,505,139 lamports |
| Owned wrapped SOL delta | 0 raw |
| Owned USDC account balance | 0 → 111,685 raw |
| Hold | `6c97507883e6` |
| Exact approved and landed message SHA-256 | `671c240aa69419cd25a6541f8c803172f932cc2f43e8c0c444b42b574d54b67e` |

Total SOL outflow includes the swap, fees and token-account creation. The final Gate simulation predicted **0.111724 USDC**; actual execution delivered **0.111685 USDC**, above the bound minimum. Simulation and execution amounts are not asserted to be identical.

## Public identities and their traces

- **Petty Cash / transaction payer:** `J3rFAMrr2GDNhDg2x3Cn2K9iNKyrGh4WcqbmNG9xKaRj`. Its transaction signature, native balance delta and owned USDC token-account delta are checked against the ledger.
- **Gate Approver:** `6N7UYBzKmdHYtUssw45QDbGd1No2xUVTFkkVwnovTd3M`. Its Ed25519 `signMessage` approval is stored in audit record #33 and checked cryptographically. This is an **off-chain approval**: the approver did not pay a fee or sign the swap transaction, so this run does not create a separate on-chain transaction for that approval account.
- **Owned USDC account:** `Bj71t567YLuKX6qUZYDZwgmTLxtCFKMZR37AASDkP8oy`.
- **USDC mint:** `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` (6 decimals).

These fixed public addresses identify the historical proof; they are not a setup instruction to fund those accounts.

## Timing and expiry fix

The shared local deadline starts when the server receives the order, not when each signing window opens. For the two-profile flow: signing starts before 9 seconds, a payer signature received after 12 seconds is refused before a hold is created, the hold lasts at most 12 seconds and never exceeds the shared approval cutoff, and the local order lifetime is capped at 20 seconds with a 2-second execution reserve. The same-profile fallback uses 5- and 8-second payer thresholds. Blockhash polling and a final `isBlockhashValid` remain active; these local limits do not extend the chain's blockhash lifetime.

| Recorded event | Since local order receipt | Audit record |
|---|---:|---:|
| Order receipt | 0.000 s | #28 |
| Public order review | 0.602 s | #29 |
| Payer signature received by Gate | 3.939 s | #30 |
| Final pipeline simulation | 4.541 s | #31 |
| Approval hold created | 4.543 s | #32 |
| Approver approval received | 13.774 s | #33 |
| Execute intent appended | 13.865 s | #34 |
| Jupiter result recorded | 14.519 s | #35 |

The audit records one execute intent and one successful result for this transaction. The implementation makes one execute request without automatic retry. An execute-intent record alone cannot prove a request was sent or landed; the successful result and finalized verification provide that evidence. Earlier unsuccessful attempts are retained in the same audit chain.

## Evidence files

| File | Contents |
|---|---|
| [audit.jsonl](audit.jsonl) | Exact original 36-record audit chain, including earlier attempts and final shutdown |
| [verification.json](verification.json) | Exact saved `VERIFIED` read-only mainnet result |
| [policy.json](policy.json) | Public reference policy, with portable command and audit path |
| [offline-tests.tap](offline-tests.tap) | Exact saved pre-integration Mac result: 108/108 companion tests passed |
| [repo-tests.tap](repo-tests.tap) | Exact saved integration run: 721/721 repository tests passed, 0 failed or skipped, with the external browser bundle supplied |
| [source-provenance.json](source-provenance.json) | Original local source hashes and browser bundle metadata; distinguishes the recorded snapshot from the portable repo scripts |
| [timeline.zh-TW.txt](timeline.zh-TW.txt) | Original timeline, measured from Jupiter request creation; about 0.192 s earlier than local receipt |
| [SHA256SUMS](SHA256SUMS) | File integrity checksums for this evidence snapshot |

The verifier ran at **2026-10-12 08:23:28.799 UTC / 17:23:28.799 JST**, against audit #1–35. That prefix ends with hash `1927f48bed17b11952b38a971a5e0e0f7ac05f7a07658db0b5b8e55f2b54a972`. Afterwards shutdown appended #36 (`gate_stop`); the complete archive ends with `58223212667070f7ba5b90e905bbf0023fe756db1e28ddc3e43ce3ce52e502f2`. This explains why the verification JSON lists 35 records while the published audit has 36. The hashed audit records have not been redacted or rewritten.

The verification checked mainnet genesis, finality, transaction signatures, exact approved versus landed message, the Gate Approver's message signature, minimum USDC inflow, native-plus-wrapped SOL outflow cap, and strict audit correlation. Its counters `simulationRequests=0`, `executionRequests=0` and `automaticRetries=0` describe the **read-only verification run**, not the earlier swap flow, which did simulate and execute.

The archive contains public addresses, approval signatures, simulation output and transaction hashes. It contains no wallet key, seed phrase, credential-bearing RPC URL, or broadcast-capable signed transaction bytes. The approval signature is a scoped `signMessage` artifact, not a transaction signature.

## Policy and dependency limits

The [reference policy](policy.json) requires approval, caps SOL outflow at 0.003, forbids USDC outflow and unknown-mint outflow, and denies token delegation and legacy token transfers. It deliberately sets **`unknownProgram: "warn"`** and **`destinations: "any"`** to accommodate Ultra routing. This run therefore does not demonstrate a strict destination allowlist or rejection of every unfamiliar program. Jupiter's route instruction is displayed as unknown; cross-program invocations are not decoded for display. Net effects rely on simulated balances of owned accounts and the bound transaction itself.

Gate core and the Node companion use Node built-ins only, with no npm runtime dependency added. The optional browser payer page consumes an **externally supplied `@solana/web3.js` browser bundle** for wallet transaction serialization; that bundle is not vendored in this repository or represented as part of the built-in-only core. See the [companion README](../../../scripts/hackathon/phantom/README.md) for local setup.

## Recheck without changing the evidence

From the repository root, print the archived audit timeline without network requests or writes:

```sh
node scripts/hackathon/phantom/audit-last-attempt.mjs
```

For an optional fresh, read-only mainnet check of the historical signature:

```sh
node scripts/hackathon/phantom/verify-phantom-mainnet.mjs 55sa9vBAXo1Qh8jYgrqzWf1uZNcGMxyCtM5UVHUcxEEQrJFr7P6zqLFYpA2xort9Ku85Nzt3zL51YW9g2ZmNkDdh
```

Both tools default to this archived audit. `SFGATE_PHANTOM_AUDIT_PATH` can select a different local audit. The ledger verifier requires a privately configured Helius mainnet RPC endpoint, read from `SFGATE_UPSTREAM_RPC_URL` or the existing `~/.sfgate/mainnet-rpc.url`. It saves a new result to `.sfgate-phantom-state/mainnet-phantom-final-verification.json`, leaving these historical files unchanged. See the [companion README](../../../scripts/hackathon/phantom/README.md). No new signature or swap is needed.

The general log verifier can also read this archive with `node src/index.mjs audit --log docs/proof/mainnet-2026-10-12/audit.jsonl --commitment finalized`. Without a privately configured RPC it reports transaction rows `UNVERIFIED` while still checking the chain. Chain integrity is evidence of consistency, not a claim that every historical action was independently observed on chain.
