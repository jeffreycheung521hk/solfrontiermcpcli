# T2 — Tool policy: pass / bound / deny

> **給 Jeff**：第二輪。T1 合併進 `main` 後，從最新 `main` 另開一個任務。預估 2–3 小時。
> 驗收方法：在 Claude Desktop 裡叫 agent「轉 5 SOL」會直接收到結構化拒絕，downstream 完全沒被呼叫。

Branch: `gate/tool-policy`, created from the latest `main` after T1 is merged · Depends on: T1 · Blocks: I1

## Goal

Every `tools/call` is decided by policy before anything reaches a downstream. Unknown tools are
denied and hidden. Refusals are structured so the agent can re-plan instead of retrying blindly.

## You own

- `src/gate/tool-policy.mjs`, `test/gate-tool-policy.test.mjs`
- Wiring in `src/commands/gate.mjs` / `src/gate/host-server.mjs` (T1's files, already merged;
  edit them only for this wiring)

## Read first

SPEC §5.1 (`tools`, `lists`, `showDeniedTools`), §5.2, §5.3, I1, I6.

## Build

1. `compileToolPolicy(config)` — validate every rule at load time (unknown mode, unknown
   constraint key, `@list` that does not exist, `txArg` naming nothing → config error, exit 2).
2. `decideTool(compiled, { server, tool, args })` per SPEC §5.3. Precedence: exact key, then
   globs in declaration order, then `"*"`. No match, or only `"*"` matched with `"deny"` ⇒ code
   `unknown_tool`; an explicit rule (exact or glob other than `"*"`) set to `"deny"` ⇒ `tool_denied`.
3. Constraints: `type` (`number`, `integer`, `string`, `number-string`), `required` (default
   true), `lte` / `gte`, `in` (array or `@list`), `pattern` (anchored regex). Compare
   `number-string` exactly: parse to a scaled BigInt with up to 18 decimal places; reject
   exponents, `NaN`, `Infinity`, signs other than a leading `-`.
4. `refusal({ code, tool, rule, violations, hint })` → `CallToolResult` with `isError: true`,
   `content[0].text` = JSON body, `structuredContent` = same body. Hints are written for the
   agent: say what bound applied and what would be allowed.
5. Listing: hide `deny` tools unless `showDeniedTools`; append the guard suffix to `bound` tools'
   descriptions (SPEC §5.2).
6. Wire into `gate run`: replace T1's forward-all handler with
   `decide → audit tool_call (callId, decision, rule, violations, scrubbed args) → refusal | forward`;
   every record of one host call carries the same `callId` (SPEC §5.8).
   If the decision carries `txArg`, return refusal `approval_unavailable` for now — I1 replaces
   that branch with review + hold. Log before acting (I6).

## Acceptance

- [ ] Unit tests for every mode, precedence rule and constraint, including
      `number-string` edge cases (`"0.05"` ≤ 0.05 passes, `"0.0500000001"` fails, `"1e-3"` rejected).
- [ ] "No rule at all" and `"*": "deny"` both give `unknown_tool`; `"wallet.foo": "deny"` gives `tool_denied`.
- [ ] Config errors are caught at load time (exit 2), not at call time.
- [ ] Stdio test through `gate run`: a bound violation returns `isError: true` with the stable
      code, and the audit log shows `tool_call` with `decision: "deny"` and no `tool_result`.
- [ ] `tools/list` hides denied tools; `showDeniedTools: true` shows them with a `[denied]` suffix.
- [ ] A `txArg` tool is refused with `approval_unavailable` until I1 lands (fail closed).

## Launch prompt

```
You are working in this repository. Read AGENTS.md, docs/hackathon/SPEC.md and
docs/hackathon/tasks/T2-tool-policy.md. T1 is merged into main. Create branch gate/tool-policy
from the latest main. Implement T2 until every Acceptance box is ticked, committing after each
green step. Do not start any other card. Finish by opening a PR listing what is verified, what
is UNVERIFIED, and needs from other cards. Then stop.
```
