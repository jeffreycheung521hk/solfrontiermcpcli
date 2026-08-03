# Engineering record

State of this repository as of **2026-08-03**, at commit `6211a82`.

- 22 commits, 42 tracked files, ~4,500 lines of JavaScript, zero runtime
  dependencies
- 146 tests, every one of them offline
- CI: green on `windows-latest` and `ubuntu-latest` × Node 20 and 22
- No live funding run has ever succeeded. See *Mistakes and challenges*.

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
| `flow` — preflight, propose, finalize, URL | dry-run only. The 2026-08-02 mainnet run was driven by `Demo.ps1`, not by `flow`; `flow`'s own funding path has never run against the chain | **dry-run only** |
| Exact funding proof (selection → fetch → validation) | 28 tests driving the real captured 2026-08-02 payload | **proven offline** |
| Replay defence (a payment older than the intent) | slot floor; tests include one the signature baseline cannot catch | **proven offline** |
| Secrets withheld from spawned binaries; output redaction | 11 tests | **proven** |
| `flow` — approval cutoff, funding deadline, reconciliation window | 32 fake-clock tests, boundaries on both sides of all three | **proven offline** |
| Server-authoritative expiry (wall clock *and* WatchRule slot) | booleans re-derived from their own inputs; absent fields report unverified, never success | **proven offline** |
| Signing handoff withheld past the approval cutoff | asserted absent from stdout, JSON and the event stream | **proven offline** |
| Stranded funds are recorded but reported as failure | exit code, label and event asserted separately from `recorded` | **proven offline** |
| Funding orchestration (candidate → proof → confirm → `budget_reserved`) | 8 hermetic end-to-end runs against a fake RPC and fake MCP server | **proven offline** |
| Executor lease and execution | **none — and out of scope here** | **not this repository's** |

Counts above are derived per row from the suite each one names, not from a
commit's total test delta — an earlier version of this table claimed 23
fake-clock tests because that was the number a commit added, not the number the
file contains.

The last row is a boundary, not a gap. `watch --execute` is a separate
process owned by the server repository, and this CLI never executes anything;
what it can prove is whether a lease is still *possible*, and that it reports
that honestly. Simulating the executor here would be theatre.

Everything above is offline. No amount of it substitutes for a live run, and
each of these was written because something went wrong — but a test that
would have caught a known defect is not evidence about the next one.

**A further funding run is NO-GO.** The agreed sequence, in order, is: finish
the mechanical cutoff and server-authoritative expiry work (done, see below);
build the live-safety harness items; reopen the server repository for an
exact-intent refund/reconciliation slice developed entirely offline with fault
injection; refund exactly one of the two stranded 200000-raw intents, with the
signed bytes persisted before broadcast so an ambiguous outcome can only be
resolved by resending the same transaction, never by signing a new one; mark it
refunded only after `finalized` with both balance deltas exact. Only after that
acceptance does a third funding run come back into scope.

## Incident, 2026-08-02: 0.2 USDC transferred and not recorded

A funding run was attempted on mainnet for the first time, driven by the
PowerShell demo harness. It failed, and the failure is worth more than the
success would have been.

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

## Mistakes and challenges

Every commit in this repository's history was audited to build this section —
diff by diff, with each claimed defect independently checked against the diff
that introduced it and against the code at HEAD. It found **48 defects**. Three
of them were still live at the time of the audit and were fixed as a result;
the rest are history.

They are grouped by failure *mode* rather than by date, because the dates are
not transferable and the modes are. Almost every entry is a variation on one
theme: **the thing that was supposed to catch the problem was itself the
problem.**

| Mode | What it means | Count |
|---|---|---:|
| The boundary was never drawn | No check existed at all, often because a default granted what nobody reviewed | 13 |
| The check was broken | A gate that could not fail, could not pass, or measured the wrong thing | 11 |
| The report was not honest | The code was right and the thing it told a human or a machine was not | 9 |
| The protocol was misread | A field meant something other than what it looked like | 5 |
| The platform lied | Windows, PowerShell 5.1 or Node behaved differently than the code assumed | 5 |
| The test could not reach the bug | Coverage existed one layer away from the defect | 3 |
| Other | | 2 |
| | | **48** |

Counts come from the audit data, not from counting the bullets below — the
sections that follow give the representative cases, not all 48.

### The check was broken

The largest category, and the one worth internalising: a check that cannot
fail is worse than no check, because it issues a clean bill of health.

- **The secret scanner matched its own detector.** `src/config.mjs` contains a
  regex listing `keypair|mnemonic|…` precisely to reject such config keys. The
  scanner's `mnemonic` alternative matched that line. It was red on a clean
  tree from the first run.
- **The same scanner could not detect anything.** `grep -rInE` uses `-I` (skip
  binary), not `-i` (ignore case), so `apiKey` — the form this codebase
  actually uses — never matched. Its one alternative capable of finding a real
  credential was blind. The false positive above kept the step red, so its
  redness was fully explained and nobody asked whether the rest ever fired.
- **And it lost coverage while being repaired.** *(live until this audit)* The
  rewrite that fixed both of the above silently dropped `mnemonic` and
  `keypair` from the term list — `keypair` being the exact shape of
  `SOLFRONTIER_CONTROLLED_WALLET_KEYPAIR`, the one secret this project has. The
  positive control planted a single `apiKey`, so it certified the plumbing and
  said nothing about the coverage. There is now one probe per class.
- **The HEAD pin was its own fixed point.** The demo harness pinned the commit
  it was expected to run at. Committing the harness changed HEAD, so the pin
  could never be satisfied by the very act it existed to gate. The instruction
  at the time was explicit and correct: *do not just update the expected HEAD
  to make the check green.* It was replaced with pins on the content objects
  the run actually loads, which are invariant under commits that do not change
  what executes.
- **The freshness gate ran minutes before the action it guarded.** A Solend
  reserve is fresh for about 6 seconds in every 60. Checking it at preflight
  and acting on it at signing time is checking a different fact.
- **A commit shipped with its own check suite red**, because tightening a
  predicate and updating the fixtures it reads were split across two commits.
  Nothing mechanical could observe it: no CI job runs PowerShell.
- **The replay baseline was 25 deep while the search scanned 100.** Covered
  under the incident above; mechanically it belongs here — a defence whose
  coverage is a strict prefix of the set it must cover.

### The boundary was never drawn

- **The whole parent environment was handed to any spawned binary**, including
  every secret in it. `spawn` inherits by default, so there was no line in the
  diff to review — only an absent option. Defaults that grant capability are
  unreviewable for exactly this reason.
- **Redaction was applied at one exit and not the others.** The redactor was
  correct and tested; two verbose frame-dump paths never called it.
- **The clean-repo gate could not see untracked files.** `git diff` and
  `git diff --cached` are both index-relative, so a file Node would happily
  load was invisible to the gate meant to pin what Node loads.
- **The ASCII invariant was a sentence, not an assertion**, and then when it
  became an assertion it lived only in the offline `Check` mode — not on the
  path that spends money.
- **A hardening pass made a check weaker.** While rewriting balance
  verification, `accountIndex` binding was replaced with owner+mint first-row
  matching. More conditions, strictly less binding. This one was caught in
  review, not by a test, because the fixtures had no `accountIndex` field at
  all — they could not have failed.
- **An absent balance row was defaulted to zero** instead of being fatal.
  Absence of evidence became evidence of a value.

### The protocol was misread

- **`getSignaturesForAddress`'s `memo` field is a summary**, formatted
  `"[byte_len] memo"` and joining multiple memos with `"; "`. Comparing it for
  equality discarded the one correct transaction. This is the defect that cost
  0.2 USDC.
- **The genesis-hash pin used the CAIP-2 reference**
  (`5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`, 32 chars) rather than what
  `getGenesisHash` returns
  (`5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d`, 44 chars). Two specs publish
  near-identical identifiers for the same chain. My first diagnosis called it
  truncation; the correct identification came from review.
- **The funding deadline was treated as the signing cutoff.** A deadline the
  server enforces *on arrival* is not the deadline a human must work to — the
  human's cutoff is the server's minus everything that still has to run after
  the signature.
- **Retry logic used a deny-list** over another system's status vocabulary,
  which silently classifies every unanticipated value as final. Now an
  allow-list of known-transient values.
- **The generic `call` command read `status` from arbitrary payloads** and
  exited non-zero when it was not `"ok"` — interpreting a field whose meaning
  belongs to the peer, turning their success into our failure.

### The test could not reach the bug

- **Fifteen regressions existed for the memo comparison. All of them handed a
  transaction straight to the validator, and the defect was one layer earlier,
  in selection.** A reintroduced prefilter would have left every one green. A
  test written for a bug that cannot reproduce that bug advertises cover that
  is not there.
- **Deadline arithmetic was inlined in a polling loop** with `Date.now()` and
  no seam, so its coverage was structurally zero however many tests were
  written. Extracting `funding-window.mjs` *was* the test, not a tidy-up.
- **A policy constant the end-to-end harness could not shrink** made half the
  state machine unreachable in the only test that drives the real command.

### The platform lied

- **`[IO.File]::Replace($tmp, $path, $null)`** — Windows PowerShell 5.1
  marshals a bare `$null` into a `[string]` parameter as `""`, and the API
  rejects an empty backup path. Only the create branch had ever run, so the
  atomic-overwrite path had never executed. Independently reproduced in review
  before the fix was accepted.
- **`node --test "test/*.test.mjs"` only expands globs on Node 22+**, while
  `package.json` declares Node 20 as the floor. Authored on a version where it
  works.
- **Three em dashes in a BOM-less PowerShell script.** The script's own syntax
  check read the file through .NET's UTF-8-defaulting reader while
  `powershell.exe -File` decodes with the ANSI codepage — checker and executor
  used different decoders, so the checker could not see the corruption.
- **A rounded display value became a decision predicate.** Seconds-remaining
  was computed once, rounded for humans, and then compared against zero.
- **`$null -eq $obj.prop` cannot detect an absent property under
  `Set-StrictMode -Version Latest`** — it throws first, so the guard was dead.

### The report was not honest

The code was right; what it said was not. This category matters most because
these defects survive review — nothing crashes.

- **An expired `budget_reserved` exited 0.** The JSON said
  `executable: false` while the exit code — the part automation reads — said
  success. A caveat that reaches only the human-readable branch is not a
  caveat.
- **`describeOutcome` consulted only the client's wall clock**, which cannot
  see the WatchRule's *slot* deadline at all. A payment past it would have
  printed `confirm.ok`.
- **A commit message narrated a defect it had not fixed**, claiming to have
  corrected a wrong predicate when the diff showed something else: it had
  stopped trusting a correct upstream field and reimplemented it.
- **`doctor` blamed slot age for every non-fresh reserve.** *(live until this
  audit)* Freshness is three conditions; the message interpolated one. A
  reserve at age 0 with its stale bit set was reported as exceeding the 16-slot
  gate — untrue, and it sends the reader to the wrong cause. The harness
  learned the three-part definition; the product never did.
- **This document credited `flow` with a live mainnet run it never made.**
  *(live until this audit)* The 2026-08-02 run was driven by `Demo.ps1`. The
  narrative section retracted it; the status table above still carried it as
  **proven**, and a table is what people read.
- **This document also stated the superseded deadline policy** for one commit
  after the policy changed, and over-counted a test suite by taking the number
  from a commit's total delta rather than from the file the row names.
- **A comment claimed the 120-second budget was "precisely how both stranded
  amounts happened".** It was not. Both were paid with roughly 133 s and 159 s
  remaining, and that cutoff would have blocked neither; their causes were a
  late executor start and the memo prefilter. A speculative safeguard was
  written up as an explanation of events that had already occurred.

### Where the catches came from

Worth recording honestly, because it is not what the test count suggests.

| Caught by | Examples |
|---|---|
| **Human review** | the genesis-hash identification, the freshness predicate, `[NullString]::Value`, the `accountIndex` regression, the harness-vs-product gap, baseline depth, the last-round confirm gap, the approval cutoff, the exit code over stranded funds, the false claim about the stranded amounts, and the server's slot authority |
| **Losing real money** | the memo prefilter |
| **CI** | the Node 20 glob, the scanner matching itself, the scanner's `-I`/`-i` |
| **This audit** | the scanner's lost coverage, the flag ordering in the test runner, `doctor`'s freshness message, and two false claims in this document |
| **Unit tests** | none of the above |

The tests in this repository are good at preventing the return of a defect
that is already understood. Not one of the defects above was originally found
by them. That is not an argument against the tests — it is an argument about
what they are for, and about not mistaking 146 green ticks for a safety
argument.

Two second-order lessons stand out. **A fix that lands in the harness and not
in the product is not a fix**: `flow` had never been used for a live run and
its detection was *worse* than the harness bug that lost the money, so the same
funds would have been lost by a different route. And **a hardening pass is
exactly when a check gets quietly weakened**, because the diff is large,
plausible, and reads as an improvement.

### Still open

- The refund rail does not exist. Two amounts of 0.2 USDC remain unrecoverable
  and `DEBT-P2-FUNDING-1` in the server repository is untouched.
- The live-safety harness items — strict-fresh enforcement in `flow` rather
  than a warning, an executor heartbeat bound to the same database and intent,
  a short `watch --execute` loop, same-signature recovery — are specified and
  unbuilt.
- The page-side signing guard is still pinned to a consumed intent. Its cutoff
  now matches the product's and it re-checks at the wallet call, but making it
  general is part of the same unbuilt slice.
- The 120-second budget is a pinned assumption, not a measured bound. It is
  declarable via `--post-signing-ms` so that it can be argued with rather than
  believed.

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

## What CI caught that local testing did not

Three defects — the Node 20 glob, the secret scanner matching its own detector,
and that scanner's `-I`/`-i` blindness — are recorded in *Mistakes and
challenges* above rather than here, because they belong to the same categories
as everything else. What is worth separating is the observation: all three
concerned the *tooling*, none could be reached by `npm test`, and their first
execution was their first CI run.

That remains true. Nothing in the test suite exercises a workflow step, so the
secret scanner's later loss of coverage — dropping `mnemonic` and `keypair`
while being repaired — was invisible for as long as it existed and was found by
reading the diff, not by running anything.

## Known limits

- `flow`'s real funding path is unproven end to end (see the table above). It
  has never driven a live run: the one mainnet attempt went through the demo
  harness.
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
