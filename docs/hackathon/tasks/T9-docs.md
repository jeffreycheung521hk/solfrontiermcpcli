# T9 — README rewrite and demo script

> **給 Jeff**：第三輪（週六晚上，雲端過夜）。I1 合併後最好，沒合併也可以先寫。預估 2 小時。
> README 是判審第一眼看到的東西：第一段講產品，第二段講證據，限制放後面。

Branch: `gate/docs` from `main` · Depends on: I1 for exact commands (write placeholders if not merged)

## You own

`README.md`, `docs/LEGACY-COMMANDS.md`, `docs/hackathon/DEMO-SCRIPT.md`

## README outline (in this order)

1. **SolFrontier Gate** — one line: *An MCP firewall between AI agents and Solana wallets.*
   Then a 3-line paragraph: what it does, for whom, zero dependencies.
2. GIF placeholder `docs/assets/demo.gif` (the human records it).
3. **Why** — two facts, each linked: SendAI `solana-mcp` and kukapay `jupiter-mcp` ask for a
   private key in the agent config; `execute-ultra-order` signs whatever base64 transaction it
   is handed and posts it to Jupiter's API. Agents read untrusted text all day.
4. **How it works** — the three checkpoints (SPEC §1) as a small ASCII diagram + 6 bullets.
5. **Quick start** (macOS, Node ≥ 20): keygen → fund → copy example config → Claude Desktop
   entry (absolute path to `node`) → approve your first hold. Every command copy-pasteable.
6. **Policy reference** — `tools` modes and constraints, `tx` rules, with the devnet example.
7. **Attack demo** — the `attacks.mjs` table output (paste real output when available).
8. **Proof** — devnet and mainnet signatures with explorer links, and the `audit --log` output.
   Placeholders `<SIGNATURE>` until the human fills them.
9. **Limits** — SPEC §6 L1–L6, verbatim.
10. **Roadmap** — network-isolated downstreams; Squads multi-approver holds; Solana payment
    channels as the hard cap under the petty-cash role; composes with Solana Foundation's
    `pay mcp` (which bounds paid HTTP calls) — Gate covers everything else an agent can sign.
11. **Lineage and disclosure** — built on this repo's pre-hackathon MCP client (history up to
    `c14496d`, 2026-08-03); policy ideas ported from the author's earlier Rust repos; AI coding
    assistants used under a human-written spec. The pre-hackathon commands (`flow`, `intent`, …)
    remain: **before** rewriting, move the current README's sections about them (Commands,
    Configuration, Exit codes, Guardrails, Design notes, Testing, Project state) verbatim into
    `docs/LEGACY-COMMANDS.md` with a one-line header, and link it from here. `docs/ENGINEERING.md`
    stays as is.
12. License.

## DEMO-SCRIPT.md

The technical video's exact sequence (≤ 3 minutes), with what is on screen, what is typed, and
what is said, taken from `docs/hackathon/SUBMISSION.md` §Technical video, updated to the real
commands and outputs.

## Acceptance

- [ ] Every hermetic command in the README was run by you and works as written.
- [ ] Networked steps are marked "(devnet)" / "(mainnet)" and were not invented: placeholders
      where the human must fill real output.
- [ ] Limits section matches SPEC §6 word for word.
- [ ] No claim the code does not back (grep the README's verbs against the code).

## Launch prompt

```
You are Agent C. Read AGENTS.md, docs/hackathon/SPEC.md, docs/hackathon/SUBMISSION.md and
docs/hackathon/tasks/T9-docs.md. Create branch gate/docs from main. Rewrite README.md and write
docs/hackathon/DEMO-SCRIPT.md per the card. Run every hermetic command you document. Open a PR.
```
