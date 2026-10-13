# Phantom manual-signing companion

This companion preserves the local prototype that completed the [2026-10-12 mainnet acceptance](../../../docs/proof/mainnet-2026-10-12/proof.md): a human signs the payer transaction in Phantom, Gate reviews it and requires a separate approver's message signature, then a small HTTP adapter calls Jupiter Ultra. It does not spawn a wallet MCP or load a wallet key. The published scripts are a portable path/configuration port of that local snapshot; the recorded live transaction used the original snapshot listed in [source provenance](../../../docs/proof/mainnet-2026-10-12/source-provenance.json).

These are reference acceptance tools with the recorded operator's fixed public wallet and approver addresses, a fixed 0.001 SOL → USDC amount, and a 0.003 SOL outflow cap. They are not a general wallet onboarding flow. Reading the proof and running the hermetic tests requires no funded wallet.

## Inspect the existing proof

From the repository root, Node ≥20:

```sh
node scripts/hackathon/phantom/audit-last-attempt.mjs
```

This reads the published hash-chained audit and prints its last attempt. It makes no network requests and does not write the proof.

[verification.json](../../../docs/proof/mainnet-2026-10-12/verification.json) records the successful finalized verification. An operator can re-check this public signature with the read-only verifier:

```sh
node scripts/hackathon/phantom/verify-phantom-mainnet.mjs 55sa9vBAXo1Qh8jYgrqzWf1uZNcGMxyCtM5UVHUcxEEQrJFr7P6zqLFYpA2xort9Ku85Nzt3zL51YW9g2ZmNkDdh
```

That command needs an operator's Helius mainnet RPC endpoint from `SFGATE_UPSTREAM_RPC_URL` or the existing `~/.sfgate/mainnet-rpc.url`. The URL is loaded lazily and never printed. It writes a new result under the ignored `.sfgate-phantom-state/`, keeping the published proof unchanged. `SFGATE_PHANTOM_AUDIT_PATH` can select another audit when reviewing a local run.

## Offline checks

```sh
npm test
node --test test/phantom-keyless-runtime.test.mjs test/phantom-keyless-server.test.mjs test/phantom-keyless-page-expiry.test.mjs test/verify-phantom-mainnet.test.mjs test/jupiter-blockhash-window.test.mjs test/audit-last-attempt.test.mjs
```

All RPC, Jupiter, wallet and transaction fixtures in those tests are fake; listeners use temporary loopback ports. The optional browser-library byte-preservation check is explicitly skipped unless `SFGATE_BROWSER_WEB3_PATH` supplies the operator's existing bundle. The local acceptance checks supplied that bundle and passed all 108 companion checks; the saved TAP is historical evidence, not a claim that every CI runner has a browser library or Phantom installed.

## Public configuration only

```sh
node scripts/hackathon/phantom/phantom-keyless-server.mjs --prepare-only
```

This validates the published public policy and writes a machine-local public configuration under `.sfgate-phantom-state/`. It starts no listener, reads no wallet/RPC credential, and makes no network request.

## Original operator's manual session

The optional payer page needs an externally supplied `@solana/web3.js` browser bundle for Phantom transaction objects. No bundle is vendored, no package is installed by the scripts, and neither `dependencies` nor `devDependencies` changes. The Node Gate core continues to use built-ins only. The exact browser file used for the recorded acceptance was `lib/index.iife.min.js`, version 1.98.0, SHA-256 `89c3d6c27cae93882d78153ef7f23c8d50f53f5e3f0b72666bb909c6a4dc9fac`.

Once the recorded operator has prepared both Chrome profiles and selected the correct existing wallets:

```sh
SFGATE_BROWSER_WEB3_PATH=/absolute/path/to/index.iife.min.js node scripts/hackathon/phantom/phantom-keyless-server.mjs
```

The service starts **paused** and prints a fresh local payer URL and the Gate approval URL. Open the payer URL in the Petty Cash Chrome profile and the approval URL in the Gate Approver profile. Both use Phantom. Keep the approver page open and both wallets unlocked before the quote. In the running terminal, `resume` enables the page; it does not fetch an order. `pause` cancels pending approval, and `quit` closes the service.

The human chooses when to quote, checks the result, signs payment, and immediately approves in the second window. One-profile fallback uses `--same-profile` with shorter limits.

| Limit, measured from local order receipt | Two profiles | One profile |
|---|---:|---:|
| Start payment signing before | 9 s | 5 s |
| Payment signature must arrive by | 12 s | 8 s |
| Maximum individual approval hold | 12 s | 12 s |
| Shared payment/approval cutoff | 18 s at most | 18 s at most |
| Local order lifetime cap | 20 s | 20 s |
| Reserved execution time | 2 s | 2 s |

An earlier Jupiter expiry shortens these bounds. The 20-second cap does not extend chain validity. The local deadline timer expires pending approvals even when RPC stalls; blockhash monitoring can refuse earlier. The final chain check, exact-message and approver checks, simulation caps, audit intent and execution reserve must all pass before one POST. A payer signature received too late is refused before a hold or final simulation.

The service locks after accepting a payment signature. It never automatically refreshes an order or retries a POST. An uncertain result requires read-only reconciliation of the candidate signature. Startup also refuses an audit containing a prior `execute_attempt`; retain that record and reconcile it rather than erasing it to restart.

## Scope

The live proof establishes this Phantom payer + Gate tool-argument pipeline + Jupiter HTTP route. It does not establish a Claude Desktop session or the unmodified third-party Jupiter MCP signing route. The recorded policy uses `unknownProgram: "warn"` and `destinations: "any"`; the human review, exact message, output floor, and simulated outflow cap still apply. Core Gate limitations remain documented in the repository README.
