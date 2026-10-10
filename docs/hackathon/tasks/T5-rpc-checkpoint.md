# T5 — RPC checkpoint (loopback JSON-RPC proxy + WebSocket tunnel)

> **給 Jeff**：不依賴任何卡。第一輪有空位就一起開（否則第二輪），獨立任務、獨立 branch。預估 2–3 小時。
> 這張卡是「可砍」的（K1）：到 K1 還接不上就砍，產品仍有 tool 層 + 交易參數審查。

Branch: `gate/checkpoint`, created from the latest `main` · Depends on: nothing · Blocks: I1 (RPC path)

## Goal

Every downstream gets `http://127.0.0.1:<port>` as its RPC URL. Reads pass through untouched;
`sendTransaction` is handed to a callback that decides whether it may go upstream.

## You own

`src/gate/rpc-checkpoint.mjs`, `test/gate-rpc-checkpoint.test.mjs`

## Read first

SPEC §5.7 (exact contract), I4, I7, I11. Pattern for an in-test HTTP server:
`test/fake-rpc-server.mjs`.

## Build

1. `startRpcCheckpoint({ upstreamUrl, upstreamWsUrl, port, onSend, deniedMethods })` →
   `{ url, wsUrl, close }`. HTTP server on `127.0.0.1:port`, WebSocket tunnel on `port + 1`.
   Routes: `POST /s/<server>` (server name `^[a-z0-9-]{1,16}$`) passes `server` in `onSend`'s
   meta; `POST /` passes `server: null`. The tunnel accepts the same paths. Base58 for
   `sendTransaction` decoding: write a small private decoder inside your module (T3's
   `src/solana/base58.mjs` is on a parallel branch; I1 swaps it in). Do not create files T3 owns.
2. JSON-RPC handling: single object or batch array; preserve ids; process a batch's
   `sendTransaction` entries sequentially. Body limit 2 MB; non-JSON ⇒ `-32700`.
3. `sendTransaction`: decode `params[0]` using `params[1]?.encoding ?? 'base58'`
   (`base64` | `base58`); undecodable ⇒ `-32602`; then `await onSend(bytes, { encoding, params, requestId, server })`.
   Forward ⇒ POST the original JSON-RPC object upstream and return the upstream body as is.
   Refuse ⇒ `{ code: -32099, message: 'SolFrontier Gate: ' + message, data }`.
4. `deniedMethods` ⇒ `-32098`. All other methods ⇒ forwarded verbatim (method, params, id).
5. Upstream failure (network, non-2xx, non-JSON) ⇒ `-32097` with a fixed message. The upstream
   URL must not appear in any response, log line or thrown error (I4).
6. I11: reject wrong `Host`, reject foreign `Origin`, accept only `POST /`, `POST /s/<server>`
   (+ `GET /health` → `ok`).
7. WebSocket tunnel: on `upgrade` at `port + 1`, connect (`tls.connect` for `wss`, `net.connect`
   for `ws`) to `upstreamWsUrl`, rewrite the request line path and `Host`, pipe both directions,
   destroy both sockets when either closes. No frame parsing.
8. `onSend` throwing or taking longer than its own timeout is the caller's business — but if it
   throws, respond `-32099` and do not forward (I7).

## Acceptance

- [ ] Reads pass through verbatim to a local fake upstream (assert byte-equal bodies), on both
      `/` and `/s/wallet`.
- [ ] `onSend` receives `server: 'wallet'` for `/s/wallet` and `server: null` for `/`; a bad
      server name in the path ⇒ 404.
- [ ] `sendTransaction` base64 and base58: `onSend` receives identical bytes; forward ⇒ upstream
      receives the original request; refuse ⇒ `-32099` and upstream receives nothing.
- [ ] Batch with a read + a refused send ⇒ read answered, send refused, ids preserved.
- [ ] `sendBundle` ⇒ `-32098`. Wrong `Host` ⇒ 403. Foreign `Origin` ⇒ 403.
- [ ] Upstream down ⇒ `-32097`; the test asserts the upstream URL string appears nowhere in the response.
- [ ] Tunnel: a fake upstream that answers `101 Switching Protocols` then echoes bytes — bytes
      written by the client come back through the tunnel.
- [ ] `close()` frees both ports (start / close / start again on the same port succeeds).

## Launch prompt

```
You are Agent E in this repository. Read AGENTS.md, docs/hackathon/SPEC.md and
docs/hackathon/tasks/T5-rpc-checkpoint.md. Create branch gate/checkpoint from the latest main.
Implement T5 until every Acceptance box is ticked, committing after each green step. Do not
start any other card. Do not add any npm dependency. Finish by opening a PR listing what is
verified, what is UNVERIFIED, and needs from other cards. Then stop.
```
