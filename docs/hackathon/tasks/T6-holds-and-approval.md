# T6 — Holds and wallet-signature approval

> **給 Jeff**：Agent D（Codex / GPT）週五晚上跑。預估 3–4 小時。
> 驗收方法：測試全綠；週六你親手打開 http://127.0.0.1:8787 ，用 Phantom 簽一次核准訊息。

Branch: `gate/approval` · Depends on: nothing · Blocks: I1

## Goal

A transaction waiting for a human becomes a *hold*. The human approves it by signing the hold's
approval message with their own wallet in a loopback page. The agent cannot fake that signature.

## You own

`src/gate/holds.mjs`, `src/gate/approval-server.mjs`, `src/gate/approval-page.mjs`
(exports the page HTML and `app.js` as strings), `src/gate/notify.mjs`,
`test/gate-approval.test.mjs`

## Read first

SPEC §5.6 (contract, message format, HTTP API, CSP), I3, I7, I11. The CSP and loopback
discipline of the earlier SolFrontier signing page are the model (it worked with Phantom on mainnet).

## Build

1. `HoldQueue` per SPEC §5.6, with an injectable clock (`now()`) and id generator for tests.
   Expiry is checked on every access and by a timer; expiring resolves waiters with `expired`.
2. Approval message: exactly the six lines in SPEC §5.6, `\n`-joined, no trailing newline,
   generated once at `add()` and stored on the hold.
3. `verifyApproval({ message, publicKey, signature, approver })`: `publicKey === approver`
   (base58 compare), signature length 64, Ed25519 verify via a JWK public key. Never throws on
   bad input — returns false. Base58 decoding of the approver key: write a small private decoder
   inside your module (T3's `src/solana/base58.mjs` is on a parallel branch; I1 swaps it in). Do
   not create files T3 owns. Holds may carry a `parentIds` array (`callId`s / `sendId`) and
   `cancelWhere(predicate, reason)`; I1 uses them for host cancellation.
4. `startApprovalServer({ holds, approver, method, cluster, port, logger })` → `{ url, close }`.
   Every JSON response goes through a replacer that turns BigInt into strings (defence in depth).
   Routes and status codes: approve OK 200; bad signature 400 (hold stays pending); unknown id
   404; already decided 409; expired 410. Reject is always allowed while pending.
   `method: 'local-button'` with `cluster: 'mainnet-beta'` ⇒ throw at start (I3).
5. Page (`approval-page.mjs`): no external resources at all. Lists pending holds (poll 1 s), each
   with tool / kind, `summaryLine`, decoded instructions, outflow / inflow, violations, warnings,
   message hash, countdown from `expiresAt`. Buttons: **Approve with wallet** (Phantom flow in
   SPEC §5.6; show a clear error if Phantom is missing or the connected key is not the approver)
   and **Reject**. In `local-button` mode the approve button posts `{ method: 'local-button' }`.
6. `notify.mjs`: `notifyHold({ title, body, url, enabled })` — macOS `osascript` notification
   and `open url`; Linux `xdg-open`; others no-op. `spawn` with an args array, escape `"` and `\`
   in AppleScript strings, `detached`, `stdio: 'ignore'`, swallow every error.

## Acceptance

- [ ] Message format byte-exact (snapshot test).
- [ ] Runtime approver key signs the message ⇒ approved; `waitFor` resolves `approved` with
      `{ publicKey, signature, method: 'wallet-signature' }`.
- [ ] Wrong key, tampered message, truncated signature ⇒ 400, still pending.
- [ ] Double approve ⇒ 409; approve after expiry ⇒ 410 and `waitFor` resolved `expired`.
- [ ] Reject and cancel resolve waiters correctly.
- [ ] HTTP: wrong `Host` ⇒ 403; foreign `Origin` ⇒ 403; non-JSON POST ⇒ 415; CSP header on `/`.
- [ ] `local-button` refused on `mainnet-beta`.
- [ ] `notifyHold` with a nonexistent binary does not throw (inject the spawn function in tests).
- [ ] PR description contains the manual Phantom test steps for the human.

## Launch prompt

```
You are Agent D in this repository. Read AGENTS.md, docs/hackathon/SPEC.md and
docs/hackathon/tasks/T6-holds-and-approval.md. Work on branch gate/approval. Implement T6
completely, with tests, committing after each green step, until every Acceptance box is ticked.
Do not add any npm dependency. Finish by opening a PR that includes manual Phantom test steps.
```
