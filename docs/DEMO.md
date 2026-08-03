# Zero-fund demonstration

One command, about 20 seconds, reading real Solana mainnet and the real
concluded MCP server binary. **No money can move.**

```
node scripts/demo/showcase.mjs
```

Every output below was captured from an actual run on 2026-08-03, not written
from memory. Numbers that come from the chain will differ on yours.

## Why this and not a funding run

A funded run is an *acceptance*, not a demonstration, and it is gated behind
the refund work: it would create a third amount that can strand. See the NO-GO
sequence in [ENGINEERING.md](ENGINEERING.md).

This is also, for a technical audience, the better artefact. A successful
funding run proves one attempt went well. What follows proves the system can
**refuse**, that its claims are **re-derivable from the ledger**, and — with
the defect ledger alongside it — that the project knows what it does not know.

## Prerequisites

| | |
|---|---|
| `SOLFRONTIER_RPC_URL` | set in the shell. Never printed, never read from a file or flag. |
| `sfcli.config.json` | `serverBin` pointing at `solfrontier-mcp.exe`, `dbPath` at a scratch database |
| `SOLFRONTIER_CONTROLLED_WALLET_KEYPAIR` | **must NOT be set.** The script aborts if it is. |

That last row is deliberate: a demo shell holding the signing key is one typo
away from being an execution shell. Use a clean shell.

If `SOLFRONTIER_RPC_URL` is absent the script skips the live stages and says so
rather than failing in a confusing way.

## What it refuses to do

Checked against the argv of every spawned command immediately before spawning,
so editing a stage cannot quietly turn this into a run that spends money:

- **never `--user-wallet`.** `flow --dry-run --user-wallet` performs a *real*
  finalize — it writes a database row, starts the 180-second clock and prints a
  genuinely signable URL.
- **never `watch`,** with or without `--execute`.
- **never reads a keypair.**

Each stage also asserts its **exact** expected exit code. An earlier draft
asserted only "non-zero" for the two refusal stages; when the entry-point path
was wrong, every stage died with exit 1 and those two reported themselves green
while proving nothing. A demonstration whose failure cases pass for the wrong
reason is worse than one with no failure cases. The script exits non-zero if
any stage produces the wrong code.

## The stages

### 1. The protocol works — ~2s

```
$ sfcli tools list
solfrontier-mcp 0.1.0 - 6 tools

confirm_funding   finalize_intent   get_intent_status
get_position      get_quote         propose_intent
```

MCP stdio handshake, JSON-RPC 2.0, against the unmodified server binary. The
CLI is a *client*: the concluded project is executed as a child process and
never edited.

### 2. Preflight against live mainnet — ~3s

```
$ sfcli doctor --threshold-bps 50

PASS  server binary              solfrontier-mcp.exe (5,639,680 bytes)
PASS  database file              scratch\dev.db (376,832 bytes, migrated)
PASS  MCP handshake              solfrontier-mcp 0.1.0, 6 tools
PASS  SOLFRONTIER_RPC_URL        set (value never displayed)
PASS  controlled wallet keypair  not present in this environment
WARN  reserve freshness          not fresh: age 142 slots is outside 0..16.
                                 The executor will wait, and retry safely.
PASS  supply APY                 187 bps (1.87%), utilization 70.84%
PASS  condition vs threshold     187 bps > 50 bps - condition is met

GO - 7 checks clean, 1 warning(s)
```

Real reserve decoding, real WAD arithmetic, real slot clock. Two details worth
pointing at:

- The RPC URL is confirmed present and **never displayed**.
- The freshness reason names the condition that actually failed. Freshness is
  three conditions (stale bit clear AND age within 0..16); until this week the
  message blamed age for all of them, so a reserve at age 0 with a refresh
  pending was reported as exceeding a gate it was inside.

### 3. It can say no — ~1.5s, **exit 1**

```
$ sfcli doctor --threshold-bps 9999

FAIL  condition vs threshold  187 bps is NOT above 9999 bps - the executor
                              would never fire. Lower the threshold or wait.

NO-GO - 1 blocking failure(s)
```

A gate that cannot refuse is not a gate. This is the reason a `GO` means
something.

### 4. Audit a published record — ~3s

```
$ sfcli audit ../solfrontiermcpskeleton/docs/phase3b-2-mainnet-acceptance.en.md

auditing ...: 3 transaction(s), 1 memo binding(s), 1 balance row(s)

PASS   hpVwPcMw... finality              finalized
PASS   hpVwPcMw... slot                  436548513 asserted in document
PASS   2wsxko7H... memo binds intent     claw:w5h:5a000000...:a28eaf63...
PASS   balance Controlled USDC ATA       1253487 -> 1053487  matched on chain
UNVER  5caGiE8S... slot                  document does not assert this slot

VERIFIED - 13 claims re-derived from the ledger, 1 not independently checkable
Off-chain steps (simulation, policy, CAS lease, operator activation) leave no
ledger trace and are outside what any tool can verify from public data.
```

This is the strongest stage. It takes the acceptance document the project
published, extracts its factual claims, and **re-derives each one from the
chain** — signatures, finality, slots, the memo binding the payment to its
intent, and the exact balance delta on the controlled ATA.

The `UNVER` row and the closing sentence matter as much as the passes: the tool
reports what it *cannot* check rather than implying coverage it does not have.

### 5. The funding sequence, dry — ~6s

```
$ sfcli flow --dry-run --amount 0.2 --threshold-bps 1

reserve: 187 bps supply APY, age 12 slots (fresh)
{"type":"baseline.captured","count":26,"notBeforeSlot":436934420}
proposed: draft c04ae4733930...
dry run: stopping before finalize (no --user-wallet given)

  "persistence":  { "db_row_exists": false, "note": "No DB row exists at this point" },
  "side_effects": { "database_writes": 0, "network_calls": 0, "signatures": 0 }
```

Preflight, the replay slot floor, and a canonical draft hash — with the server
itself attesting zero writes and zero signatures.

It stops before finalize on purpose. Point out what the next step *would* do
(a row, a 180-second clock, a signable URL) and that the whole path beyond it
is covered by 8 hermetic end-to-end tests against a fake RPC and fake server.

Compare the reserve age here (12, fresh) with stage 2 (142, not fresh) — that
is the ~6-seconds-in-60 refresh cadence visible live, and it is why the
post-signing budget reserves a full refresh cycle.

### 6. Refusing to spend a window it cannot win — ~2s, **exit 1**

```
$ sfcli flow --dry-run --amount 0.2 --threshold-bps 9999

error condition cannot be met: supply APY 187 bps is not above
--threshold-bps 9999. Funding now would strand the money (there is no
refund handler).
```

It exits *before* proposing. Funding an unsatisfiable condition would leave the
money in the controlled ATA with no way back — which has happened twice, for
different reasons, and is why the message says so plainly.

### 7. What is proven without the chain

```
npm test    # 164 tests, all offline
```

Framing across chunk boundaries, transport failure modes, exact funding proof
driven by the real captured mainnet payload, replay defence, the three
deadlines on a fake clock, server-authoritative expiry, refund proof and crash
recovery, and 8 hermetic end-to-end funding runs.

## Timing

| Stage | Exit | Time |
|---|---|---:|
| 1 `tools list` | 0 | 2.3s |
| 2 `doctor` | 0 | 2.8s |
| 3 `doctor` impossible | 1 | 1.4s |
| 4 `audit` | 0 | 2.9s |
| 5 `flow --dry-run` | 0 | 5.8s |
| 6 `flow` impossible | 1 | 2.1s |
| 7 `--version` | 0 | 1.3s |
| **total** | | **18.5s** |

Add a minute for `npm test` if you want the offline suite live.

## If someone asks "but has it moved real money?"

Answer plainly: **yes — in both directions, and the failures are the more
interesting half.**

Three funding attempts stranded money in the controlled ATA: 0.1 USDC on
2026-07-29 (Phase 2 verified funding only and had no executor), 0.2 USDC on
2026-08-01 (the executor was started 107 s after the deadline), and 0.2 USDC on
2026-08-02 (a memo prefilter compared a field the RPC formats as a summary).

On 2026-08-03 **all three were recovered**, through the full gate chain, each
with both balance deltas verified exact at `finalized` before the ledger was
touched. Stage 4b re-derives those three transactions from the chain in front
of the audience. The controlled ATA went 1253487 → 753487 raw: exactly 500000,
not a lamport more.

The detail worth telling: **the first refund attempt refused to run.** It
halted on a missing journal and moved nothing. The halt was right in kind — a
missing journal can mean the record of an already-signed transaction was
deleted, and re-signing there is how a double refund happens — but the
reasoning was incomplete, because on a first refund the journal legitimately
does not exist yet. The fail-closed default caught an error in its own author's
reasoning rather than letting it through.

Then show them the ledger in [ENGINEERING.md](ENGINEERING.md): 48 defects found
by auditing every commit, three still live at audit time, and an honest table
of where the catches came from — human review found most, losing money found
one, CI found three, and the unit tests found none.

What is still not proven: a funding run that completes end to end. That remains
the open item, and it is now a survivable experiment rather than a one-way bet,
because money that strands can be returned.
