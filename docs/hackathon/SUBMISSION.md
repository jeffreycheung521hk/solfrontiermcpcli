# Submission pack — Crypto World's Fair (Colosseum)

> **給 Jeff**：英文部分可貼進表單；`<…>` 仍需你填影片網址或未提供的資料。
> 2026-10-12 主網驗收已完成，以下敘述已依實際 Phantom + Gate + Jupiter HTTP 流程更新。
> 影片稿是 3 分鐘上限，照 140 字／分鐘估算；講慢一點就刪括號裡的句子。

## A. Create-project form (done on 10/9)

- **Project name:** SolFrontier Gate
- **Category:** the first that exists of: Security → Developer Tools / Infrastructure → AI Platforms / Agents
- **Brief description** (corrected 10/9 night — the first version said every transaction goes
  through the RPC checkpoint; Jupiter Ultra does not, it is reviewed as a tool argument):
  > SolFrontier Gate is an MCP firewall with a zero-dependency Node core between AI agents (Claude, Cursor) and Solana wallet servers. It enforces per-tool policy (pass / bound / deny), decodes and simulates transactions — whether they arrive as tool arguments or through its RPC checkpoint — and holds each one until a human approves it with a wallet signature. Every decision lands in a hash-chained audit log anyone can re-verify against the ledger.
- **Track:** Solana

## B. Full submission (Monday)

### Product description

AI agents are getting wallets through MCP, the protocol Claude, Cursor and most agent hosts use
to call tools. Two open-source Solana MCP server implementations we inspected ask for a
private key in their configuration. One of them signs the transaction bytes supplied to its execute tool.
Agents read untrusted text all day, so one injected sentence can turn the agent into an
attacker's signer — and a wallet popup or a multisig cannot tell what the agent was trying to do.

SolFrontier Gate sits between the agent host and the MCP servers, where it can inspect tool
arguments and transaction bytes. Configured read tools pass. Money tools can be bounded by
policy: amounts, mints and destinations. Transaction-bearing tool arguments and RPC send
requests are decoded, simulated against the live cluster, and held until a human signs an
approval message for the exact transaction message. In the generic MCP configuration, servers
that require a signing key receive a dedicated petty-cash key; that server can control its
balance, so the balance is the bound against a malicious downstream. Every decision lands in a
hash-chained JSONL log that `sfcli audit --log` can re-verify against the ledger. The Node core
uses built-ins only and has zero npm runtime dependencies.

**Demonstrated mainnet path:** on 2026-10-12, the human signed a 0.001 SOL → USDC order in
Phantom and a separate Gate Approver signed its exact-message approval. Gate's tool-argument
pipeline released it to a Jupiter HTTP adapter. The finalized receipt was **0.111685 USDC**
against a **0.111463 USDC** minimum; native-plus-wrapped SOL outflow was **0.002494861 SOL**
against a **0.003 SOL** cap. The saved verifier result is `VERIFIED`.

This companion run did not use Claude Desktop or an unmodified Jupiter MCP downstream. It
loaded no payer key file and passed no private key to a server. Its optional browser page
uses an externally supplied web3 serialization bundle, separate from the built-in-only Node
core. The proof policy allows arbitrary destinations and warns on unknown programs for
Ultra routing; it does not demonstrate strict destination or program enforcement. Generic
MCP and RPC checkpoint behavior is covered separately by hermetic tests. [Full evidence and
scope](../proof/mainnet-2026-10-12/proof.md).

### Built during the hackathon (2026-10-09 → 10-12)

- Gate proxy: stdio MCP server for the host, downstream process manager, namespaced tools
- Tool policy engine: pass / bound / deny, argument constraints, structured refusals for agents
- Solana transaction kit: legacy + v0 decoding, lookup tables, instruction descriptions,
  simulation with balance deltas of the wallet's own accounts — all zero-dependency
- Transaction policy: program allowlist, outflow caps per asset, destination rules, token
  delegation and legacy-transfer denial
- RPC checkpoint: loopback JSON-RPC proxy that intercepts `sendTransaction`
- Wallet-signature approvals: loopback page, Phantom `signMessage`, single-use, expiring holds
- Hash-chained audit log and `audit --log` ledger re-verification
- Demo wallet server and a scripted "compromised agent" attack suite
- Phantom companion: public-address review, human payer signature, separate Gate approval, one Jupiter HTTP execute request, shared expiry budget and read-only finalized verifier
- Mainnet proof: [0.001 SOL → USDC, finalized](https://explorer.solana.com/tx/55sa9vBAXo1Qh8jYgrqzWf1uZNcGMxyCtM5UVHUcxEEQrJFr7P6zqLFYpA2xort9Ku85Nzt3zL51YW9g2ZmNkDdh) · [audit and verification](../proof/mainnet-2026-10-12/proof.md)
- Offline checks: [108/108 pre-integration companion checks](../proof/mainnet-2026-10-12/offline-tests.tap) and [721/721 full repository tests](../proof/mainnet-2026-10-12/repo-tests.tap), with the external browser bundle supplied for the optional byte-preservation check

### Development history (paste into the disclosure field)

> SolFrontier Gate is built on top of solfrontiermcpcli, my own MCP client repository, public since 2026-08-02. Its last pre-hackathon commit is c14496d (2026-08-03); every commit from "docs(hackathon): build kit" (2026-10-09) onward was written during the hackathon — the gate proxy, tool policy engine, Solana transaction decoder and simulator, RPC checkpoint, approval server, audit chain, demo fixtures and documentation. Reused from before the hackathon: the MCP stdio transport and framing, CLI scaffolding, secret-redaction helpers, and the ledger re-verification approach of the `audit` command. The policy rules are a JavaScript port of ideas from my earlier Rust repositories (solfrontiermcpskeleton; testingcrypto2 / ClawSolana, submitted to the Solana Frontier hackathon). AI coding assistants (Claude and GPT) wrote much of the code against a specification I wrote (docs/hackathon/SPEC.md); design, review, integration and all devnet / mainnet testing were done by me.

The mainnet companion and timing fix were integrated from the local Mac work after the core
Gate modules. The live transaction used the original local snapshot; the repository port was
checked offline. [Source hashes and browser bundle metadata](../proof/mainnet-2026-10-12/source-provenance.json) preserve that distinction. The published result is scoped to that companion path; it does not extend the
proof to an agent host or third-party MCP server that was not used in the run.

### Team

> **Jeff Cheung** — solo founder, Hong Kong. CFA charterholder, MBA, CESGA. About ten years running cross-border B2B trade settlement between Japan and Hong Kong (licensed character IP) before moving into investing and building. Math/physics background; self-taught in Rust and Solana. Built ClawSolana (Frontier hackathon) and SolFrontier MCP, whose AI-proposed, human-funded, policy-gated executions passed mainnet acceptance on 2026-07-29 and 2026-08-01. Cantonese, Mandarin, Japanese, English.

（地點如果要填日本或其他，自己改。）

### Links

- Repo: https://github.com/jeffreycheung521hk/solfrontiermcpcli
- Pitch video: `<YouTube unlisted URL>` · Technical demo: `<YouTube unlisted URL>`
- [Mainnet transaction](https://explorer.solana.com/tx/55sa9vBAXo1Qh8jYgrqzWf1uZNcGMxyCtM5UVHUcxEEQrJFr7P6zqLFYpA2xort9Ku85Nzt3zL51YW9g2ZmNkDdh)
- [Proof report](../proof/mainnet-2026-10-12/proof.md) · [Audit log](../proof/mainnet-2026-10-12/audit.jsonl) · [Saved verification](../proof/mainnet-2026-10-12/verification.json)

## C. Pitch video (≤ 3:00, English)

These are recording instructions, not a claim that a video has already been recorded. Label
hermetic fixtures and saved mainnet evidence on screen. Target 2:45; do not record another
payment merely to recreate the successful proof.

| Time | On screen | Say |
|---|---|---|
| 0:00–0:25 | Title; agent → MCP → wallet diagram | "AI agents read untrusted text and can call wallet tools through MCP. If a server holds a private key and signs transaction bytes on demand, an injected instruction can become a money movement. The safety boundary needs to sit outside the model." |
| 0:25–0:55 | Gate tool policy, transaction review and approval | "SolFrontier Gate adds three checkpoints: tool policy, transaction review with human approval, and evidence. Unlisted tools are denied. Allowed tools can have amount and destination bounds. Transactions are decoded and simulated, then held for a wallet signature binding the exact message. Errors and expiry stop the attempt." |
| 0:55–1:25 | Hermetic attack results, explicitly labeled | "Our offline attack fixtures exercise overspend, forbidden destinations, a blind-signing drain, token delegation, unsolicited sends and unlisted tools. These are controlled tests of refusal behavior. They are separate from the real-money proof." |
| 1:25–1:55 | Saved mainnet proof and Explorer | "On mainnet, I signed a 0.001 SOL Jupiter order in Phantom. A separate approver signed the Gate message. Our companion uses Gate's pipeline with a Jupiter HTTP adapter, rather than an unmodified MCP server. It finalized with 0.111685 USDC received and total SOL outflow below the 0.003 cap. The ledger message matches the approved hash." |
| 1:55–2:20 | Founder photo or face | "I'm Jeff. I spent about ten years settling cross-border trade between Japan and Hong Kong. I'm a CFA charterholder, and I've been building human-controlled agent execution on Solana. The failures taught me to make the deadlines explicit and keep evidence that a stranger can check." |
| 2:20–2:45 | Limits, roadmap and design-partner ask | "Gate is local and open source; the Node core has no npm runtime dependencies. Simulation is a prediction, and a malicious server with a key can bypass our endpoint. Next are isolated downstreams, shared policy and multi-approver holds. We're looking for design partners who need controls and auditable evidence before agents touch funds. Agents propose. Policy decides. Humans sign." |

## D. Technical demo (≤ 3:00, English)

Use the exact command sequence and narration in [DEMO-SCRIPT.md](DEMO-SCRIPT.md). The video
combines a hermetic attack run with the saved, finalized mainnet proof. It does not present a
Claude Desktop session or a fresh swap as though either was performed for this recording.

## E. Slides (6–8)

1. **SolFrontier Gate** — *Agents propose. Policy decides. Humans sign.*
2. **Problem** — the two config screenshots + the `tx.sign` line; "one injected sentence".
3. **Insight** — where intent meets the transaction: the MCP layer.
4. **Product** — three checkpoints: tool policy · transaction review + wallet-signature approval · audit chain.
5. **Proof** — labeled hermetic attack table; finalized mainnet signature; `VERIFIED` snapshot; built-in-only Node core and separate optional browser bundle.
6. **Founder** — Japan–HK settlement, CFA, two prior mainnet acceptances, Rust/Solana.
7. **Business & roadmap** — open-core; paid team policy, Squads holds, attestations; complements Solana Foundation `pay`.
8. **Ask** — design partners with real funds.

## F. Builder updates (drafts to review before posting)

**#1 — Gate core**
> Building SolFrontier Gate: tool policy, transaction review, wallet-signature holds and a hash-chained audit log between agent hosts and Solana wallet tools. The compromised-agent fixtures exercise six refusal scenarios offline. Generic MCP setup and the manual Phantom companion are documented separately.

**#2 — 2026-10-12 mainnet proof**
> A real 0.001 SOL → USDC Jupiter swap finalized after I signed the payment in Phantom and a separate Gate Approver signed the exact-message approval. The companion uses Gate's tool-argument pipeline with a Jupiter HTTP adapter. Received 0.111685 USDC; total SOL outflow 0.002494861, below the 0.003 cap. The saved verifier reports VERIFIED. Transaction: https://explorer.solana.com/tx/55sa9vBAXo1Qh8jYgrqzWf1uZNcGMxyCtM5UVHUcxEEQrJFr7P6zqLFYpA2xort9Ku85Nzt3zL51YW9g2ZmNkDdh
