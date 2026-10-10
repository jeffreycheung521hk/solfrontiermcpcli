# T8 — `sfcli audit --log`: re-verify the evidence

> **給 Jeff**：第二輪：T1 和 T3 都合併後就能開跑。預估 2 小時。
> 驗收方法：週日 mainnet proof 之後，`node src/index.mjs audit --log sfgate-audit.mainnet.jsonl`
> 印出 chain OK + 那筆 mainnet 交易 PASS。

Branch: `gate/audit` from `main` · Depends on: T1 (`verifyChainText`), T3 (`decodeTransaction`, `messageSha256`) · Blocks: demo, README proof

## Goal

Anyone holding the audit log can check that it was not edited and that every transaction it
claims was sent is on chain with exactly the message bytes the human approved.

## You own

`src/commands/audit.mjs` (add the `--log` mode; document mode unchanged),
`test/gate-audit-verify.test.mjs`

## Build

1. `audit --log <file> [--commitment confirmed|finalized] [--rpc-env <NAME>]`.
   Default `--rpc-env SFGATE_UPSTREAM_RPC_URL`; if that variable is unset, run chain-only.
2. Chain: `verifyChainText` from `src/gate/audit-log.mjs`. Row: `chain · N records · PASS` or
   `FAIL at line k: <reason>`.
3. For each `rpc_send_forwarded` (and each `tool_result` that carries a `signature`): find the
   approved `messageSha256` through the shared `sendId` / `callId` (SPEC §5.8:
   `hold_approved` → `tx_review`). A `tool_result` signature that equals an
   `rpc_send_forwarded` signature is the same transaction — report it once. Call `getTransaction`
   with `{ encoding: 'base64', maxSupportedTransactionVersion: 0, commitment }`, decode with
   `src/solana/tx.mjs`, compare `messageSha256`, check `meta.err == null`.
   Rows: `PASS` (match, success), `FAIL` (missing, mismatch, err), `UNVERIFIED` (no RPC, or a
   signature with no linked approved `tx_review`, e.g. a server that never showed Gate its transaction).
4. Exit codes follow the existing document mode (`src/commands/audit.mjs`): exit 0 when nothing
   FAILed — UNVERIFIED rows are reported, not counted as passes, and do not change the exit code;
   exit 1 if any row FAILed.
5. `--json` prints the rows as one JSON document (existing output helpers).

## Acceptance

- [ ] Document-mode tests unchanged and green.
- [ ] Chain PASS on a generated log; FAIL with the right line after a one-byte edit.
- [ ] With an injected fake RPC: matching message ⇒ PASS; different message ⇒ FAIL;
      `meta.err` ⇒ FAIL; missing ⇒ FAIL; no RPC ⇒ UNVERIFIED.
- [ ] No RPC URL in any output (I4).

## Launch prompt

```
You are Agent B. Read AGENTS.md, docs/hackathon/SPEC.md (§5.8) and
docs/hackathon/tasks/T8-audit-verify.md. Create branch gate/audit from main. Implement T8 until
every Acceptance box is ticked, committing after each green step, then open a PR.
```
