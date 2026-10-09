# AGENTS.md — rules for AI coding agents in this repository

You are building **SolFrontier Gate** during a hackathon sprint that ends 2026-10-12 12:00 JST
(code freeze). Read these, in order, before writing code:

1. `docs/hackathon/SPEC.md` — the contracts and invariants (I1–I11). Authoritative.
2. Your task card in `docs/hackathon/tasks/` — what you own and how you are judged done.
3. The existing code you will touch. Match its style and its comments-explain-why habit.

## Hard rules

1. **Zero runtime dependencies.** Node ≥ 20 built-ins only. Do not run `npm install`, do not add
   anything to `package.json` dependencies. (Exception path in SPEC I8 needs the human.)
2. **Own your files.** Edit only the files your card lists. If you need something from another
   card's file, write it under "Needs from others" in your PR description and stub around it.
3. **Never touch secrets.** No real keys, RPC URLs or API keys in code, tests, fixtures, logs or
   commit messages. Tests generate keys at runtime (`crypto.generateKeyPairSync('ed25519')`).
4. **Green before commit.** Run `npm test` before every commit. Never commit a red suite.
   Never weaken or delete an existing test to make yours pass.
5. **Legacy stays.** Do not refactor or delete the legacy commands (`flow`, `intent`,
   `funding-window`, `executor-heartbeat`), `src/solana/refund-proof.mjs`, their tests, or any
   file that already exists in `scripts/demo/` (historical evidence).
6. **stdout rule.** Code that runs inside `gate run` must never write to stdout except MCP
   JSON-RPC frames. Use stderr for everything human-readable.
7. **Fail closed.** When in doubt, refuse. An error path that forwards a call or a transaction is
   a bug of the highest severity.
8. **Small commits.** Conventional messages: `feat(gate): …`, `fix(solana): …`, `test(gate): …`.
   One card = one branch = one PR. Use the branch name in your card; if your environment forces
   a prefix (for example `claude/` or `codex/`), keep the card's name as the rest of the branch
   name (`claude/gate-core`) and put the card id in the PR title.
9. **Blocked?** If the spec is ambiguous or you are stuck for more than ~30 minutes, append the
   question to `docs/hackathon/questions/<your card id>.md` (e.g. `questions/T3.md`; one file per
   card so parallel branches never conflict), choose the fail-closed interpretation, note the
   choice in your PR, and continue. Never stop to wait for an answer.
10. **Definition of done** = every box in your card's *Acceptance* list is ticked, `npm test` is
    green, and the PR description lists what is verified, what is not (`UNVERIFIED`), and any
    "Needs from others".
11. **JSON-safe boundaries.** Anything you hand to MCP, HTTP or the audit log must survive
    `JSON.stringify`: amounts as decimal strings, never BigInt (SPEC §5.3, JSON safety).

## Commands

```sh
npm test                                   # whole hermetic suite (no network)
node --test test/<file>.test.mjs           # one file
node src/index.mjs gate run <config.json>  # once T1 lands; stdout = MCP protocol
```

## CI you must keep green

`.github/workflows/ci.yml` runs on **windows-latest and ubuntu-latest, Node 20 and 22**: zero
dependencies check, `node --check` on every `.mjs` under `src/ scripts/ test/`, `npm test`, and a
secret scan that fails on any secret-looking name assigned a quoted literal of 12+ characters
(e.g. `privateKey: '…'`). So: portable paths (`path.join`), spawn `process.execPath` with an args
array (never a shell string), no POSIX-only assumptions in tests (macOS-only code paths such as
`osascript` must be optional and skipped elsewhere), and generate keys at runtime.

## Style

ESM `.mjs`, 2-space indent, single quotes, semicolons — as in `src/`. JSDoc on exported
functions. Prefer small pure functions that take their dependencies as arguments (an `rpc`
object, a clock, a key) so tests can inject fakes. BigInt for every on-chain amount.
