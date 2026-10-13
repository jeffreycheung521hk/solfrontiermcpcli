# SolFrontier Gate

**An MCP firewall between AI agents and Solana wallets.** Gate applies pass / bound / deny policy to tool calls, decodes and simulates transaction-bearing requests, and holds them for a human wallet-signature approval. Decisions are recorded in a hash-chained audit log. The Node core uses built-ins only and has zero npm runtime dependencies.

**Mainnet proof, 2026-10-12:** a human signed **0.001 SOL → USDC** in Phantom, a separate Gate Approver approved the exact message, and Jupiter executed the swap. Finalized receipt: **0.111685 USDC**; total SOL outflow **0.002494861**, below the **0.003 SOL** cap. [Evidence and scope](docs/proof/mainnet-2026-10-12/proof.md) · [Solana Explorer](https://explorer.solana.com/tx/55sa9vBAXo1Qh8jYgrqzWf1uZNcGMxyCtM5UVHUcxEEQrJFr7P6zqLFYpA2xort9Ku85Nzt3zL51YW9g2ZmNkDdh).

This mainnet run used a Phantom payer page and a Jupiter HTTP adapter around Gate's tool-argument pipeline. It does not claim a Claude Desktop or unmodified Jupiter MCP mainnet session. The optional payer page uses an externally supplied web3 browser bundle; it is separate from the built-in-only Node core.

## Gate paths

```text
Agent host → Gate tool policy → downstream MCP tools
               └ transaction argument → review → human approval → forward
Downstream → loopback RPC checkpoint → review → human approval → send
```

- Unlisted tools are denied and hidden; permitted calls can be bounded by argument constraints.
- Transactions are reviewed as tool arguments or intercepted at the loopback RPC checkpoint.
- Approval binds the exact message hash, hold, cluster, summary and expiry; a changed message needs a new approval.
- Errors, rejected signatures, cancellation and expiry refuse execution.
- Audit records precede effects, and landed message hashes can be checked against the approval.

[Build specification](docs/hackathon/SPEC.md) · [Devnet MCP setup and hermetic attack demo](scripts/demo/GATE.md) · [Phantom companion and timing fix](scripts/hackathon/phantom/README.md) · [Technical video script](docs/hackathon/DEMO-SCRIPT.md).

The mainnet companion uses a shared 20-second local order cap, a 9-second signing-start cutoff, a 12-second payer-signature acceptance cutoff, and an approval hold of at most 12 seconds within the remaining window. It reserves 2 seconds before execution and keeps chain freshness checks. Expiry stops the attempt; quote refresh and another attempt require manual action.

## Gate limits

- **L1** The RPC checkpoint only sees transactions sent through it. A malicious downstream can
  ignore `RPC_URL` and talk to a public endpoint, or post to a third-party API (Jupiter Ultra
  does this by design — which is why tool-argument review exists). Against a malicious server
  the bound is the petty-cash balance.
- **L2** A malicious downstream can exfiltrate the petty-cash key. Same bound.
- **L3** Simulation predicts; it does not guarantee. State can change between simulation and
  landing. The human approves exact message bytes; slippage protection belongs to the
  transaction itself.
- **L4** Cross-program invocations are not decoded for display. Policy relies on simulated
  balance deltas of the wallet's own accounts for net effect.
- **L5** An agent with control of the user's browser or desktop could press the wallet's
  approve button. Do not give the agent computer-use while Gate is guarding funds.
- **L6** One approver, one machine. Multi-approver (Squads) is roadmap.

## Gate lineage

Gate was added during the 2026-10 hackathon on top of this repository's earlier MCP client. Existing transport, CLI scaffolding, redaction helpers and audit ideas were reused; the [submission disclosure](docs/hackathon/SUBMISSION.md#development-history-paste-into-the-disclosure-field) describes the work and AI assistance. The legacy README below is preserved in full, including its historical evidence and limitations.

---

# solfrontier-cli

A shell client for [Model Context Protocol](https://modelcontextprotocol.io)
servers, built around three ideas that most MCP tooling leaves out:

1. **Talk to any MCP server from a script.** No LLM host, no chat window —
   spawn, handshake, call, exit with a meaningful code.
2. **Know before you commit.** `doctor` checks every precondition of a run,
   including live on-chain conditions, and tells you GO or NO-GO.
3. **Verify claims instead of trusting them.** `audit` reads a published
   acceptance document and re-derives every on-chain assertion from the
   ledger.

Zero runtime dependencies. Node ≥ 20 built-ins only.

```powershell
npm run setup
node src/index.mjs doctor
node src/index.mjs tools list
```

## Why this exists

Its companion project, [solfrontier-mcp](https://github.com/jeffreycheung521hk/solfrontiermcpskeleton),
is a policy-gated, fail-closed Solana control plane that completed a real
mainnet execution acceptance on 2026-08-01 — and, that same day, lost an
earlier attempt to nothing more exotic than **ordering**. Every manual step
ran before the executor was started; by the time it was, the 180-second
funding window and the on-chain slot deadline had both passed. The gates
correctly refused to act. The money was stranded.

That afternoon produced three lessons, and each is a command here:

| Lesson | Command |
|---|---|
| Most failures are knowable *before* you start | `doctor` |
| The machine parts must be instant so the human is on the critical path once | `flow` |
| A published claim should be checkable by strangers | `audit` |

## Commands

```
sfcli doctor      preflight every precondition; GO / NO-GO
sfcli audit       verify an acceptance document against the chain
sfcli flow        run the funding sequence in the correct order
sfcli tools       list a server's tools, or describe one's schema
sfcli call        call ANY tool on ANY MCP server, checked against its schema
sfcli quote|position|status|propose|finalize|confirm    solfrontier shortcuts
```

### `doctor` — will this work right now?

```powershell
node src/index.mjs doctor --threshold-bps 90
```

```
PASS  server binary              solfrontier-mcp.exe (5,639,680 bytes)
PASS  MCP handshake              solfrontier-mcp 0.1.0, 6 tools
PASS  SOLFRONTIER_RPC_URL        set (value never displayed)
PASS  controlled wallet keypair  not present in this environment
WARN  reserve freshness          age 78 slots exceeds the 16-slot gate...
PASS  supply APY                 181 bps (1.81%), utilization 69.45%
PASS  condition vs threshold     181 bps > 90 bps — condition is met

GO — 6 checks clean, 2 warning(s)
```

`--sample-seconds 60` additionally measures how often the reserve is fresh
enough to execute against, turning a folk fact into a number for your run.

### `audit` — don't trust the document, check it

```powershell
node src/index.mjs audit ../solfrontiermcpskeleton/docs/phase3b-2-mainnet-acceptance.en.md
```

```
PASS   hpVwPcMw… finality                     finalized
PASS   hpVwPcMw… slot                         436548513 asserted in document
PASS   2wsxko7H… memo binds intent 5a000000…  present in transaction logs
PASS   balance Controlled USDC ATA 7LFdKcSV…  1253487 → 1053487  matched on chain

VERIFIED — 13 claims re-derived from the ledger, 1 not independently checkable
```

Claims it cannot check are reported as `UNVER`, never counted as passes. An
audit tool that hides its own blind spots is worse than none.

### `call` — a generic MCP client

Arguments are validated against the tool's own `inputSchema` and coerced to
the declared types before anything is sent:

```powershell
node src/index.mjs call get_quote --set input_mint=So111... --set amount=100000 --set slippage_bps=50
node src/index.mjs call some_tool --set text=hi --dry-run   # show the payload, send nothing
```

## Configuration

Precedence: **flags > environment > config file > defaults**.

```json
{ "serverBin": "C:/path/to/solfrontier-mcp.exe", "dbPath": "scratch/dev.db", "timeoutMs": 20000 }
```

`SOLFRONTIER_RPC_URL` is **environment-only** and is never printed, logged,
or returned — a config file containing it (or any other secret-looking key)
is rejected outright.

## Exit codes

| Code | Meaning |
|---:|---|
| 0 | success |
| 1 | ran fine, the answer is negative (tool error, not-found, NO-GO) |
| 2 | you called it wrong, or a guardrail refused |
| 3 | transport broke (spawn failed, protocol error, server died) |
| 4 | a deadline expired |

`1` versus `2` is "the world said no" versus "you asked wrong". Only the
second is fixable by editing your command line.

## Guardrails

Enforced in [`src/config.mjs`](src/config.mjs), before any process is spawned:

- **Acceptance databases are refused.** They are audit evidence of real
  mainnet runs, not scratch space. Symlinks are resolved before checking.
- **Secrets may not live in files.** Any config key matching
  `rpcUrl`/`apiKey`/`keypair`/`secret`/`private` is rejected with an
  explanation.
- **The executor is never spawned.** `watch` in `serverArgs` is refused.
  This client funds intents; it does not execute them and reads no keypair.

These defend against operator mistakes, not against a determined caller —
they are stated as what they are.

## Design notes

- **Validation happens before spawning.** A missing flag costs exit 2 and
  nothing else: no process started, no database migrated. Validating late
  makes a usage mistake look like a transport failure.
- **Framing is its own unit** ([`src/mcp/framing.mjs`](src/mcp/framing.mjs))
  and property-tested across 200 randomized chunk splittings, including
  splits mid-UTF-8-character. Chunk boundaries are chosen by the OS; this is
  the likeliest place for a bug that only appears on someone else's machine.
- **A malformed server line is a transport error, not a skip.** Skipping
  turns "the server is broken" into "the client timed out".
- **Server stderr is captured** into a ring buffer and shown when something
  fails, instead of being discarded.

## Testing

```powershell
npm test                                   # hermetic: fake server, no network
$env:SFCLI_REAL='1'; $env:SFCLI_BIN='...'; npm run test:real
```

The hermetic suite covers transport failure modes via a configurable fake
server (`--hang`, `--garbage`, `--die-mid`, `--wrong-id`, `--rpc-error`,
`--tool-error`, `--split-utf8`). The real-server suite **fails** rather than
skips when its gate is unset, so a misconfigured CI job cannot report a false
green.

## Project state

[`docs/ENGINEERING.md`](docs/ENGINEERING.md) is the engineering record: the
architecture, the design decisions and their reasons, and — most usefully — a
table of **what is proven versus what is not**, and an incident record for
2026-08-02, when `flow`'s funding detection missed a correct, on-time payment
and 0.2 USDC was transferred without being recorded. The root cause, the fix,
and the reason the existing tests could not have caught it are written up
there. Two areas remain unproven and are named as such: the new
cutoff-versus-reconciliation logic has no fake-clock tests yet, and the
end-to-end orchestration has never been exercised as a whole.

## Licence

MIT. All Solana addresses in this repository are public on-chain data.
