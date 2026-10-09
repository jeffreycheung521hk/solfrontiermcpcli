# T2 — Tool policy: pass / bound / deny

> **給 Jeff**：Agent A 做完 T1 後在同一個 branch 接著做。預估 2–3 小時。
> 驗收方法：在 Claude Desktop 裡叫 agent「轉 5 SOL」會直接收到結構化拒絕，downstream 完全沒被呼叫。

Branch: `gate/core` (after T1) · Depends on: T1 · Blocks: I1

## Goal

Every `tools/call` is decided by policy before anything reaches a downstream. Unknown tools are
denied and hidden. Refusals are structured so the agent can re-plan instead of retrying blindly.

## You own

- `src/gate/tool-policy.mjs`, `test/gate-tool-policy.test.mjs`
- Wiring in `src/commands/gate.mjs` / `src/gate/host-server.mjs` (yours from T1)

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

Continue from T1 on `gate/core` (see T1's prompt). If you are a fresh session:

```
You are Agent A. Read AGENTS.md, docs/hackathon/SPEC.md and
docs/hackathon/tasks/T2-tool-policy.md. T1 is already on branch gate/core. Implement T2 on the
same branch until every Acceptance box is ticked, committing after each green step. Then open
or update the PR for gate/core.
```
