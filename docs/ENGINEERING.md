# Engineering record

State of this repository as of **2026-08-02**, written before the first
real-money demonstration so that the known-good state is captured
independently of whatever that run produces.

- Commits: `878b222` (implementation), `5539021` (CI fixes)
- 28 tracked files, ~2,700 lines of JavaScript, zero runtime dependencies
- CI: green on `windows-latest` and `ubuntu-latest` × Node 20 and 22

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
| `flow` — preflight, propose, finalize, URL | dry-run against the real server | **proven** |
| `flow` — signature detection + confirm | **none: dry-run only** | **UNPROVEN** |

The last row is the honest gap. Every component of the real funding path is
tested; their integration under a live 180-second deadline is not. It cannot
be tested without spending real money, which is a limit of the situation, not
an excuse — it is stated here rather than left for a reader to discover.

An independent cross-check that did land: `propose --amount 0.2
--threshold-bps 90` reproduces draft hash
`919f478e954582cece630e6b486edf4373d87daa3a64caea6b6aef3291d2fbbd`, byte-identical
to the value recorded in the 2026-08-01 acceptance document. Two independent
implementations agree on the canonical hash.

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

## Planned first real-money demonstration

Recorded before it runs, so the plan is auditable regardless of outcome.

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
