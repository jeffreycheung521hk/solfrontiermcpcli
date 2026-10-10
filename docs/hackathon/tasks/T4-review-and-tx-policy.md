# T4 — Transaction review and transaction policy

> **給 Jeff**：第二輪。T3 合併進 `main` 後，從最新 `main` 另開一個任務。預估 2–3 小時。
> 驗收方法：測試裡「把 0.5 SOL 轉給攻擊者」的交易被判 deny，理由寫得出是哪條規則、超了多少。

Branch: `gate/tx-review`, created from the latest `main` after T3 is merged · Depends on: T3 · Blocks: I1

## Goal

One function, `reviewTransaction()`, that every transaction passes through before a human is
asked anything: decode, resolve, static rules, simulate, simulation rules, verdict.

## You own

`src/gate/review.mjs`, `src/gate/tx-policy.mjs`, `test/gate-review.test.mjs`

## Read first

SPEC §5.5 (order of rules, Review shape), §5.1 (`tx` section), §5.3 (violation codes), I2, I7.

## Build

1. `compileTxPolicy(txConfig, lists)` — validate at load time (addresses are valid base58
   32-byte keys; mints in `maxOutflow` valid; `destinations` list exists).
2. `reviewTransaction({ bytes, wallet, rpc, txPolicy, lists, cluster, signed })` → `Review`,
   following SPEC §5.5 exactly. Each violation: `{ code, path, observed, bound, message }`.
3. Outflow / inflow per asset from `simulateWithDeltas`: native SOL = wallet lamports delta
   plus wrapped SOL mint delta; each other mint separately; convert to exact decimal strings
   using mint decimals (unknown decimals ⇒ raw units and a warning).
4. Destinations (a **simulation-phase** rule, SPEC §5.5 step 4): for decoded top-level System
   `transfer` and SPL `transfer` / `transferChecked`, pass each destination to
   `simulateWithDeltas` as `watch`; the destination is allowed if it is the wallet, a token
   account owned by the wallet in the post-simulation state, in the destinations list, or the
   list is `"any"`.
   `Review` must be JSON-safe (SPEC §5.3): convert every BigInt (instruction amounts, deltas)
   to decimal strings before returning. `outflow` / `inflow` are keyed by `"SOL"` or the mint
   **address**; symbols appear only in `summaryLine`.
5. Delegation: `approve`, `approveChecked`, `setAuthority` on any account owned by the wallet ⇒
   `token_delegation_denied` when `denyTokenDelegation`.
6. `summaryLine`: signed amounts per asset (wallet's perspective), first unknown or swap program
   shortened to 4 chars + `…`, instruction count. Example: `−0.0010 SOL, +0.17 USDC · JUP6… · 4 ix`.
   Map the USDC mint `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` to `USDC`; others shortened.

## Acceptance

- [ ] One test per rule producing exactly its code; rule order respected (a decode failure never
      reaches simulation; a static deny — program, delegation, legacy transfer — never calls
      `simulateTransaction`).
- [ ] `JSON.stringify(review)` succeeds for every test vector (no BigInt leaks).
- [ ] RPC failure ⇒ `rpc_unavailable`, deny. `sim.err` ⇒ `simulation_failed`, deny.
- [ ] Drain vector (0.5 SOL to an unknown address, cap 0.05) ⇒ deny with
      `destination_not_allowed` and `outflow_exceeds_bound` (both simulation-phase); with
      `destinations: "any"` ⇒ `outflow_exceeds_bound` only.
- [ ] Swap-shaped vector (wallet lamports −1,005,000 = 1,000,000 swapped + 5,000 fee; USDC
      +170,000 raw, 6 decimals) under caps ⇒ `hold`, outflow `{ "SOL": "0.001005" }`, inflow
      `{ "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": "0.17" }` — exact strings — and a
      `summaryLine` that says `USDC`.
- [ ] Wrapped-SOL ATA created in the same transaction is treated as the wallet's own.
- [ ] `approval: "never"` ⇒ `allow`; `"always"` ⇒ `hold`.
- [ ] No floats anywhere in amount math (grep your diff for `parseFloat` / `Number(` on amounts).

## Launch prompt

```
You are working in this repository. Read AGENTS.md, docs/hackathon/SPEC.md and
docs/hackathon/tasks/T4-review-and-tx-policy.md. T3 is merged into main. Create branch
gate/tx-review from the latest main. Implement T4 until every Acceptance box is ticked,
committing after each green step. Do not start any other card. Do not add any npm dependency.
Finish by opening a PR listing what is verified, what is UNVERIFIED, and needs from other
cards. Then stop.
```
