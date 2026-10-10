# Hackathon build kit — index

| File | For | What |
|---|---|---|
| `RUNBOOK.md` | Jeff | 時間表、任務分輪、合併流程、砍功能順序（台灣繁中） |
| `SPEC.md` | agents | Product, invariants I1–I11, module contracts, limits — authoritative |
| `tasks/T1-gate-core.md` | Round 1 | host server, downstreams, config, audit log |
| `tasks/T2-tool-policy.md` | Round 2, after T1 merges | pass / bound / deny, structured refusals |
| `tasks/T3-solana-kit.md` | Round 1 | decode, lookup tables, instructions, simulation |
| `tasks/T4-review-and-tx-policy.md` | Round 2, after T3 merges | `reviewTransaction()` and transaction rules |
| `tasks/T5-rpc-checkpoint.md` | Round 1 or 2 (no dependencies) | loopback RPC proxy, `sendTransaction` interception |
| `tasks/T6-holds-and-approval.md` | Round 1 | holds, wallet-signature approval page |
| `tasks/T7-fixtures-and-demo.md` | Round 1 | demo wallet server, fake upstream, attack suite |
| `tasks/I1-integration.md` | Jeff + local Claude Code, after T1–T7 merge | the pipeline, hermetic E2E, devnet checklist |
| `tasks/T8-audit-verify.md` | Round 2, after T1 and T3 merge | `audit --log` ledger re-verification |
| `tasks/T9-docs.md` | Round 3 | README rewrite, demo script |
| `tasks/R1-adversarial-review.md` | Round 3, the other model | review only, findings to `REVIEW.md` |
| `SUBMISSION.md` | Jeff | form text, disclosure, video scripts, slides, builder updates |

Rule: one card = one task = one branch = one PR. Each task opens its PR and stops; a dependent
card starts from the latest `main` after its prerequisite is merged.

Also added at the repo root: `AGENTS.md` (Codex reads it), `CLAUDE.md` (imports `AGENTS.md`),
`.claude/settings.json` (attended-session permissions), `examples/` (gate configs and the Claude
Desktop entry), `scripts/hackathon/new-petty-cash.mjs` (petty-cash keypair, zero dependencies).
