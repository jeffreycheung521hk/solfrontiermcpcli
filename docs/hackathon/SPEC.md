# SolFrontier Gate — build spec

Authoritative for every agent working in this repository during the Crypto World's Fair sprint.
If the code and this spec disagree, the spec wins until the human changes it. If the spec is
ambiguous, append the question to `docs/hackathon/questions/<card>.md` (one file per card, so
parallel branches never collide), pick the fail-closed reading,
and keep going.

- Submissions close **2026-10-12 23:59 PDT = 2026-10-13 15:59 JST**.
- Code freeze **2026-10-12 12:00 JST**. After that, docs and video only.
- Base: this repository (`solfrontiermcpcli`). Last pre-hackathon commit `c14496d` (2026-08-03).
  Everything after it is hackathon work and must be attributable in git history.

---

## 1. Product in one paragraph

SolFrontier Gate is a stdio MCP server that the agent host (Claude Desktop, Claude Code, Cursor)
runs *instead of* the user's Solana MCP servers. Gate spawns those servers as child processes
("downstreams"), re-exposes their tools under namespaced names, and puts three checkpoints
between the agent and the money:

1. **Tool checkpoint.** Every `tools/call` is matched against policy: `pass`, `bound`
   (argument constraints) or `deny`. Tools that match no rule are denied and hidden.
2. **Transaction checkpoint.** A transaction about to be signed or sent is decoded, simulated
   against the live cluster, evaluated against transaction policy, and **held until a human
   approves it with a wallet signature**. Transactions reach this checkpoint two ways:
   - as a **tool argument** — e.g. kukapay `jupiter-mcp` `execute-ultra-order {transaction}`
     signs whatever base64 it is handed (`tx.sign([walletKeypair])`) and posts it to Jupiter's
     Ultra API, so it never touches an RPC we could watch;
   - through Gate's **loopback RPC checkpoint**, which every downstream receives as its RPC URL;
     `sendTransaction` is intercepted there (SendAI `solana-mcp`, the demo wallet fixture).
3. **Evidence.** Every decision is appended to a hash-chained JSONL audit log. `sfcli audit
   --log` re-verifies the chain and re-derives broadcast transactions from the ledger.

Downstreams that insist on holding a key receive a **capped petty-cash key**. The user's main
wallet never signs transactions here — it only signs approval messages.

## 2. Out of scope for this sprint

No Rust. No on-chain program. No Squads. No payment channels. No hosted service. No UI besides
the loopback approval page. No npm dependencies (I8). No refactor or deletion of the legacy
`flow`, `intent` (quote / position / status / propose / finalize / confirm), `funding-window` and
`executor-heartbeat` commands, `src/solana/refund-proof.mjs`, or any file that already exists in
`scripts/demo/` (historical evidence).

## 3. Invariants — every PR is reviewed against these

| ID | Rule |
|---|---|
| I1 | **Default deny.** A tool that matches no policy rule is denied and not listed. An RPC write method other than `sendTransaction` (e.g. `sendBundle`) is refused. |
| I2 | **No unapproved money movement.** A transaction-bearing tool call is not forwarded, and `sendTransaction` is not sent upstream, without an approval record for that exact message hash. (`tx.approval: "never"` exists for tests only; example configs never use it.) |
| I3 | **What counts as approval.** An Ed25519 signature by the configured `approver` pubkey over the exact approval message Gate generated for that hold, while the hold is pending and unexpired. Single use. `approval.method: "local-button"` is a dev fallback: allowed only when `cluster` is `devnet` or `localnet`, and recorded as `insecure-local-button`. |
| I4 | **Secrets stay in memory.** Upstream RPC URL (it may embed an API key) and the petty-cash secret key are never printed, logged, written to the audit log, returned in a tool result, or included in an error. `redactSensitive()` only knows `process.env`, so Gate builds its own redactor from the upstream URL, the derived WebSocket URL and the petty-cash secret (base58 and JSON-array forms) and applies it, together with `redactSensitive()`, at every output boundary. |
| I5 | **Downstreams see nothing real.** Child env = `sanitizedChildEnv()` **minus** every `SFGATE_*` variable and every variable the gate config names (`upstreamRpcEnv`, `upstreamWsEnv`, `pettyCash.pathEnv`), **plus** explicit injections only (checkpoint URL in `rpcVar`, petty-cash key in `walletVar`). `sanitizedChildEnv()` deliberately lets URLs through (the legacy client needs that), so Gate must strip its own. |
| I6 | **Log, then act.** The audit record for a decision is appended before the effect (forward, broadcast, refusal). The log is append-only and hash-chained; Gate refuses to start if the existing chain does not verify. |
| I7 | **Fail closed.** Decode error, RPC error, simulation error, approval-server error, timeout, cancelled request → refuse. Never forward on error. |
| I8 | **Zero runtime dependencies.** Node ≥ 20 built-ins only. Escape hatch (needs the human's explicit OK): `@modelcontextprotocol/sdk`, confined to `src/gate/host-sdk.mjs`, only if Claude Desktop rejects the hand-written host server. |
| I9 | **Hermetic tests.** No network, no real keys. Keys are generated at test runtime (existing practice: `test/env-safety.test.mjs`). `npm test` stays green on every commit. |
| I10 | **stdout is the protocol.** In `gate run`, stdout carries MCP JSON-RPC frames only. Everything human-readable goes to stderr. |
| I11 | **Loopback only.** Every listener binds `127.0.0.1`, rejects a `Host` header other than `127.0.0.1:<port>` / `localhost:<port>` (DNS rebinding), and rejects any `Origin` header that is not its own origin. |

## 4. Files and ownership

One task card = one branch = one PR. Touch only the files your card owns.

| Path | Card | Notes |
|---|---|---|
| `src/gate/config.mjs` | T1 | load + validate gate config, guardrails |
| `src/gate/host-server.mjs` | T1 | stdio JSON-RPC server facing the host |
| `src/gate/downstreams.mjs` | T1 | spawn / initialize / list / call downstreams |
| `src/gate/audit-log.mjs` | T1 | hash-chained JSONL writer + `verifyChainText()` |
| `src/commands/gate.mjs` | T1 | `sfcli gate run <config>`; registered in `src/index.mjs` |
| `src/mcp/session.mjs` | T1 | add `appendDb`, `extraEnv`, `callToolRaw()` — backwards compatible |
| `src/gate/tool-policy.mjs` | T2 | compile tool policy, `decideTool()`, `refusal()` |
| `src/solana/base58.mjs`, `tx.mjs`, `alt.mjs`, `instructions.mjs`, `simulate.mjs` | T3 | Solana kit |
| `src/solana/rpc.mjs` | T3 | add `{ url }` option, backwards compatible |
| `src/gate/review.mjs`, `src/gate/tx-policy.mjs` | T4 | `reviewTransaction()` |
| `src/gate/rpc-checkpoint.mjs` | T5 | loopback JSON-RPC proxy + WebSocket tunnel |
| `src/gate/holds.mjs`, `approval-server.mjs`, `approval-page.mjs`, `notify.mjs` | T6 | holds + approval |
| `test/fixtures/naive-wallet-mcp.mjs`, `test/fake-upstream-rpc.mjs`, `scripts/demo/attacks.mjs`, `scripts/demo/devnet-smoke.mjs`, `scripts/demo/GATE.md` | T7 | new files only — existing `scripts/demo/*` is historical evidence, never modified |
| `src/gate/pipeline.mjs` + wiring in `host-server.mjs` | I1 | integration (after T1–T7 merge) |
| `src/commands/audit.mjs` (`--log` mode only) | T8 | audit verifier |
| `README.md`, `docs/LEGACY-COMMANDS.md`, `docs/hackathon/DEMO-SCRIPT.md` | T9 | docs |
| `docs/hackathon/questions/<card>.md` | each card | its own questions file |
| `test/gate-*.test.mjs`, `test/solana-*.test.mjs` | per card | each card names its own test files |

`package.json` needs no change: `scripts/run-tests.mjs` already discovers `test/*.test.mjs`.

## 5. Contracts

### 5.1 Gate config (T1 loads, everyone reads)

Example files: `examples/sfgate.devnet.example.json`, `examples/sfgate.mainnet-jupiter.example.json`.

```jsonc
{
  "cluster": "devnet",                       // "devnet" | "mainnet-beta" | "localnet"
  "upstreamRpcEnv": "SFGATE_UPSTREAM_RPC_URL", // NAME of env var with the real https RPC URL
  "upstreamWsEnv": "SFGATE_UPSTREAM_WS_URL",   // optional; default derived https→wss, http→ws
  "pettyCash": { "pathEnv": "SFGATE_PETTY_CASH_PATH" }, // env var naming a Solana CLI keypair file
  "approver": "<base58 pubkey of the human's wallet>",
  "servers": {
    "wallet": {
      "command": "node",
      "args": ["test/fixtures/naive-wallet-mcp.mjs"],
      "rpcVar": "RPC_URL",                   // env var the downstream reads its RPC URL from
      "walletVar": "PRIVATE_KEY",            // env var the downstream reads its key from
      "walletFormat": "base58-64",           // "base58-64" | "json-array"
      "env": { "CLUSTER": "devnet" },        // literal, non-secret values only
      "timeoutMs": 90000                     // must be ≥ (approval.timeoutSec + 30) × 1000
    }
  },
  "lists": { "allowlist": ["<base58 address>"] },
  "tools": {
    "wallet.get_balance": "pass",
    "wallet.transfer_sol": { "mode": "bound",
      "args": { "to": { "type": "string", "in": "@allowlist" },
                "amount": { "type": "number", "gte": 0, "lte": 0.05 } } },
    "wallet.sign_and_send": { "mode": "bound", "txArg": "transaction", "txArgEncoding": "base64" },
    "*": "deny"
  },
  "tx": {
    "programs": ["11111111111111111111111111111111", "ComputeBudget111111111111111111111111111111",
                 "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
                 "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"],
    "unknownProgram": "deny",                // "deny" | "warn"
    "maxOutflow": { "SOL": 0.05 },           // UI units; key "SOL" or a mint address
    "unknownMintOutflow": "deny",            // outflow of a mint not listed in maxOutflow
    "destinations": "@allowlist",            // "@list" | ["addr", ...] | "any"; own accounts always allowed
    "denyTokenDelegation": true,             // SPL Approve / ApproveChecked / SetAuthority on wallet-owned accounts
    "denyLegacyTokenTransfer": true,         // SPL Token Transfer (tag 3): carries no mint
    "approval": "always"                     // "always" | "never" (tests only)
  },
  "approval": { "method": "wallet-signature", "port": 8787, "timeoutSec": 40,   // default 40, max 60
                "openBrowser": true, "notify": true },
  "rpcCheckpoint": { "port": 18899 },        // WebSocket tunnel listens on port + 1
  "audit": { "path": "./sfgate-audit.devnet.jsonl" },
  "showDeniedTools": false
}
```

Guardrail (T1): walk every **key** recursively; a key matching
`/rpc.?url|api.?key|secret|keypair|mnemonic|private|seed/i` → `GuardrailError` (exit 2).
Values may *name* env vars (`"walletVar": "PRIVATE_KEY"` is fine; a key called `PRIVATE_KEY` is not).
Server names match `^[a-z0-9-]{1,16}$`. Unknown top-level keys → `UsageError`; keys that start
with `_` are comments and are ignored at every level. Relative paths (`servers.*.cwd`,
`audit.path`) resolve against the config file's directory; a server's `cwd` defaults to that
directory, so `args` like `test/fixtures/naive-wallet-mcp.mjs` work when the config sits in the
repo root. `"command": "node"` is spawned as `process.execPath` (hosts launch Gate with a minimal
`PATH`). Each server's `rpcVar` gets its own checkpoint path: `<checkpointUrl>/s/<server>`, so the
checkpoint knows which downstream is sending. Validation: `servers.*.timeoutMs` (default 90000) must
be ≥ `(approval.timeoutSec + 30) × 1000`, otherwise a call could time out for the agent while its
transaction is still approvable. If `rpcVar` is set but no checkpoint URL is available yet (before I1), inject
`http://127.0.0.1:9` (discard port) so every RPC call fails closed. If `walletVar` is set and the
petty-cash file is missing or malformed, refuse to start (exit 2).

### 5.2 Tool names

Host-visible name: `` `${server}__${tool}` `` (MCP hosts accept `[A-Za-z0-9_-]{1,64}`; a dot is not
safe). Policy keys use `` `${server}.${tool}` `` with `*` globbing within the tool part; exact key
first, then globs in declaration order, then `"*"`. Gate's own tool: `gate__status` (read-only:
cluster, wallet pubkey, pending holds, downstream health, policy summary).

Listing: `deny`-mode tools are hidden unless `showDeniedTools: true`. `bound` tools get a suffix
on their description, e.g. ` [Guarded by SolFrontier Gate: amount ≤ 0.05; transactions need human approval]`.

### 5.3 Tool decision and refusal (T2)

```js
compileToolPolicy(config) → compiled
decideTool(compiled, { server, tool, args }) → {
  mode: 'pass' | 'bound' | 'deny',
  rule: string,                    // the policy key that matched, e.g. 'wallet.transfer_sol'
  violations: Violation[],         // empty ⇒ allowed to proceed
  txArg?: { name: string, encoding: 'base64' | 'base58' }
}
// Violation = { code, path, observed, bound, message }
refusal({ code, tool, rule, violations, hint }) → CallToolResult
// { content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: body, isError: true }
// body = { gate: 'refused', code, tool, rule, violations, hint }
```

Constraint: `{ type?: 'number'|'integer'|'string'|'number-string', required?: boolean = true,
lte?, gte?, in?: string[] | '@list', pattern?: string }`. `number-string` = a decimal string
compared numerically (jupiter-mcp passes `amount: "0.001"`). Extra arguments not named in
`args` are allowed for `bound` tools only if they are not money-bearing — keep it simple: allow.

Refusal codes (stable, shared): `unknown_tool`, `tool_denied`, `arg_missing`, `arg_type`,
`arg_out_of_bounds`, `arg_not_allowed`, `arg_pattern`, `tx_decode_failed`, `rpc_unavailable`,
`simulation_failed`, `program_not_allowed`, `outflow_exceeds_bound`, `mint_not_allowed`,
`destination_not_allowed`, `token_delegation_denied`, `legacy_token_transfer_denied`,
`approval_rejected`, `approval_timeout`, `approval_unavailable`, `downstream_error`,
`unsolicited_send`.

`unknown_tool` = no rule matched, or only the `"*"` catch-all matched. `tool_denied` = an explicit
rule (exact or glob other than `"*"`) whose value is `"deny"`.

**JSON safety.** Everything that crosses a module boundary toward MCP, HTTP or the audit log is
JSON-safe: on-chain amounts are decimal strings (raw units unless the field says UI units), never
BigInt. `observed` / `bound` in a Violation are strings or numbers. Modules may use BigInt inside.

### 5.4 Solana kit (T3)

```js
// base58.mjs
encode(Uint8Array) → string ; decode(string) → Uint8Array   // throws on bad input

// tx.mjs
decodeTransaction(bytes) → {
  signatures: Uint8Array[], version: 'legacy' | 0,
  header: { numRequiredSignatures, numReadonlySigned, numReadonlyUnsigned },
  staticAccountKeys: string[], recentBlockhash: string,
  instructions: { programIdIndex: number, accountIndexes: number[], data: Uint8Array }[],
  addressTableLookups: { accountKey: string, writableIndexes: number[], readonlyIndexes: number[] }[],
  messageBytes: Uint8Array
}
messageSha256(decoded) → hex string
resolveAccountKeys(decoded, tables /* Map<string, string[]> */) → { keys: string[], writable: boolean[], signer: boolean[] }
verifySignatures(decoded) → { complete: boolean, valid: boolean[] }   // node:crypto Ed25519
// v0: first message byte & 0x80 ⇒ versioned; version = byte & 0x7f; anything but 0 ⇒ throw.
// account order for v0: static keys, then all writable lookups, then all readonly lookups.

// alt.mjs
parseLookupTable(data /* Uint8Array */) → string[]          // 56-byte meta header, then 32-byte keys
fetchLookupTables(rpc, keys) → Map<string, string[]>        // getMultipleAccounts base64

// instructions.mjs
describeInstructions(decoded, resolved) → Ix[]
// Ix = { index, programId, program: 'system'|'spl-token'|'spl-token-2022'|'ata'|'compute-budget'|'memo'|'unknown',
//        kind: string, lamports?: bigint, amount?: bigint, decimals?: number, mint?: string,
//        source?: string, destination?: string, authority?: string, delegate?: string, text?: string }
// System: 0 createAccount, 2 transfer (u32 LE tag, u64 LE lamports; accounts [from, to]).
// SPL Token / Token-2022: 3 transfer (legacy), 12 transferChecked [source, mint, destination, authority],
//   4 approve, 13 approveChecked, 6 setAuthority, 9 closeAccount, 17 syncNative.
// ATA: 0/empty create, 1 createIdempotent. ComputeBudget: 2 setLimit u32, 3 setPrice u64. Memo: utf8.

// rpc.mjs (existing) — new option, old behaviour unchanged when omitted:
new SolanaRpc({ url, timeoutMs }) // url wins over SOLFRONTIER_RPC_URL

// simulate.mjs
simulateWithDeltas(rpc, { txBase64, wallet, sigVerify, watch = [] }) → {
  ok: boolean, err: any, logs: string[], unitsConsumed: number|null,
  lamports: { pre: bigint, post: bigint },                       // the wallet itself
  tokens: { account, mint, owner, pre: bigint, post: bigint, decimals: number|null }[],
  accounts: Map<string, { exists: boolean, ownerProgram: string|null, tokenOwner: string|null, mint: string|null }>
}
// watch set = [wallet] ∪ wallet token accounts (getTokenAccountsByOwner, both token programs,
//   base64) ∪ caller's `watch` (decoded destinations) — max 40 addresses.
// pre:  getMultipleAccounts(watch, { encoding: 'base64', commitment: 'confirmed' })
// sim:  simulateTransaction(txBase64, { encoding: 'base64', sigVerify, replaceRecentBlockhash: false,
//        commitment: 'confirmed', accounts: { encoding: 'base64', addresses: watch } })
// token account layout: mint 0..32, owner 32..64, amount u64 LE 64..72. Mint decimals at byte 44.
// All amounts are BigInt inside the kit (reviewTransaction converts them to strings). A post-state
// token account whose owner == wallet counts as the wallet's own (covers an ATA created inside the
// same transaction).
```

### 5.5 Review and transaction policy (T4)

```js
reviewTransaction({ bytes, wallet, rpc, txPolicy, lists, cluster, signed }) → Review
// Review = {
//   messageSha256, version, feePayer, programs: string[], instructions: Ix[] (amounts as raw-unit strings),
//   sim: { ok, err, logs, unitsConsumed } | null,
//   outflow: { SOL?: string, [mintAddress]: string },  // keyed by "SOL" or mint ADDRESS (never a symbol);
//                                                      // UI-unit decimal strings, positive = leaving the wallet
//   inflow:  { ... same shape ... },
//   verdict: 'deny' | 'hold' | 'allow',
//   violations: Violation[], warnings: Violation[],
//   summaryLine: string                             // e.g. "−0.0010 SOL, +0.17 USDC · JUP6… · 4 ix"
// }
```

Order (stop at the first deny-level rule set that fails, but collect every violation in that set):

1. Decode (and ALT-resolve). Failure → `tx_decode_failed`, deny.
2. Static rules (no RPC): top-level programs ∉ `tx.programs` (`unknownProgram`), token
   delegation, legacy token transfer.
3. Simulate (`sigVerify: signed`). RPC failure → `rpc_unavailable`, deny. `err != null` →
   `simulation_failed`, deny.
4. Simulation rules: destinations — every decoded top-level System `transfer` / SPL `transfer` /
   `transferChecked` destination must be the wallet, a token account owned by the wallet in the
   **post-simulation** state (covers an ATA created in the same transaction), in `destinations`,
   or `destinations` is `"any"` (`destination_not_allowed`); SOL-equivalent outflow (native
   lamports + wrapped SOL mint `So11111111111111111111111111111111111111112`) vs
   `maxOutflow.SOL`; each mint vs `maxOutflow[mint]`; outflow of an unlisted mint →
   `unknownMintOutflow`.
5. `tx.approval === 'always'` ⇒ verdict `hold` (with warnings attached); `'never'` ⇒ `allow`.

Fees and rent count as outflow. Displayed amounts are exact decimal strings (no floats). Asset
symbols (e.g. `USDC` for `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`) appear only in `summaryLine`.

### 5.6 Holds and approval (T6)

```js
class HoldQueue {
  add({ kind: 'tool-arg' | 'rpc-send', tool?, review, cluster, timeoutSec }) → hold
  // hold = { id, createdAt, expiresAt, status: 'pending', kind, tool, review, approvalMessage }
  get(id); listPending();
  approve(id, { publicKey, signature /* Uint8Array */, method }) → hold   // throws if invalid
  reject(id, reason); cancel(id, reason);
  waitFor(id) → Promise<{ status: 'approved', approval } | { status: 'rejected', reason }
                        | { status: 'expired' } | { status: 'cancelled', reason }>
}
startApprovalServer({ holds, approver, method, cluster, port, logger }) → { url, close }
verifyApproval({ message, publicKey, signature, approver }) → boolean   // node:crypto Ed25519 via JWK
```

Hold ids: 12 random hex chars. Approval message — UTF-8, exactly these lines, generated once per hold:

```
SolFrontier Gate approval
hold: <id>
cluster: <cluster>
tx-message-sha256: <64 hex>
summary: <review.summaryLine>
expires: <ISO-8601 UTC>
```

HTTP (127.0.0.1 only, I11): `GET /` page, `GET /app.js`, `GET /api/holds` (pending, summaries),
`GET /api/holds/:id`, `POST /api/holds/:id/approve` body `{ publicKey, signature }` (signature
base64), `POST /api/holds/:id/reject` body `{ reason? }`. JSON only. CSP:
`default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self';
img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` — the same
shape the SolFrontier signing page used with Phantom on mainnet (2026-07-29, 2026-08-01).

Page: polls `/api/holds` every second; for each hold shows tool / kind, `summaryLine`, decoded
instructions, outflow / inflow, violations and warnings, message hash, live countdown.
**Approve with wallet**: `window.phantom.solana.connect()`; refuse if the connected key ≠
`approver`; `signMessage(new TextEncoder().encode(hold.approvalMessage), 'utf8')`; POST. **Reject**.
`method: "local-button"`: a plain Approve button, devnet/localnet only (I3).

`notify.mjs`: best effort, never throws, never blocks. macOS:
`spawn('osascript', ['-e', 'display notification "<escaped>" with title "SolFrontier Gate"'])`
and `spawn('open', [url])`; Linux `xdg-open`; otherwise nothing.

### 5.7 RPC checkpoint (T5)

```js
startRpcCheckpoint({ upstreamUrl, upstreamWsUrl, port, onSend, deniedMethods = ['sendBundle'] })
  → { url: 'http://127.0.0.1:<port>', wsUrl: 'ws://127.0.0.1:<port+1>', close }
onSend(bytes, { encoding, params, requestId, server }) → Promise<
  { forward: true } | { forward: false, code: number, message: string, data: object }>
```

- Paths: `POST /s/<server>` (what each downstream receives as its RPC URL) passes `server` to
  `onSend`; plain `POST /` passes `server: null` (the pipeline refuses sends from an unknown
  server). The WebSocket tunnel accepts the same `/s/<server>` paths and maps them to the
  upstream WebSocket URL's own path.

- JSON-RPC, single or batch. `sendTransaction`: decode `params[0]` with
  `params[1]?.encoding ?? 'base58'` (the RPC default is base58; web3.js sends base64) and call
  `onSend`. Forward → send the original request upstream, return the upstream body verbatim.
  Refuse → JSON-RPC error `{ code: -32099, message: 'SolFrontier Gate: <reason>', data }`.
- Methods in `deniedMethods` → error `-32098`. Everything else → forwarded verbatim.
- WebSocket on `port + 1`: raw tunnel to `upstreamWsUrl` (web3.js derives its ws URL as port + 1
  and uses it for `confirmTransaction`). On `upgrade`: open TCP/TLS to upstream, rewrite the
  request line path and `Host`, pipe both ways. PubSub is read-only, so it is not inspected.
- Upstream errors become JSON-RPC errors with a fixed message; the upstream URL never appears (I4).

### 5.8 Audit log (T1 writes, T8 verifies)

One JSON object per line:

```json
{"v":1,"seq":7,"ts":"2026-10-10T03:12:45.123Z","prev":"<64 hex>","type":"tool_call", "...": "...", "hash":"<64 hex>"}
```

`hash = sha256hex(prev + "\n" + JSON.stringify(recordWithoutHash))`; the first record's `prev`
is 64 zeros. Writer keeps insertion order stable; verifier re-serialises the parsed object minus
`hash` (JSON.parse preserves key order). On start, Gate verifies the existing file and continues
the chain; a broken chain ⇒ refuse to start (exit 2, message names the first bad line).

Types: `gate_start`, `downstream_ready`, `downstream_failed`, `tool_list`, `tool_call`
(decision), `tool_result` (sha256 of result, `isError`, extracted `signature` if any),
`tx_review` (messageSha256, summaryLine, verdict, violations, warnings), `hold_created`,
`hold_approved` (publicKey, signature base58, method), `hold_rejected`, `hold_expired`,
`hold_cancelled`, `rpc_send_forwarded` (signature), `rpc_send_refused`, `gate_stop`.

Correlation: every record produced by one host `tools/call` carries the same `callId`; every
record produced by one checkpoint `sendTransaction` carries the same `sendId`; hold records carry
`holdId` plus the parent `callId` or `sendId`. `tx_review` always carries `messageSha256`.

Argument logging: strings longer than 200 characters are replaced by `{ sha256, length }`.
Never log env values, URLs, or key material.

`sfcli audit --log <file> [--commitment confirmed|finalized] [--rpc-env SFGATE_UPSTREAM_RPC_URL]`
(example logs: `sfgate-audit.devnet.jsonl`, `sfgate-audit.mainnet.jsonl`)
(T8): verify the chain; for each `rpc_send_forwarded` / `tool_result` with a `signature`, find
the approved `messageSha256` through its `sendId` / `callId` (`hold_approved` → `tx_review`), fetch
`getTransaction` (base64), check it exists, `meta.err == null`, and that `sha256(messageBytes)`
equals the approved `messageSha256`. This works for tool-argument review too (Jupiter Ultra lands
the exact message the human approved — or the check FAILs and says so). Output rows `PASS / FAIL / UNVERIFIED` like the existing
audit; exit 0 only if no FAIL. Without RPC: chain only, signature rows `UNVERIFIED`.

### 5.9 Pipeline (I1)

```
tools/call(name, args)
  → split name → decideTool → audit tool_call
  → violations? → refusal
  → txArg? → bytes ← args[txArg] → reviewTransaction(signed=false) → audit tx_review
       → deny? → refusal
       → hold → notify → waitFor → audit hold_*
       → not approved? → refusal (approval_rejected | approval_timeout)
  → forward to downstream (callToolRaw) → audit tool_result → return result verbatim

checkpoint sendTransaction(bytes, server)
  → no host tools/call to that server in flight? → audit rpc_send_refused → JSON-RPC error (unsolicited_send)
  → reviewTransaction(signed=true) → audit tx_review
  → deny? → JSON-RPC error
  → hold → notify → waitFor → audit hold_*
  → approved? → forward upstream → audit rpc_send_forwarded(signature) → upstream body
  → else → audit rpc_send_refused → JSON-RPC error
```

A tool call that reaches the checkpoint (e.g. `wallet.transfer_sol` sends via `RPC_URL`) is held
there; the host's `tools/call` simply waits. The hold records the `callId`s of the host calls to
that server that were in flight when the send arrived; host `notifications/cancelled` for any of
them cancels the hold. A send that arrives while no call to its server is in flight is refused as
`unsolicited_send` before review — MCP servers act on tool calls, so a transaction nobody asked
for is the signature of a rogue server.

## 6. Honest limits — copy into the README as written

- **L1** The RPC checkpoint only sees transactions sent through it. A malicious downstream can
  ignore `RPC_URL` and talk to a public endpoint, or post to a third-party API (Jupiter Ultra
  does this by design — which is why tool-argument review exists). Against a malicious server
  the bound is the petty-cash balance.
- **L2** A malicious downstream can exfiltrate the petty-cash key. Same bound.
- **L3** Simulation predicts; it does not guarantee. State can change between simulation and
  landing. The human approves exact message bytes; slippage protection belongs to the
  transaction itself.
- **L4** Cross-program invocations are not decoded for display. Policy relies on simulated
  balance deltas of the wallet's own accounts for net effect.
- **L5** An agent with control of the user's browser or desktop could press the wallet's
  approve button. Do not give the agent computer-use while Gate is guarding funds.
- **L6** One approver, one machine. Multi-approver (Squads) is roadmap.

## 7. Test strategy

- Unit tests per module (`test/gate-*.test.mjs`, `test/solana-*.test.mjs`).
- Transaction vectors are built at test time with runtime keys (legacy transfer, v0 with one
  lookup table, SPL `transferChecked`, `approve`, legacy `transfer`, memo).
- I1 end-to-end, hermetic: `test/fake-upstream-rpc.mjs` (scripted `getLatestBlockhash`,
  `getMultipleAccounts`, `getTokenAccountsByOwner`, `simulateTransaction`, `sendTransaction`,
  `getSignatureStatuses`, `getTransaction`) + `test/fixtures/naive-wallet-mcp.mjs` + approvals
  signed in-test by a runtime approver key over the hold's `approvalMessage`.
- Manual, networked (the human): `scripts/demo/devnet-smoke.mjs`, Claude Desktop, Phantom.
