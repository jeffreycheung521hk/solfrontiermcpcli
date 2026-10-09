# Hackathon build kit — index

| File | For | What |
|---|---|---|
| `RUNBOOK.md` | Jeff | 時間表、今晚步驟、合併流程、砍功能順序（台灣繁中） |
| `SPEC.md` | agents | Product, invariants I1–I11, module contracts, limits — authoritative |
| `tasks/T1-gate-core.md` | Agent A | host server, downstreams, config, audit log |
| `tasks/T2-tool-policy.md` | Agent A | pass / bound / deny, structured refusals |
| `tasks/T3-solana-kit.md` | Agent B | decode, lookup tables, instructions, simulation |
| `tasks/T4-review-and-tx-policy.md` | Agent B | `reviewTransaction()` and transaction rules |
| `tasks/T5-rpc-checkpoint.md` | Agent C | loopback RPC proxy, `sendTransaction` interception |
| `tasks/T6-holds-and-approval.md` | Agent D | holds, wallet-signature approval page |
| `tasks/T7-fixtures-and-demo.md` | Agent C | demo wallet server, fake upstream, attack suite |
| `tasks/I1-integration.md` | Agent A + Jeff | the pipeline, hermetic E2E, devnet checklist |
| `tasks/T8-audit-verify.md` | Agent B | `audit --log` ledger re-verification |
| `tasks/T9-docs.md` | Agent C | README rewrite, demo script |
| `tasks/R1-adversarial-review.md` | GPT | review only, findings to `REVIEW.md` |
| `SUBMISSION.md` | Jeff | form text, disclosure, video scripts, slides, builder updates |

Also added at the repo root: `AGENTS.md` (Codex reads it), `CLAUDE.md` (imports `AGENTS.md`),
`.claude/settings.json` (attended-session permissions), `examples/` (gate configs and the Claude
Desktop entry), `scripts/hackathon/new-petty-cash.mjs` (petty-cash keypair, zero dependencies).
