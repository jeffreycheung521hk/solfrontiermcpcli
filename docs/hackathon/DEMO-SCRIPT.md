# Technical video — target 2:50, maximum 3:00

Show a controlled offline attack run and the saved successful mainnet proof. The mainnet
proof is the 2026-10-12 Phantom payer → Gate Approver → Jupiter HTTP adapter run; it is not a
Claude Desktop or unmodified Jupiter MCP session. This script performs no new exchange.

## Prepare before recording

- Use a repository checkout that has passed `npm test`.
- Keep credentials and wallet popups out of the recording. All evidence here is public.
- Open [proof.md](../proof/mainnet-2026-10-12/proof.md), [verification.json](../proof/mainnet-2026-10-12/verification.json), [policy.json](../proof/mainnet-2026-10-12/policy.json), and the [finalized transaction](https://explorer.solana.com/tx/55sa9vBAXo1Qh8jYgrqzWf1uZNcGMxyCtM5UVHUcxEEQrJFr7P6zqLFYpA2xort9Ku85Nzt3zL51YW9g2ZmNkDdh).
- Run the commands below from the repository root. The attack script uses loopback fixtures
  and generated test keys. The audit timeline reads the published audit; neither command
  queries a real cluster or moves funds.
- Use cuts to fit the time slots; leave outputs readable. Keep "hermetic fixtures" and
  "saved mainnet proof, 2026-10-12" labels visible during their respective sections.

## Sequence

| Time | Show / type | Say |
|---|---|---|
| 0:00–0:20 | Title and the three Gate checkpoints | "SolFrontier Gate puts policy, transaction review and human approval between an agent and its wallet tools. I'll show controlled refusal tests, then the saved mainnet transaction and its verification. The two kinds of evidence are labeled separately." |
| 0:20–0:55 | `node scripts/demo/attacks.mjs --hermetic` and its six-row result | "This uses a fake RPC and a deliberately naive MCP wallet fixture. It checks an oversized transfer, a forbidden destination, a crafted drain, delegation, a rogue unsolicited send and an unlisted tool. Each row names its expected refusal. These tests don't move real funds." |
| 0:55–1:15 | `node scripts/hackathon/phantom/audit-last-attempt.mjs` | "Now the original mainnet audit. Its hash chain includes the earlier failed attempts and the successful call. The payer signature arrived at about four seconds; separate approval at about fourteen. The execute-intent record precedes the result. Intent alone isn't proof of landing." |
| 1:15–1:45 | `policy.json`, then proof timing table | "The companion's SOL outflow cap is 0.003. Unknown programs warn and destinations are unrestricted for Ultra routing, so this isn't proof of a strict destination allowlist. The shared deadline stops late signatures and expired holds. It never extends blockhash validity or automatically re-quotes or retries." |
| 1:45–2:15 | `verification.json` fields `status`, `finalized`, `messageSha256`, `checks`, `balances` | "The read-only verifier reports VERIFIED at finalized. It checks the payer's ledger signature, the approver's message signature, and the approved message against the landed message. Actual USDC inflow is 0.111685, above the bound minimum. Native plus wrapped SOL outflow is 0.002494861, below the cap." |
| 2:15–2:35 | Explorer transaction, matching signature and slot | "This is the public mainnet record. The approver's signMessage approval is off chain; it isn't another wallet transaction. The saved proof describes the exact path: Phantom signing, Gate's tool-argument pipeline, then a Jupiter HTTP adapter." |
| 2:35–2:50 | README Gate limits and companion README | "The Node core uses built-ins only. The optional payer page needs a separate web3 browser bundle. Simulation can differ from landing; a malicious server holding a key can bypass our endpoint. Next are downstream isolation and multiple approvers. Agents propose. Policy decides. Humans sign." |

If the hermetic command has a failed row, stop and fix the recording setup; do not edit its
output into a pass. The archived verification is explicitly a historical snapshot. A new
read-only mainnet verification is optional and has a separate output under
`.sfgate-phantom-state/`; it is not required to record this sequence. [Setup and read-only
commands](../../scripts/hackathon/phantom/README.md).
