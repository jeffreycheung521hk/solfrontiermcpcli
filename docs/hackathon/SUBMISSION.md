# Submission pack — Crypto World's Fair (Colosseum)

> **給 Jeff**：英文部分直接貼進表單；`<…>` 是週日拿到真實數據後要填的地方。
> 影片稿是 3 分鐘上限，照 140 字／分鐘估算；講慢一點就刪括號裡的句子。

## A. Create-project form (done on 10/9)

- **Project name:** SolFrontier Gate
- **Category:** the first that exists of: Security → Developer Tools / Infrastructure → AI Platforms / Agents
- **Brief description** (corrected 10/9 night — the first version said every transaction goes
  through the RPC checkpoint; Jupiter Ultra does not, it is reviewed as a tool argument):
  > SolFrontier Gate is a zero-dependency MCP firewall between AI agents (Claude, Cursor) and Solana wallet servers. It enforces per-tool policy (pass / bound / deny), decodes and simulates transactions — whether they arrive as tool arguments or through its RPC checkpoint — and holds each one until a human approves it with a wallet signature. Every decision lands in a hash-chained audit log anyone can re-verify against the ledger.
- **Track:** Solana

## B. Full submission (Monday)

### Product description

AI agents are getting wallets through MCP, the protocol Claude, Cursor and most agent hosts use
to call tools. Two open-source Solana MCP servers we tested start the same way: paste your
private key into the agent's config. One of them signs whatever transaction the agent hands it.
Agents read untrusted text all day, so one injected sentence can turn the agent into an
attacker's signer — and a wallet popup or a multisig cannot tell what the agent was trying to do.

SolFrontier Gate sits at the only layer that sees both the agent's intent and the exact
transaction: between the agent host and the MCP servers. Read tools pass. Money tools are
bounded by policy (amounts, mints, destinations). Any transaction about to be signed — whether
it arrives as a tool argument or through Gate's loopback RPC endpoint — is decoded, simulated
against the live cluster, and held until the human approves it by signing an approval message
with their own wallet, which the agent cannot fake. Servers that insist on a key get a capped
petty-cash key, never the user's. Every decision lands in a hash-chained JSONL log that
`sfcli audit --log` re-verifies against the ledger. Zero npm dependencies: a security proxy
should not carry a supply chain (CVE-2024-54134 backdoored `@solana/web3.js` itself).

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
- Mainnet proof: `<SIGNATURE>` (<what it was>) · devnet proofs: `<SIGNATURES>`

### Development history (paste into the disclosure field)

> SolFrontier Gate is built on top of solfrontiermcpcli, my own MCP client repository, public since 2026-08-02. Its last pre-hackathon commit is c14496d (2026-08-03); every commit from "docs(hackathon): build kit" (2026-10-09) onward was written during the hackathon — the gate proxy, tool policy engine, Solana transaction decoder and simulator, RPC checkpoint, approval server, audit chain, demo fixtures and documentation. Reused from before the hackathon: the MCP stdio transport and framing, CLI scaffolding, secret-redaction helpers, and the ledger re-verification approach of the `audit` command. The policy rules are a JavaScript port of ideas from my earlier Rust repositories (solfrontiermcpskeleton; testingcrypto2 / ClawSolana, submitted to the Solana Frontier hackathon). AI coding assistants (Claude and GPT) wrote much of the code against a specification I wrote (docs/hackathon/SPEC.md); design, review, integration and all devnet / mainnet testing were done by me.

### Team

> **Jeff Cheung** — solo founder, Hong Kong. CFA charterholder, MBA, CESGA. About ten years running cross-border B2B trade settlement between Japan and Hong Kong (licensed character IP) before moving into investing and building. Math/physics background; self-taught in Rust and Solana. Built ClawSolana (Frontier hackathon) and SolFrontier MCP, whose AI-proposed, human-funded, policy-gated executions passed mainnet acceptance on 2026-07-29 and 2026-08-01. Cantonese, Mandarin, Japanese, English.

（地點如果要填日本或其他，自己改。）

### Links

- Repo: https://github.com/jeffreycheung521hk/solfrontiermcpcli
- Pitch video: `<YouTube unlisted URL>` · Technical demo: `<YouTube unlisted URL>`
- Mainnet proof: `https://solscan.io/tx/<SIGNATURE>` · Audit log: `docs/proof/<file>.jsonl`

## C. Pitch video (≤ 3:00, English)

| Time | On screen | Say |
|---|---|---|
| 0:00 | Two config snippets with `PRIVATE_KEY`, then the line `tx.sign([walletKeypair])` | "AI agents are getting wallets through MCP. Two open-source Solana MCP servers we tested start the same way: paste your private key into the agent's config. One of them signs whatever transaction the agent hands it. Agents read untrusted text all day. One injected sentence, and your agent is the attacker's signer." |
| 0:25 | Diagram: agent → MCP → wallet → chain; Gate at the MCP layer | "Prompts can't be the safety boundary. A wallet popup sees a transaction, not the agent's intent. A multisig decides who signs, not what. The only place that sees both is the MCP layer — between the agent and its tools." |
| 0:50 | Product shots (from the technical video) | "SolFrontier Gate is that layer. One MCP entry replaces your Solana servers. Read tools pass. Money tools are bounded by policy. Any transaction about to be signed is decoded, simulated against the live cluster, and held until you approve it with your own wallet signature — one your agent cannot fake. Every decision lands in a hash-chained log anyone can re-verify against the ledger. And it has zero dependencies, because a security proxy shouldn't carry a supply chain." |
| 1:30 | Attack table, then the mainnet approval | "Here it refuses a 5 SOL transfer, blocks a blind-signing drain, and approves a real Jupiter swap on mainnet." |
| 1:45 | Founder photo or face | "I'm Jeff. Ten years settling cross-border trade between Japan and Hong Kong, a CFA charter, and since this spring I've been running agent execution on Solana mainnet — AI proposes, a human funds, a policy engine executes. Every failure taught the same lesson: the gate has to sit outside the model." |
| 2:15 | Market slide | "Every team giving agents wallets needs this — trading desks, DAOs, and the regulated funds and stablecoin operators in Japan and Hong Kong who must prove controls before an agent touches money. The local proxy is free and open source. Teams pay for shared policy, multi-approver holds with Squads, and audit attestations they can hand to a regulator. It complements Solana Foundation's pay, which bounds paid API calls: Gate bounds everything else an agent can sign." |
| 2:45 | Title card | "We're looking for design partners running agents with real funds. Agents propose. Policy decides. Humans sign." |

## D. Technical demo (≤ 3:00, English)

| Time | On screen | Say / do |
|---|---|---|
| 0:00 | jupiter-mcp `index.js`, the `tx.sign([walletKeypair])` line | "This server signs any base64 transaction the agent passes it, then posts it to Jupiter. Gate's job is to make that safe without changing a line of it." |
| 0:15 | `claude_desktop_config.json` with one `solfrontier-gate` entry; the policy file | "One entry. The policy: balance passes, transfers are bounded to 0.05 SOL and my own addresses, swaps need my signature, everything else is denied and hidden." |
| 0:35 | Claude Desktop: "What's my balance?" → answer. "Send 5 SOL to <address>." → refusal | "Read passes. The 5 SOL transfer is refused before it reaches the server — and the agent gets a structured reason it can act on." |
| 1:00 | "Swap 0.001 SOL to USDC." → notification → approval page: decoded instructions, simulated −SOL / +USDC, message hash, countdown → Phantom signs the approval message → confirmed | "The swap transaction is decoded and simulated against mainnet before anyone signs. I approve with my wallet — a signature the agent cannot produce. Only then does the server get the call." |
| 1:45 | `node scripts/demo/attacks.mjs` table | "Now assume the agent is compromised. Overspend, unknown destination, blind-signing drain, token delegation, a rogue server sending behind the agent's back, an unlisted tool: every one refused, each with the rule that caught it." |
| 2:20 | `node src/index.mjs audit --log docs/proof/<file>.jsonl` | "Every decision is in a hash-chained log. The audit command re-verifies the chain and checks that what landed on chain is exactly what I approved." |
| 2:40 | README limits section | "What it doesn't do: a malicious server that ignores our RPC endpoint is bounded only by its petty-cash balance — that's why the key it holds is capped. Next: network-isolated servers and multi-approver holds." |

## E. Slides (6–8)

1. **SolFrontier Gate** — *Agents propose. Policy decides. Humans sign.*
2. **Problem** — the two config screenshots + the `tx.sign` line; "one injected sentence".
3. **Insight** — where intent meets the transaction: the MCP layer.
4. **Product** — three checkpoints: tool policy · transaction review + wallet-signature approval · audit chain.
5. **Proof** — attack table; mainnet signature; `audit --log` PASS; zero dependencies.
6. **Founder** — Japan–HK settlement, CFA, two prior mainnet acceptances, Rust/Solana.
7. **Business & roadmap** — open-core; paid team policy, Squads holds, attestations; complements Solana Foundation `pay`.
8. **Ask** — design partners with real funds.

## F. Builder updates

**#1 (Sat night)**
> Day 1 of SolFrontier Gate: an MCP firewall between AI agents and Solana wallet servers. Today Claude Desktop tried to send 5 SOL through a wallet server behind Gate and got a structured refusal before the server ever saw the call. A 0.001 SOL transfer went through only after I approved it with a Phantom signature on a loopback page. Devnet tx: <SIGNATURE>. Next: Jupiter on mainnet, and a scripted compromised-agent attack suite.

**#2 (Sun night)**
> Day 2: a real Jupiter swap on mainnet, decoded and simulated before signing, approved by wallet signature, and re-verified from the hash-chained audit log: <SIGNATURE>. The compromised-agent suite (overspend, unknown destination, blind-signing drain, token delegation, rogue server, unlisted tool) is refused 6/6. Zero npm dependencies.
