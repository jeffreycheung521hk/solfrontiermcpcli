# I1 — Integration: the pipeline

> **給 Jeff**：週六下午到晚上，**本機** Claude Code，你坐在旁邊一起測。前提：T1–T7 的 PR
> 都已合併進 `main`。預估 4–6 小時（含你在 Claude Desktop / Phantom / devnet 的實測）。
> 這是整個比賽最關鍵的一段：21:00 要過 CP1，22:00 是 K1。

Branch: `gate/integrate` from `main` after merges · Depends on: T1–T7 · Blocks: demo, T8 live checks

## Goal

Wire policy (T2), review (T4), checkpoint (T5) and approvals (T6) into `gate run` exactly as
SPEC §5.9 describes, prove it end to end without network, then prove it on devnet with the human.

## You own

`src/gate/pipeline.mjs`, `test/gate-e2e.test.mjs`, plus edits to `src/commands/gate.mjs`,
`src/gate/host-server.mjs`, `src/gate/downstreams.mjs`, `src/gate/config.mjs` (replace the local
base58 with `src/solana/base58.mjs`), `examples/*.json`.

## Build

1. `gate run` startup order: config → audit (`gate_start`) → approval server → RPC checkpoint
   (its `onSend` = pipeline) → downstreams with `checkpointUrl` → host server. Shutdown in reverse.
   If the approval server or checkpoint cannot bind its port: exit 2 with the port in the message.
2. `pipeline.onToolCall` and `pipeline.onRpcSend` per SPEC §5.9 — log before every effect (I6),
   with the `callId` / `sendId` / `holdId` correlation fields from SPEC §5.8.
   Signature extraction for `tool_result`: look for a base58 string of 86–90 characters under
   keys `signature`, `transactionId`, `txid`, `tx` in the parsed result text.
3. Hold timeouts: `approval.timeoutSec` (default 40, max 60; the config loader already enforces
   `servers.*.timeoutMs ≥ (timeoutSec + 30) × 1000`). Track in-flight host calls per downstream;
   a checkpoint send with none in flight ⇒ `unsolicited_send` (SPEC §5.9); otherwise the hold's
   `parentIds` = those `callId`s, and host `notifications/cancelled` cancels matching holds.
   Replace T5's and T6's private base58 copies with `src/solana/base58.mjs`.
4. `gate__status` adds pending holds (id, summaryLine, seconds left) and the approval page URL.
5. Notifications: `notifyHold` on every new hold when `approval.notify` / `openBrowser`.
6. `test/gate-e2e.test.mjs` (hermetic): fake upstream (T7) + naive wallet (T7) + `gate run` as a
   child process + approvals signed in-test with a runtime approver key via the approval HTTP API.

## Acceptance — hermetic (must be green before the human tests)

- [ ] `transfer_sol` 0.001 to an allowlisted address ⇒ hold at the checkpoint ⇒ in-test approval
      ⇒ fake upstream receives exactly one `sendTransaction` ⇒ tool result carries the signature.
      Audit order: `tool_call`, `tx_review`, `hold_created`, `hold_approved`, `rpc_send_forwarded`,
      `tool_result`; `verifyChainText` ok.
- [ ] `sign_and_send` drain ⇒ refused before any hold; upstream never sees `sendTransaction`.
- [ ] Approval timeout ⇒ `approval_timeout`; nothing forwarded; `hold_expired` logged.
- [ ] Wrong approver key ⇒ still pending ⇒ timeout path.
- [ ] `--rogue` wallet ⇒ `unsolicited_send` logged (`rpc_send_refused`); upstream never sees it.
- [ ] Host cancels a `transfer_sol` call while its send is held ⇒ hold cancelled, nothing forwarded.
- [ ] `node scripts/demo/attacks.mjs --hermetic` ⇒ every row PASS.

## Acceptance — with the human (devnet)

- [ ] Claude Desktop shows only allowed tools plus `gate__status`.
- [ ] "What's my balance?" ⇒ answered (pass).
- [ ] "Send 5 SOL to <allowlisted>" ⇒ refused with `arg_out_of_bounds`; the model explains why.
- [ ] "Send 0.001 SOL to <allowlisted>" ⇒ macOS notification ⇒ approval page ⇒ Phantom
      signMessage ⇒ transaction confirmed on the devnet explorer ⇒ audit log has the signature.
- [ ] `node scripts/demo/attacks.mjs` on devnet ⇒ every row PASS.

## Launch prompt (local, attended)

```
You are Agent A, working locally with the human. Read AGENTS.md, docs/hackathon/SPEC.md (§5.9
especially) and docs/hackathon/tasks/I1-integration.md. T1–T7 are merged into main. Create
branch gate/integrate from main. First make every hermetic Acceptance box pass, committing after
each green step. Then guide the human through the devnet checklist one item at a time: tell
them exactly what to type or click, ask for the stderr tail and `tail -n 5 sfgate-audit.devnet.jsonl`
after each step, and fix what fails. Never ask the human to paste a private key or RPC URL.
```
