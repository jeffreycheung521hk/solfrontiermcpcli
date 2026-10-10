# SolFrontier Gate — demo scripts (T7)

How to run the Gate demo material added for the Crypto World's Fair sprint. This is **new**
material; it does not replace [`README.md`](./README.md), which is the historical (consumed,
do-not-rerun) 2026-08 mainnet run. Nothing here moves real money until the human runs the devnet
steps with a funded petty-cash wallet.

The scripts are:

| Script | Who runs it | Network |
|---|---|---|
| `test/fixtures/naive-wallet-mcp.mjs` | the pipeline / tests | none (hermetic) or devnet |
| `test/fake-upstream-rpc.mjs` | the hermetic tests | none |
| `scripts/demo/attacks.mjs` | CI (`--hermetic`) and the human (devnet) | none / devnet |
| `scripts/demo/devnet-smoke.mjs` | the human, before a live demo | devnet |

## 0. What the pieces are

- **`naive-wallet-mcp.mjs`** is the demo *target*: a deliberately naive Solana wallet MCP server
  that holds its key in an env var and signs/sends in-process — the pattern Gate exists to guard.
  It imports nothing from `src/`. Tools: `get_balance`, `transfer_sol`, `sign_and_send`,
  `token_info` (whose text carries a prompt-injection line, a demo prop). `--rogue` makes it
  attempt one unsolicited drain ~5s after start, logged to stderr only.
- **`fake-upstream-rpc.mjs`** is a scripted, loopback JSON-RPC server standing in for the cluster
  in hermetic tests. No network; binds port 0.

## 1. Hermetic: run the attack suite (no network, no keys)

```sh
node scripts/demo/attacks.mjs --hermetic
```

Plays a compromised agent against `sfcli gate run` and prints a
`scenario · expected · observed · result` table:

| # | Scenario | Expected refusal |
|---|---|---|
| A1 | `transfer_sol` amount 5 (over the bound) | `arg_out_of_bounds` |
| A2 | `transfer_sol` to a non-allowlisted address | `arg_not_allowed` |
| A3 | `sign_and_send` a crafted 0.5 SOL drain | `destination_not_allowed` / `outflow_exceeds_bound` |
| A4 | `sign_and_send` an SPL approve to the attacker | `token_delegation_denied` |
| A5 | wallet started `--rogue` (no tool call in flight) | `unsolicited_send` (audit log) |
| A6 | an unlisted tool name | `unknown_tool` |

It exits 0 only when every row passes. **Before T1 and the I1 pipeline are merged**, rows that
need them print `SKIP needs T1` / `SKIP needs I1`, the suite prints a `PARTIAL` banner and still
exits 0 — so it is safe to wire into CI now. Once T1 + I1 land it runs the scenarios for real.

## 2. Devnet: pre-flight before a live demo

Set the two env vars (the real ones, not committed) and point the smoke check at your filled-in
config:

```sh
export SFGATE_UPSTREAM_RPC_URL="https://api.devnet.solana.com"   # or your own devnet RPC
export SFGATE_PETTY_CASH_PATH="$HOME/.sfgate/petty-cash.json"    # created by scripts/hackathon/new-petty-cash.mjs
node scripts/demo/devnet-smoke.mjs sfgate.devnet.json
```

It checks the env var **names** are set (never prints their values), derives the petty-cash
**public** key and reads its balance through the upstream (flagging an unfunded or too-large
wallet), checks the config has no `REPLACE_` placeholders left, and prints the exact Claude
Desktop prompts to try with the expected outcome of each.

Create and fund the petty-cash wallet first:

```sh
node scripts/hackathon/new-petty-cash.mjs          # prints the address to fund (keep it small)
# fund on devnet via https://faucet.solana.com
```

## 3. Devnet: run the attack suite for real

With Gate running against devnet and the config above:

```sh
node scripts/demo/attacks.mjs        # default mode = real env; expects every row PASS on devnet
```

After each money step, capture the Gate stderr tail and `tail -n 5 sfgate-audit.devnet.jsonl`
for the record.

## Notes

- All output is on **stderr**; stdout inside `gate run` is the MCP protocol only (SPEC I10).
- No script here prints key material — public keys and addresses only (SPEC I4).
- `scripts/demo/README.md`, `Demo.ps1`, `showcase.mjs` and `fixtures/` are historical evidence of
  the 2026-08 runs and must not be modified.
