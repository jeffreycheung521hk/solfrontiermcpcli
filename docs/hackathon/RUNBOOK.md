# SolFrontier Gate 衝刺手冊（10/9 → 10/13）

## 0. 一頁看懂

- **截止**：10/13（二）15:59 JST（= 10/12 23:59 PDT）。**目標提交**：10/12（一）18:00 JST，留約 22 小時緩衝。
- **Code freeze**：10/12（一）12:00 JST。之後只改文件、影片、表單。
- **策略**：以 `solfrontiermcpcli`（zero-dep Node、已有 MCP transport 和 187 個測試）為底，
  4 個 AI agent 平行寫程式（夜班在雲端跑），你只做 agent 做不了的五件事：
  1. 決策與合併 PR
  2. 在 Claude Desktop / Phantom / devnet / mainnet 實測
  3. 管 petty-cash 的錢
  4. 錄兩支影片（pitch、技術 demo，各 ≤ 3 分鐘）
  5. 填表與提交
- **完全不做**：Rust、on-chain program、Squads、payment channel、獨立網站（全部放 roadmap）。

## 1. 時間表（JST）

| 時間 | 誰 | 做什麼 |
|---|---|---|
| **週五 10/9** | | |
| 18:30–19:30 | 你 | 表單 draft；把 kit 放進 repo、commit、push（§3.1） |
| 19:30–20:15 | 你 | 啟動 Agent A / B / C / D（夜班 N1，§3.2） |
| 20:15–22:30 | 你 | 環境準備（§3.3） |
| 22:30–23:30 | 你 | Spike：jupiter-mcp、SendAI 單獨能不能跑（§3.4）→ **K0** |
| 23:30–00:30 | 你 | 巡檢 agent、回答 `docs/hackathon/questions/` 裡各卡的問題 → 睡 |
| **週六 10/10** | | |
| 08:00–09:30 | 你 | 看 4 個 PR，依序合併（§4），`npm test` |
| 09:30–10:00 | 你 | Claude Desktop 冒煙測試：gate + 示範錢包，只測「列工具 / deny」（`get_balance` 要等 I1 把 RPC checkpoint 接上才會通，現在失敗是正常的 fail-closed） |
| 10:00–15:00 | 你 + Agent A（本機） | **I1 整合**：先 hermetic 測試全綠，再上 devnet |
| **15:00** | ✅ **CP1** | devnet 上「轉 5 SOL 被拒」＋「0.001 SOL 經 Phantom 簽名核准後上鏈」 |
| 15:00–18:00 | 你 + Agent A | 接真實 server：jupiter-mcp（mainnet）或 SendAI（devnet），看 K0 結果 |
| **18:00** | ⛔ **K1** | 哪條路不通就砍（§5） |
| 18:00–20:00 | 你 | `attacks.mjs` 在 devnet 跑一輪；錄第一段 GIF |
| 20:00–21:00 | 你 | Colosseum「Builder updates」#1；啟動夜班 N2 |
| 21:00–00:30 | 你 | 用 `SUBMISSION.md` 骨架寫 pitch 稿初版 → 睡 |
| **週日 10/11** | | |
| 08:00–10:30 | 你 + Agent A | **只修 R1 的 P0**；`attacks.mjs` devnet 全 PASS |
| 10:30–13:30 | 你 | **Mainnet proof**（§3.5）＋ `audit --log` PASS |
| 13:30–16:00 | 你 + Agent C | README 定稿：填入真實簽名、真實輸出 |
| **16:00** | ⛔ **K2** | 功能凍結候選：能跑的就是產品，其餘寫進 roadmap |
| 16:00–19:00 | 你 | 照 `DEMO-SCRIPT.md` 錄技術 demo 素材（錄 2–3 次） |
| 19:00–23:00 | 你 | Pitch slides（6–8 張）＋錄旁白；Builder update #2 |
| 夜班 N3 | agents | 只做文件、錯字、連結檢查，不碰功能 |
| **週一 10/12** | | |
| 09:00–12:00 | 你 | 剪兩支片、上傳 YouTube（不公開） |
| **12:00** | ⛔ | **Code freeze** |
| 13:00–17:00 | 你 | 填完整 submission（`SUBMISSION.md` 直接貼）、提交 |
| **18:00** | 🎯 | 目標提交時間 |
| **週二 10/13** | | 15:59 前只處理上傳 / 表單問題 |

睡眠：週五、週六各約 01:00–08:00。夜班時 agent 在雲端跑，你不用守著。

## 2. Agent 分工

| 代號 | 用什麼 | 夜班 N1（週五晚） | 週六白天 | 夜班 N2（週六晚） |
|---|---|---|---|---|
| **A** | Claude Code | T1 → T2（branch `gate/core`） | **I1 整合**（本機，你在旁） | 修 bug |
| **B** | Codex（GPT） | T3 → T4（`gate/tx`） | 待命 | T8（`gate/audit`） |
| **C** | Claude Code 雲端，或 Codex | T7 → T5（`gate/fixtures`） | 協助測試 | T9（`gate/docs`） |
| **D** | Codex（GPT） | T6（`gate/approval`） | — | R1 審查（`review/r1`），只審不改 |

每張卡都在 `docs/hackathon/tasks/`，最後一段是可以直接貼的 **Launch prompt**。

**在哪裡跑**

- **夜班一律跑雲端**（Claude Code on the web、Codex cloud）：在別人的沙盒裡，碰不到你 Mac 上的錢包和 key；
  每個 agent 自己開 PR。前提：kit 已經 push 到 GitHub `main`。
- **雲端不能用時**：本機開 worktree（§3.2），而且只在你醒著時跑。
- **本機跑 Claude Code 的 terminal 裡不要 export 任何 `SFGATE_*` 或 key**。petty-cash 檔放
  `~/.sfgate/`（repo 外）。`.claude/settings.json` 已擋掉讀這些路徑，但它只是護欄，不是沙盒。

## 3. 今晚（週五）逐步清單

### 3.1 把 kit 放進 repo

```bash
cd ~/dev                                  # 你放程式碼的資料夾
git clone https://github.com/jeffreycheung521hk/solfrontiermcpcli   # 已有就：cd 進去 git pull
cd solfrontiermcpcli
unzip -o ~/Downloads/sfgate-kit.zip -d .
printf '\n# hackathon: personal configs and live audit logs (repo root only)\n/sfgate.*.json\n/sfgate-audit*.jsonl\n' >> .gitignore
npm test                                  # 應該全綠
git add -A
git commit -m "docs(hackathon): build kit — spec, task cards, runbook, examples"
git push
```

### 3.2 啟動 4 個 agent

- **雲端**：Codex 選這個 repo → 開 task → 貼 T3 的 Launch prompt（B）、T6 的（D）。
  Claude Code on the web 同樣選 repo → 貼 T1 的（A）、T7 的（C）。
- **本機備案**：

```bash
git worktree add ../sfgate-A -b gate/core
git worktree add ../sfgate-C -b gate/fixtures
cd ../sfgate-A && claude                  # 貼 T1 的 Launch prompt；C 同理在 ../sfgate-C
```

### 3.3 環境準備

```bash
node -v                                   # 需要 ≥ 20
which node                                # 記下絕對路徑，Claude Desktop 設定要用
node scripts/hackathon/new-petty-cash.mjs # 產生 ~/.sfgate/petty-cash.json，印出地址
```

- **devnet 入金**：<https://faucet.solana.com> 貼上 petty-cash 地址，選 devnet，領 1–2 SOL。
- **mainnet 入金**（給 K0 spike 和週日 proof）：從主錢包轉 **0.02 SOL** 到 petty-cash 地址。總額不超過 0.03 SOL。
- **Phantom**：新增一個帳號叫「Gate Approver」，不用放錢，只用來簽核准訊息。複製它的地址。
- **RPC**：devnet 先用 `https://api.devnet.solana.com`；mainnet 申請 Helius 免費方案（URL 含 API key，只放環境變數）。
- **設定檔**：`cp examples/sfgate.devnet.example.json sfgate.devnet.json`，把兩個 `REPLACE_…` 換掉：
  `approver` = Gate Approver 地址；`allowlist` = 你自己另一個地址（例如 Phantom 主帳號）。

### 3.4 Spike（K0）：第三方 server 單獨能不能跑

目的：決定週六 / 週日 demo 用哪個真實 server。測完**一定**要把這兩段從 Claude Desktop 設定刪掉（裡面是明文 key）。

```bash
node scripts/hackathon/new-petty-cash.mjs --export-base58   # 只貼進下面的設定，不要貼到任何聊天
cd ~/dev && git clone https://github.com/kukapay/jupiter-mcp && cd jupiter-mcp && npm install
```

Claude Desktop 設定（`~/Library/Application Support/Claude/claude_desktop_config.json`）暫時加：

```json
{
  "mcpServers": {
    "jupiter-spike": {
      "command": "/你的/node/絕對路徑",
      "args": ["/Users/你/dev/jupiter-mcp/index.js"],
      "env": { "SOLANA_RPC_URL": "https://api.mainnet-beta.solana.com", "PRIVATE_KEY": "<petty-cash base58>" }
    },
    "sendai-spike": {
      "command": "npx",
      "args": ["-y", "solana-mcp"],
      "env": { "RPC_URL": "https://api.devnet.solana.com", "SOLANA_PRIVATE_KEY": "<petty-cash base58>" }
    }
  }
}
```

重開 Claude Desktop，試：

1. jupiter：「用 get-ultra-order 拿 0.001 SOL 換 USDC 的報價」→ 有沒有拿到含 `transaction` 的結果？
   再讓它 execute 一次（0.001 SOL，確認整條路通）。
2. SendAI：「我的 SOL 餘額多少？」「轉 0.001 SOL 給 <你的地址>」（devnet）。

把結果填進 §6，然後刪掉這兩段設定、重開 Claude Desktop。

### 3.5 Mainnet proof（週日 10:30）

- K0 jupiter 可用 → 用 `examples/sfgate.mainnet-jupiter.example.json`：Claude Desktop 叫它換 0.001 SOL → USDC，
  在核准頁看解碼和模擬結果，用 Phantom 簽核准。Jupiter Ultra 是在 Jupiter 伺服器端送出交易，
  但送出的訊息就是你核准的那一份，所以 `audit --log` 仍能比對訊息雜湊（不一致就會 FAIL，照實寫進 README）。
- K0 jupiter 不可用 → 示範錢包在 mainnet 轉 0.001 SOL 給自己（經 RPC checkpoint，`audit --log` 可 PASS）。
- 最理想：兩筆都做。把 mainnet 的 audit log 複製到 `docs/proof/` 再 commit，判審可以自己跑 `audit --log`。

## 4. 合併流程（每次都一樣）

1. GitHub 上看 PR：測試綠嗎？描述裡的 `UNVERIFIED` 和 `Needs from others` 是什麼？
2. 依序合併：`gate/core` → `gate/tx` → `gate/approval` → `gate/fixtures`（各自動不同檔案，衝突應該很少）。
   雲端 agent 的 branch 可能被加上 `claude/`、`codex/` 前綴（例如 `claude/gate-core`），看 PR 標題裡的卡號對應即可。
3. 本機：`git switch main && git pull && npm test`
4. 紅了：在本機 Claude Code 貼：
   「main 在合併 <branch> 後測試失敗。只做讓測試通過所需的最小改動，不改行為；逐一說明每個改動。」

## 5. Checkpoints 與砍功能

- **K0（週五 23:30）**：見 §3.4。jupiter 不能用 → mainnet proof 改用示範錢包；SendAI 不能用 → 不接。
- **CP1（週六 15:00）**：devnet 兩件事都成功。
- **K1（週六 18:00）**：
  - RPC checkpoint（T5）不通 → **砍 T5**。產品保留 tool 層、交易參數審查（`sign_and_send`、Jupiter execute）、錢包簽名核准、audit。README 的 L1 照實寫。
  - Phantom 簽名核准不通 → devnet 改 `local-button`（SPEC I3 只允許 devnet），影片裡講明；mainnet 不做實際轉帳，只示範「沒有核准就不送」。
- **K2（週日 16:00）**：功能凍結候選。

**落後時從上往下砍**：
1. WebSocket tunnel、SendAI、桌面通知 / 自動開瀏覽器
2. T5 RPC checkpoint
3. Mainnet proof（改 devnet，README 引用 8/1 的 mainnet 驗收紀錄當 lineage）
4. **永遠不砍**：tool policy、交易參數審查 + 模擬、錢包簽名核准、audit chain、兩支影片、提交表單

## 6. 決策紀錄（邊做邊填）

| 時間 | 項目 | 結果 | 決定 |
|---|---|---|---|
| 週五 | jupiter-mcp 單獨可用？ | | |
| 週五 | SendAI solana-mcp 單獨可用？ | | |
| 週六 15:00 | CP1 | | |
| 週六 18:00 | K1 | | |
| 週日 | mainnet proof 簽名 | | |
| 週日 16:00 | K2 | | |

## 7. 這幾天的安全守則

- 所有 key 只放 `~/.sfgate/`。petty-cash：devnet 隨意，mainnet ≤ 0.03 SOL。
- **主錢包只簽核准訊息**，永遠不匯入任何 MCP server。
- 不把 Claude Desktop 設定檔內容、`--export-base58` 的輸出、含 API key 的 RPC URL 貼給任何 agent。
- 錄影、截圖前檢查畫面：不能出現 RPC URL、key、設定檔的 `env` 區塊。

## 8. 常見卡關

| 症狀 | 先看 |
|---|---|
| Claude Desktop 看不到 gate 的工具 | `command` 要用 `node` 的**絕對路徑**；log 在 `~/Library/Logs/Claude/`（`mcp*.log`） |
| 核准頁上 Phantom 沒反應 | 一定要開 `http://127.0.0.1:8787`（不是 file://）；用有裝 Phantom 的瀏覽器；切到 Gate Approver 帳號 |
| devnet faucet 領不到 | 換時段再試，或用其他 devnet faucet；一次 1 SOL 就夠整個 demo |
| agent 停住不動 | 看該 branch 的 `docs/hackathon/questions/<卡號>.md`，回答後叫它繼續 |
| 合併後測試紅 | §4 第 4 步 |
| 整條路不通、時間到 | §5 砍功能順序，不要硬撐 |
