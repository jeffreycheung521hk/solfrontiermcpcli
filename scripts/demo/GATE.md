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

It exits 0 only when every row passes. A missing Gate or I1 pipeline is a failure; a skipped
scenario does not prove the integration works.

## Devnet run

These steps are for the human at their own Mac, with Node 20 or newer, Claude Desktop, and
Phantom installed in a browser. Devnet SOL is test money. Use a separate petty-cash wallet and
an approver account in Phantom; the approver signs an approval message, and the petty-cash
wallet sends the transaction. Keep all RPC values and key files on your machine. An agent must
not run this section or operate the browser for you.

### 1. Prepare your local config and wallet

1. Open Terminal in the `solfrontiermcpcli` folder. Run these commands and keep the two absolute
   paths for the Claude Desktop entry below:

   ```sh
   node --version
   node -p 'process.execPath'
   pwd
   ```

   The Node version must be at least 20. `process.execPath` is the absolute Node path; `pwd` is
   the absolute repository path. Nothing needs to be installed with npm.
2. If you already have a dedicated devnet petty-cash key file, reuse it. Otherwise run:

   ```sh
   node scripts/hackathon/new-petty-cash.mjs
   ```

   This creates the local key file and prints only its public address. Use a devnet faucet to
   fund that address with a small amount of test SOL (1 SOL is enough for these checks). Never
   open, paste, or export the key file's contents.

   The 0.5 SOL attack needs enough devnet balance to simulate a drain before policy refuses it.
   The smoke check's note about more than 0.1 SOL is expected with this demo balance; keep it
   in a dedicated devnet wallet and never reuse this balance guidance on mainnet.
3. In Phantom, select a separate account to be the Gate approver and copy its **public**
   address. Also choose a receiving address you own for the allowlist.
4. If `sfgate.devnet.json` does not already exist in the repository folder, copy
   `examples/sfgate.devnet.example.json` there under that name. Open your local copy in a text
   editor. Replace `REPLACE_WITH_YOUR_PHANTOM_APPROVER_ADDRESS` with the approver's public
   address and `REPLACE_WITH_AN_ADDRESS_YOU_OWN` with the receiving public address. Keep
   `cluster` as `devnet`, `approval.method` as `wallet-signature`, and the default policy and
   audit path `./sfgate-audit.devnet.jsonl`.
5. Set these environment variables privately in the Terminal you will use for the smoke check
   and attacks. Only their names are shown here:

   | Variable name | Local value to provide |
   |---|---|
   | `SFGATE_UPSTREAM_RPC_URL` | Your devnet RPC connection value |
   | `SFGATE_PETTY_CASH_PATH` | Absolute path to your petty-cash key file |

   To enter them without displaying the RPC value, start Bash with `bash`, then run:

   ```sh
   read -r -s -p 'Enter your devnet RPC privately: ' SFGATE_UPSTREAM_RPC_URL
   printf '\n'
   read -r -p 'Enter your petty-cash file path: ' SFGATE_PETTY_CASH_PATH
   export SFGATE_UPSTREAM_RPC_URL SFGATE_PETTY_CASH_PATH
   node scripts/demo/devnet-smoke.mjs sfgate.devnet.json 2> sfgate-preflight.stderr.log
   tail -n 30 sfgate-preflight.stderr.log
   ```

   The smoke check verifies that the variables are set, the config placeholders are filled,
   and the petty-cash wallet is funded. Continue only after it reports that pre-flight looks
   good. Keep this Terminal open so the attack suite uses the same environment later.

### 2. Add Gate to Claude Desktop

1. In Claude Desktop, open **Settings → Developer → Edit Config**. On macOS this opens
   `~/Library/Application Support/Claude/claude_desktop_config.json`.
2. Add the entry below to the existing `mcpServers` object, preserving your other entries.
   Replace the absolute-path placeholders with the paths from step 1. The `command` must be
   the absolute Node path, rather than just `node`. The two `env` values below are placeholders;
   fill them privately on your machine with the same values you entered in Terminal. This
   example shows environment names only, never a key or an RPC value.

   ```json
   {
     "mcpServers": {
       "solfrontier-gate": {
         "command": "/ABSOLUTE/PATH/TO/node",
         "args": [
           "/ABSOLUTE/PATH/solfrontiermcpcli/src/index.mjs",
           "gate",
           "run",
           "/ABSOLUTE/PATH/solfrontiermcpcli/sfgate.devnet.json"
         ],
         "env": {
           "SFGATE_UPSTREAM_RPC_URL": "<set privately on your machine>",
           "SFGATE_PETTY_CASH_PATH": "<set privately on your machine>"
         }
       }
     }
   }
   ```

   Gate receives a path to the petty-cash file. Do not put a private key, seed phrase, or the
   file's contents in this entry. Disable any separate wallet MCP entry that would let Claude
   reach the same wallet without Gate.
3. Save the file, fully quit Claude Desktop with **Claude → Quit Claude**, then reopen it.
   Open a new chat and check the Gate tools are available. If startup fails, use the failure
   instructions below before trying any transfer.

### 3. Run the four I1 checks in Claude Desktop

Replace `<allowlisted>` with the receiving public address you put in the allowlist. Send one
prompt at a time and wait for its expected result before continuing. The first prompt phrases
the I1 card's tool-visibility check; the other three are the card's transfer and balance prompts.

| # | Type this in Claude Desktop | Expected result |
|---|---|---|
| 1 | `List the SolFrontier Gate tools and call gate__status.` | Claude's Gate tool list contains only the configured allowed tools (`wallet__get_balance`, `wallet__token_info`, `wallet__transfer_sol`, `wallet__sign_and_send`) plus `gate__status`. Status says `devnet`, shows the petty-cash public key, and includes the approval page address. |
| 2 | `What's my balance?` | Claude calls the balance tool and answers with the petty-cash balance. No approval is needed. |
| 3 | `Send 5 SOL to <allowlisted>` | Gate refuses with `arg_out_of_bounds`; Claude explains that 5 SOL exceeds the 0.05 SOL limit. There is no approval hold or transfer. |
| 4 | `Send 0.001 SOL to <allowlisted>` | Gate creates a hold. A macOS notification appears and the approval page opens. After you approve using the steps below, Claude returns a transaction signature, the transaction confirms on devnet, and the signature appears in the audit log. |

The smoke check prints additional optional prompts; the four rows above are the I1 acceptance
sequence. A notification or browser that does not open automatically can be checked manually
using the approval page address from `gate__status`.

### 4. Approve the 0.001 SOL hold manually with Phantom

1. Unlock Phantom and select the approver account before sending prompt 4; the hold lasts
   40 seconds with the example config.
2. Open the approval page address from `gate__status` in the browser with Phantom installed
   (normally `http://127.0.0.1:8787`). The page must say **Cluster: devnet** and show the
   approver public address you configured.
3. Find the pending hold. Check the destination, decoded transfer instruction, outflow
   (0.001 SOL plus the fee), message hash, and countdown. Click **Reject** if the displayed
   transaction does not match your request.
4. Click **Approve with wallet**. If Phantom asks to connect, allow the connection with the
   configured approver account. An account mismatch must be refused; switch to the correct
   account before retrying.
5. In Phantom, read the message starting `SolFrontier Gate approval`. Check its hold id,
   `cluster: devnet`, transaction message hash, summary, and expiry against the page. Sign
   this message in Phantom. You are approving the exact transaction message; do not approve
   a different wallet transaction popup.
6. Wait for **Done: approved** on the page and Claude's result. Copy the transaction signature
   into Solana Explorer, select **Devnet**, and verify a successful transaction to the
   allowlisted address. In Terminal, run:

   ```sh
   tail -n 5 sfgate-audit.devnet.jsonl
   ```

   The audit tail should include the approved hold, `rpc_send_forwarded`, and a `tool_result`
   with the same transaction signature. If the hold expires, nothing should be sent; make a
   fresh request rather than approving an old hold.

### 5. Run the devnet attack suite

1. Finish the hold above, then fully quit Claude Desktop to stop its Gate process. Close the
   approval tab. Only one Gate process may write this audit file at a time.
2. In the same Terminal as the pre-flight, from the repository folder, run:

   ```sh
   node scripts/demo/attacks.mjs sfgate.devnet.json 2> sfgate-attacks.stderr.log
   tail -n 30 sfgate-attacks.stderr.log
   tail -n 5 sfgate-audit.devnet.jsonl
   ```

   Omitting the config argument also selects `sfgate.devnet.json` in this folder. This mode
   uses your config and environment against devnet; `--hermetic` is the separate loopback
   test mode. The attack script starts and stops its own Gate processes with available ports.
   With the example's naive demo wallet, it uses an isolated `--rogue` instance for A5 without
   changing your original config. Keep that fixture for this six-row demo.
3. Expect **PASS on all six rows**, including A5's `rpc_send_refused` audit record with code
   `unsolicited_send`. These are refusal checks: reject any unexpected hold during the attack
   run. A failed row or a timeout needs investigation; it is not a successful demo.
4. After the script exits, reopen Claude Desktop to restart your normal Gate entry. Start a
   new chat and call `gate__status` again to check that Gate is back on devnet.

### If any step fails: what to paste back

State the step number, the prompt or command you ran, and the result you expected. Include
only a short **stderr tail** and the last five audit records. For Claude Desktop's Gate log on
macOS, use:

```sh
tail -n 30 "$HOME/Library/Logs/Claude/mcp-server-solfrontier-gate.log"
tail -n 5 sfgate-audit.devnet.jsonl
```

If that log filename differs, open `~/Library/Logs/Claude/` and select the `mcp-server` log for
the `solfrontier-gate` entry. For a pre-flight or attack failure, use
`tail -n 30 sfgate-preflight.stderr.log` or `tail -n 30 sfgate-attacks.stderr.log` instead.
If the audit file has not been created yet, report that fact.

Review these tails locally before sharing. Replace any key material or RPC URL with
`[REDACTED]`, even inside an error message. **Never paste a key, seed phrase, key file,
environment variable value, RPC URL, or your filled-in Claude Desktop config.** Public wallet
addresses, hold ids, refusal codes, and transaction signatures are enough to diagnose the run.

## Notes

- Attack reports and Gate diagnostics go to **stderr**; stdout inside `gate run` is the MCP
  protocol only (SPEC I10).
- No script here prints key material — public keys and addresses only (SPEC I4).
- `scripts/demo/README.md`, `Demo.ps1`, `showcase.mjs` and `fixtures/` are historical evidence of
  the 2026-08 runs and must not be modified.
