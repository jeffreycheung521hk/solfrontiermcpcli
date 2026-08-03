# Engineering record

State of this repository as of **2026-08-03**, at commit `02ea37a`.

- 19 commits, 42 tracked files, ~4,300 lines of JavaScript, zero runtime
  dependencies
- 134 tests in 27 suites, every one of them offline
- CI: green on `windows-latest` and `ubuntu-latest` × Node 20 and 22

The first version of this file was written on 2026-08-02 *before* the first
real-money run, so that the known-good state was captured independently of
whatever that run produced. That run failed; the incident section below is
the result, and the sections after it are the repairs.

## What this is

A shell client for MCP servers. Its companion,
[solfrontier-mcp](https://github.com/jeffreycheung521hk/solfrontiermcpskeleton),
is a concluded, policy-gated Solana control plane. That project is never
modified by this one: it is executed as a child process and nothing more.

The design brief was a single sentence — *"write a CLI"* — from a senior
engineer looking at the MCP server. The interpretation chosen here was to
build a **client**, not to add subcommands to the concluded server, because:
MCP is a public protocol, so the other end of the pipe is a legitimate and
independent place to put new code; and the server had already been formally
concluded with an open debt register, which reopening would have undone.

## Architecture

```
src/
  index.mjs              dispatch; validate → config → THEN spawn
  cli/
    exit-codes.mjs       the 0/1/2/3/4 contract as typed errors
    output.mjs           stdout = result only; stderr = everything else
  config.mjs             precedence + all three guardrails
  mcp/
    framing.mjs          newline-delimited JSON (isolated, property-tested)
    session.mjs          spawn, correlate, time out, shut down
  solana/
    rpc.mjs              minimal JSON-RPC client, endpoint always redacted
    solend.mjs           reserve decoding + supply-APR math (WAD/BigInt)
  commands/
    doctor.mjs  audit.mjs  flow.mjs        the three that carry the thesis
    tools.mjs   call.mjs   intent.mjs      discovery, generic call, wrappers
```

The layering rule: commands never touch a pipe, and the transport never
knows what a "quote" is.

## Verification status — what is proven, and what is not

| Area | Evidence | Status |
|---|---|---|
| Framing across chunk boundaries | 200 randomized splittings + mid-UTF-8 splits + byte-at-a-time | **proven** |
| Transport failure modes | fake server: hang, garbage, mid-session death, wrong id, RPC error, tool error | **proven** |
| Money math | exact conversions; values floats would corrupt; over-precision rejected | **proven** |
| Schema coercion and validation | integer/number/boolean/array, unknown keys, missing required | **proven** |
| Guardrails | acceptance paths (incl. symlinks), secret keys in config, `watch` in args | **proven** |
| Validation-before-spawn | usage errors returned with a deliberately broken binary path | **proven** |
| Six tools against the real server | 9 integration tests, real binary, temp database | **proven** |
| `doctor` | live run: correct GO with real chain data; NO-GO on impossible threshold | **proven** |
| `audit` | live run against the published acceptance record: 13 claims re-derived | **proven** |
| `flow` — preflight, propose, finalize, URL | dry-run, plus a live mainnet run on 2026-08-02 | **proven** |
| Exact funding proof (selection → fetch → validation) | 28 tests driving the real captured 2026-08-02 payload | **proven offline** |
| Replay defence (a payment older than the intent) | slot floor; 5 tests, including one the signature baseline cannot catch | **proven offline** |
| Secrets withheld from spawned binaries; output redaction | 9 tests | **proven** |
| `flow` — approval cutoff, funding deadline, reconciliation window | 23 fake-clock tests, boundaries on both sides of all three | **proven offline** |
| Stranded funds are recorded but reported as failure | exit code, label and event asserted separately from `recorded` | **proven offline** |
| Funding orchestration (candidate → proof → confirm → `budget_reserved`) | 5 hermetic end-to-end runs against a fake RPC and fake MCP server | **proven offline** |
| Executor lease and execution | **none — and out of scope here** | **not this repository's** |

The last row is a boundary, not a gap. `watch --execute` is a separate
process owned by the server repository, and this CLI never executes anything;
what it can prove is whether a lease is still *possible*, and that it reports
that honestly. Simulating the executor here would be theatre.

Everything above is offline. No amount of it substitutes for a live run, and
a live run remains NO-GO until the funds question is settled — but each of
these was written because something went wrong, and each would have caught it.

## Incident, 2026-08-02: 0.2 USDC transferred and not recorded

The `flow` funding path was exercised on mainnet for the first time. It
failed, and the failure is worth more than the success would have been.

**What happened.** The user's payment was correct and on time: memo exact,
amount exact, the registered payer as signer, finalized at 13:29:34Z against
a 13:32:13Z deadline — 159 seconds inside the window. The client counted down
to zero and reported that no funding transaction had appeared. The money had
left the wallet; the database still said `funding_required`.

**Root cause.** The run was driven by the PowerShell demo harness
(`Demo.ps1 -Mode Live`), not by the `flow` command. Its polling loop carried
a prefilter that compared `getSignaturesForAddress`'s `memo` field for exact
equality — but that field is a *summary*, formatted `"[byte_len] memo"`, with
multiple memos joined by `"; "`. The one correct transaction failed that
comparison, was added to a seen-signature blacklist, and was never passed to
the verifier for the remaining 159 seconds. The verifier itself would have
accepted it: it read the memo as a substring of the logs.

**A second, larger defect was found while fixing the first.** The `flow`
command — the product, not the harness — had never been used for a live run,
and its detection was worse: it accepted *any* successful signature on the
destination ATA after the baseline, without fetching the transaction or
checking memo, payer, amount, accounts or balances at all. The server would
have rejected a wrong signature, but `flow` had already stopped scanning, so
the real payment would never have been found. Had the demo been driven by
`flow` instead, the same money would have been lost by a different route.

**Why the tests did not catch it.** Fifteen regressions existed for the
memo comparison. All of them handed a transaction straight to the validator,
but the defect lived one layer earlier, in selection. A reintroduced prefilter
would have left every one of them green. A test written for a bug that cannot
reproduce that bug is worse than no test: it advertises cover that is not
there.

**What changed.** Verification moved into `src/solana/funding-proof.mjs` and
`flow` now uses it. Selection is pure and blind to memo content; it may
exclude only a failed transaction, one present before the run, or one already
judged. Validation reads the instructions — exactly one outer Memo equal to
this run's, exactly one `transferChecked` with every field pinned, and both
token accounts moved by exactly the amount, bound by `accountIndex` from the
transaction's own `accountKeys` rather than by owner+mint first match. The
regressions now drive the real captured payload, prefix and all, through
selection, fetch and validation.

The single deadline was also split in two: past the **signing cutoff**
nothing new may be approved, while the **reconciliation window** keeps
searching for a further 90 seconds, because a payment can be on chain and on
time while the RPC is slow to list it, and stopping at the cutoff is exactly
how funds get transferred with nothing recorded. That first split placed the
signing cutoff *at* the funding deadline, which was still wrong — see
"Signing on time is not the same as signing in time" below.

**Two further boundaries were found in that fix, before it was ever run.**

A *replay* boundary: intent ids are deterministic from
`(threshold_bps, amount_raw)`, so re-running identical parameters produces an
identical memo, and `confirm_funding` checks only that a payment is not too
late — it has no lower bound. The signature baseline that was supposed to
exclude old payments was 25 entries deep while the search scanned 100, so an
identical pre-run transaction ranked 26th or later was invisible to it and
would have passed the exact proof. Deepening the window only moves that edge;
the fix is a **slot floor** captured before the intent exists, which is exact
regardless of history depth. The baseline remains as a cheap second line, now
at the same depth as the search.

A *confirmation* boundary: the confirm loop was gated on the reconciliation
deadline, so a payment proven just as that deadline passed produced **zero**
`confirm_funding` calls — money on chain, nothing recorded, which is the very
failure the reconciliation window exists to prevent. The first attempt is now
unconditional; only retries are bounded, by their own budget measured from
the moment of proof.

**Disposition of the funds.** Two amounts of 0.2 USDC now sit in the
controlled ATA and cannot be executed, both because their funding deadline
passed before a lease could be taken:

| Intent | Cause | Status |
|---|---|---|
| `5b000000…` (2026-08-01) | executor started 107 s after the deadline | written off |
| `58000000…` (2026-08-02) | this incident; later confirmed to `budget_reserved` | written off |

The second was reconciled by a single authorised `confirm_funding` call, so
the chain and the database now agree: `budget_reserved (expired,
unexecutable, manual reconciliation required)`. The owner has elected to
write both off rather than pursue recovery.

**This closes no debt.** `DEBT-P2-FUNDING-1` in the server repository stands
unchanged: there is still no refund handler, no complete auditable manual
procedure, and no pagination or row-level isolation in the bounded scans.
Writing off specific funds is not the same as fixing the reason they were
strandable, and refund logic does not belong in a demo harness.

An independent cross-check that did land: `propose --amount 0.2
--threshold-bps 90` reproduces draft hash
`919f478e954582cece630e6b486edf4373d87daa3a64caea6b6aef3291d2fbbd`, byte-identical
to the value recorded in the 2026-08-01 acceptance document. Two independent
implementations agree on the canonical hash.

## Signing on time is not the same as signing in time

Found by review on 2026-08-03, before any further funds were committed, and
fixed in `02ea37a`.

Both stranded amounts were paid **inside** their funding window and both are
permanently unexecutable. That is not a coincidence, and treating the funding
deadline as the signing cutoff is what allows it: a payment approved one
millisecond before expiry is on time by every check the system performs, and
still doomed, because signing is not the last step. After it come reserve
freshness, RPC visibility, confirmation, and the executor's scan, final
revalidation, CAS lease, simulation, policy and broadcast. None of them have
any time left.

So there is now an approval cutoff, earlier than the funding deadline by a
budget **derived from its parts rather than chosen**:

| Component | Budget | Where the figure comes from |
|---|---|---|
| Solend reserve refresh | 60 s | measured 2026-08-01: fresh ~6.4 s in every ~60 s |
| RPC visibility + one confirm | 20 s | the client's default per-request timeout |
| Executor cycle | 40 s | scan, revalidation, CAS, simulation, policy, sign, broadcast |
| **Total** | **120 s** | |

In a 180-second window that leaves a human the first 60 seconds. A test
asserts the total equals the sum of its components, so a future edit that
lowers the figure without changing the reasoning fails the build.

Between the approval cutoff and the funding deadline the run enters a **grace
period**: nothing new may be approved, but anything already broadcast is
still searched for and confirmed. Countdowns pace against the approval
cutoff, because the funding deadline is not the number a human should be
working to.

**A green exit over stranded money.** Separately, a `budget_reserved` that
had already expired exited `0`. The JSON said `executable: false` while the
exit code — the part automation actually reads — said success. Two questions
had been merged that are not the same question:

- **`recorded`** — did the payment reach the chain and the ledger agree? For
  money that has moved, this must be true even when it is too late to use,
  or the database and the chain diverge.
- **`runSuccess`** — did the run achieve what it set out to? Funds that can
  never be leased are a failed run, however tidy the bookkeeping.

`flow` now exits non-zero when the funds are unusable, and emits
`confirm.recorded_but_expired` rather than `confirm.ok`, so an audit reading
the event stream finds no success marker over stranded money.

## Design decisions and why

**Validation strictly before spawning.** A missing flag costs exit 2 and
nothing else: no process, no database migration. Validating inside the
command — after a session exists — makes a usage mistake surface as a
transport error, which sends you debugging the wrong layer. This ordering is
enforced in `index.mjs` and regression-tested by pointing `SFCLI_BIN` at a
path that does not exist and asserting exit 2.

**A malformed server line is fatal, not skipped.** Skipping it leaves the
request unresolved until the timeout, converting "the server is broken" into
"the client is slow". The client fails every in-flight request immediately
with a transport error and the offending line.

**Framing is a separate module.** Chunk boundaries are chosen by the OS, so
this is the likeliest place for a bug that only appears under load on someone
else's machine. `StringDecoder` holds partial multi-byte sequences; a naive
`chunk.toString()` would emit U+FFFD and silently corrupt payloads.

**Server stderr is kept, not discarded.** Draining it is mandatory — a full
pipe blocks the child — but throwing it away makes startup failures
invisible. A 40-line ring buffer is surfaced whenever something fails.

**Exit codes distinguish "no" from "wrong".** `1` is the world saying no
(tool error, not-found, NO-GO); `2` is the caller being wrong. Only the
second is fixable by editing the command line. `not_found` returning 1
follows grep's 1973 convention, which scripts already rely on.

**Guardrails are code, and honestly labelled.** They live in `config.mjs`
and run before any spawn. They are described as defence against operator
mistakes, not as a security boundary, because a determined caller can copy a
file or edit the config — claiming more would be false assurance.

**`flow` refuses conditions that cannot be met.** If supply APY does not
exceed the threshold, funding would strand the money permanently
(`DEBT-P2-FUNDING-1` in the server: there is still no refund handler). The
command exits before proposing rather than letting the deadline discover it.

## Three bugs CI caught that local testing did not

Recorded because each is a category, not an accident.

1. **`node --test "test/*.test.mjs"` only expands globs on Node 22+**, while
   `package.json` declares Node 20 as the floor. Passing `test/` instead is
   worse: Node treats every `.mjs` under a test directory as a test file and
   would execute `fake-server.mjs`, which waits on stdin forever. Fixed with
   an explicit discovery script.

2. **The secret scanner matched its own detector.** `config.mjs` contains a
   regex listing `api.?key|secret|keypair` precisely to reject such config
   keys; the scanner flagged that line. A check that cries wolf is a check
   that gets disabled.

3. **The scanner could not catch a real secret.** `grep -rInE` uses `-I`
   (skip binary), not `-i` (ignore case), so `apiKey` never matched. The
   scan had been reporting "no secret material found" while being incapable
   of finding any. It now runs a **positive control first** — plants a fake
   secret and fails the build if the detector misses it — because an unproven
   detector issuing a clean bill of health is worse than no detector.

## Known limits

- `flow`'s real funding path is unproven end to end (see the table above).
- **No `--resume`.** A half-working recovery path is more dangerous than
  none: it invites a second attempt on an intent whose true state is
  unknown. Left deliberately unbuilt rather than half-built.
- The client cannot verify off-chain steps. Simulation, policy evaluation,
  the CAS lease and operator activation leave no ledger trace; `audit`
  reports them as outside its reach rather than implying coverage.
- `audit` extracts claims from prose. It normalizes typeset numerals
  (thousands separators, U+2212 minus, en dashes), but a document formatted
  in some way not anticipated will yield fewer claims — reported as counts
  up front, so a silent zero cannot masquerade as a pass.
- No packaging. There is no single-file executable and nothing is published
  to npm; it runs from source with Node ≥ 20.

## First real-money demonstration — CONSUMED, do not rerun

Recorded before it ran, and left unedited afterwards so the plan can be read
against the outcome. **It ran on 2026-08-02 and failed**; see the incident
above. Everything it pins is now spent:

- the intent `58000000400d0300000000009a62dace` is consumed and its funding
  is stranded;
- the database `scratch/demo-20260802-run.db` and the run directory
  `scratch/demo-live-20260802/` hold that run's evidence and must be kept;
- `scripts/demo/Demo.ps1` pins a CLI source tree that this repository has
  since moved past, so its runtime pin will correctly refuse to run.

Any future attempt needs a fresh threshold and intent, a virgin database, a
new run directory, and a re-review of every pin. The original plan follows,
unchanged.

- **Amount** 0.2 USDC. **Threshold** 88 bps — deliberately not 90 or 91,
  both consumed on 2026-08-01. `intent_id` is deterministic from
  `(threshold_bps, amount_raw)`, so a fresh threshold guarantees a distinct
  identity and a distinct on-chain memo.
- **Database** `scratch/demo-20260802.db` inside this repository. Not under
  `data/acceptance/` — that directory holds audit evidence, and this
  client's own guardrail refuses it. This is a demonstration, not a formal
  acceptance; the concluded project's evidence is unaffected.
- **Order** executor started first, then `flow`. Reversing it is what lost
  the 2026-08-01 attempt.
- **Rehearsal first** with `flow --dry-run`, which exercises preflight,
  propose, finalize and URL generation at zero cost.
- **Accepted risk** if the window is missed, 0.2 USDC is stranded with no
  refund path, exactly as on 2026-08-01.
