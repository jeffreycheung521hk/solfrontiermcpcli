# T1 — Gate core: host server, downstreams, config, audit log

> **給 Jeff**：第一輪（Agent A）。做完開自己的 PR 就停；T2 等這張合併後，從最新 `main` 另開任務。預估 3–5 小時。
> 驗收方法：`npm test` 全綠，而且 `test/gate-core.test.mjs` 裡有「host → gate → fake server」的完整 stdio 往返。

Branch: `gate/core` · Depends on: nothing · Blocks: T2, I1, T8

## Goal

`sfcli gate run <config.json>` starts a stdio MCP server for the host, spawns the configured
downstream MCP servers, re-exposes their tools as `<server>__<tool>`, forwards calls, and writes
a hash-chained audit log. Policy (T2), review (T4), checkpoint (T5) and approvals (T6) plug in
later through injected functions — T1 must not depend on them.

## You own

- `src/gate/config.mjs`, `src/gate/host-server.mjs`, `src/gate/downstreams.mjs`,
  `src/gate/audit-log.mjs`, `src/commands/gate.mjs`
- `src/index.mjs` — only: register `gate` in `REGISTRY` with `needsServer: false`, help text
- `src/mcp/session.mjs` — only the backwards-compatible additions below
- `test/gate-core.test.mjs`, `test/gate-config.test.mjs`, `test/gate-audit-log.test.mjs`
- `examples/sfgate.*.example.json` — a test copies each, replaces the `REPLACE_…` placeholders
  with runtime-generated addresses / temp paths, and asserts your loader accepts it (fix the
  examples if it does not). The placeholders themselves must keep failing validation.

## Read first

`docs/hackathon/SPEC.md` §3 (I1, I4–I7, I10), §5.1, §5.2, §5.8. Existing: `src/mcp/session.mjs`,
`src/mcp/framing.mjs`, `src/config.mjs` (guardrail style), `src/cli/exit-codes.mjs`,
`test/fake-server.mjs`, `test/helpers.mjs`.

## Build

1. **Session additions** (`src/mcp/session.mjs`), defaults preserve today's behaviour:
   - constructor `appendDb = true` — when `false`, `start()` does not append `--db <path>`.
   - constructor `extraEnv = {}` and `stripEnv = []` (names or RegExps) — child env =
     `{ ...sanitizedChildEnv() minus stripEnv, ...extraEnv }`. Gate passes `/^SFGATE_/` plus the
     variable names its config references (SPEC I5); `sanitizedChildEnv()` alone lets URLs through.
   - constructor `cwd` — passed to `spawn`.
   - `callToolRaw(name, args, options)` → the raw `result` object; throws `TransportError` on a
     JSON-RPC error.
   - In `#ingest`: a message with both `method` and `id` is a server→client request — answer it
     with JSON-RPC error `-32601` so a downstream never waits forever.
2. **Config** (`src/gate/config.mjs`): `loadGateConfig(path, env)` → validated, frozen object per
   SPEC §5.1, including every guardrail sentence there. Resolve the upstream URL lazily
   (`resolveUpstream(config, env)`), never store it on the config object. Load the petty-cash
   file (Solana CLI JSON array of 64 numbers) into `{ publicKey: base58, secretKey: Uint8Array }`
   — you may include a tiny local base58 encoder; T3's `src/solana/base58.mjs` will replace it in I1.
3. **Audit log** (`src/gate/audit-log.mjs`): `AuditLog.open(path)` verifies an existing file,
   continues `seq`/`prev`; `append(type, payload)` writes synchronously (`appendFileSync`) and
   returns the record; `verifyChainText(text)` → `{ ok, count, firstBadLine?, reason? }`
   (exported for T8). Implement the argument-logging rule (strings > 200 chars → `{ sha256, length }`)
   as `scrubArgs(args)`. Serialise with a replacer that turns any BigInt into a decimal string
   (defence in depth — callers should already be JSON-safe), and pass every record through the
   gate redactor before hashing.
   Also export `createRedactor(secrets: string[])` → `(text) => text` (here or in `config.mjs`):
   Gate builds it from the upstream URL, the derived WebSocket URL and the petty-cash secret in
   base58 and JSON-array form, and applies it to stderr logs, refusals and audit records (SPEC I4).
4. **Downstreams** (`src/gate/downstreams.mjs`): `startDownstreams(config, { checkpointUrl,
   pettyCash, audit, verbose })` → `{ list(): Tool[], call(server, tool, args, opts), status(), close() }`.
   Inject `rpcVar` = `<checkpointUrl>/s/<server>` and `walletVar` per SPEC §5.1 (fail-closed
   placeholder URL when `checkpointUrl` is absent); strip env per I5; spawn `process.execPath` when
   `command` is `node`; validate `timeoutMs ≥ (approval.timeoutSec + 30) × 1000` in the config loader. A downstream that fails to start is recorded (`downstream_failed`) and reported by
   `status()`; the others keep working.
5. **Host server** (`src/gate/host-server.mjs`): newline-delimited JSON-RPC on stdin/stdout
   (reuse `LineFramer`). `createHostServer({ input, output, handlers })` so tests can drive it with
   streams. Methods:
   - `initialize` → echo the client's `protocolVersion` if it is one of
     `['2025-11-25','2025-06-18','2025-03-26','2024-11-05']`, else `'2025-06-18'`;
     `capabilities: { tools: { listChanged: false } }`; `serverInfo: { name: 'solfrontier-gate', version }`.
   - `notifications/initialized` → nothing. `ping` → `{}`.
   - `tools/list` → `handlers.listTools()` (waits up to 20 s for downstream readiness).
   - `tools/call` → `handlers.callTool({ name, args, requestId, signal })`; requests run
     concurrently; a long call must not block others.
   - `notifications/cancelled` → abort the matching request's `AbortSignal`.
   - `resources/list` → `{ resources: [] }`, `resources/templates/list` → `{ resourceTemplates: [] }`,
     `prompts/list` → `{ prompts: [] }`. Anything else (including `server/discover`) → `-32601`.
   - A malformed input line → JSON-RPC parse error `-32700` with `id: null`; keep serving.
6. **Command** (`src/commands/gate.mjs`): `gate run <config>`: load config → open audit log
   (`gate_start`) → start downstreams → serve host. Default handlers in T1: `listTools` = all
   downstream tools namespaced + `gate__status`; `callTool` = forward verbatim (T2 replaces this
   with policy). When stdin ends: close downstreams, `gate_stop`, exit 0. Errors before serving →
   the usual exit codes on stderr.
7. **stdout purity**: nothing in this path may write to stdout except frames (I10).

## Acceptance

- [ ] Existing suite still green; session defaults unchanged (`appendDb` true, env sanitized).
- [ ] `gate run` with a missing env var named by the config → exit 2, clear stderr, no child spawned.
- [ ] Guardrail tests: secret-like key at any depth → exit 2; unknown top-level key → exit 2;
      `_comment` keys ignored; bad server name → exit 2; missing petty-cash file with `walletVar` → exit 2.
- [ ] Stdio round trip in a test: spawn `node src/index.mjs gate run <tmp config>` whose downstream
      is `test/fake-server.mjs` (with `appendDb: false`); `initialize` → `tools/list` shows
      `fake__echo_tool`, `fake__strict_tool`, `gate__status` → `tools/call fake__echo_tool` returns
      the fake server's result verbatim.
- [ ] Every stdout line during that test parses as JSON-RPC (run the fake with `--noisy-stderr`).
- [ ] Downstream env contains `rpcVar` = placeholder or `<checkpointUrl>/s/<server>`, `walletVar`
      = key in the configured format, **no `SFGATE_*` variable, no variable named by the gate
      config**, and none of the parent's blocked variables (assert with a fixture that echoes its
      env names, never values).
- [ ] Redactor: a stderr line or refusal containing the upstream URL, the derived ws URL or the
      petty-cash secret comes out redacted (test with runtime-generated fake values).
- [ ] Config with `timeoutMs` below `(approval.timeoutSec + 30) × 1000` → exit 2.
- [ ] `"command": "node"` spawns `process.execPath` (assert via the env-echo fixture's `process.execPath`).
- [ ] Audit: N appends verify; flipping one byte anywhere → `verifyChainText` names that line;
      `gate run` on a broken file → exit 2.
- [ ] Unknown method → `-32601`; `ping` → `{}`; malformed line → `-32700` and the server keeps going.

## Out of scope

Policy decisions (T2), transaction review (T4), checkpoint (T5), holds (T6), and any network I/O.

## Launch prompt

```
You are Agent A in this repository. Read AGENTS.md, docs/hackathon/SPEC.md and
docs/hackathon/tasks/T1-gate-core.md. Create branch gate/core from the latest main. Implement
T1 completely, committing after each green step, until every Acceptance box is ticked. Do not
start any other card. Do not wait for confirmation; if blocked, follow AGENTS.md rule 9. Finish
by opening a PR (or, if you cannot, write the PR description to docs/hackathon/pr/T1.md)
listing what is verified, what is UNVERIFIED, and any needs from other cards. Then stop.
```
