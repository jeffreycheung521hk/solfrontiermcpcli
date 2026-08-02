# Solfrontier CLI mainnet demo（PowerShell 5.1）

這套 demo 使用一支 `Demo.ps1`，將路徑、金額、threshold、intent 與兩個錢包全部固定。它不修改 CLI／server 原始碼，也不採用預設 config 的 `scratch/dev.db`；每個 client 與 executor call 都顯式使用同一個 live DB：

- DB：`C:\Users\jeffr\solfrontiermcpcli\scratch\demo-20260802-run.db`
- amount：0.2 USDC（`200000` raw）
- threshold：88 bps
- intent：`58000000400d0300000000009a62dace`
- user：`C4QQjzWxnJ5QFAbkzhQJ3wTzyX6nw1vyFvJwbPXJGPNW`
- controlled ATA：`7LFdKcSV7JQYi3or5y9phHVPjhGigu5DDjUakAFbBmk3`

Runtime artifacts 全部位於 `solfrontiermcpcli\scratch\demo-live-20260802\`，不寫入已收官的 `solfrontiermcpskeleton\data` 或 acceptance DB。

## 為甚麼不直接使用 `flow --yes`

目前 `flow` 的 funding signature detection 只找 baseline 後的「任何新成功交易」，未先核對 exact memo、0.2 USDC delta 與 user signer；它對 `confirm_funding` 的 retry status 名稱也不完整。Demo 因此只組合現有 CLI primitives：

`propose → finalize → exact on-chain funding proof → confirm(same signature only)`

Server 的 `confirm_funding` 仍會重新驗證鏈上證據；PowerShell 只負責排除無關／舊 signature，並補上同一 signature 的 idempotent retry。

先前 `scratch/demo-20260802.db` 的零成本 dry-run rehearsal 已完成，且已消耗該 DB 的 deterministic intent。這套 live runbook 刻意不再提供 Rehearse mode，以免有人對 `demo-20260802-run.db` 誤跑 `flow --dry-run --user-wallet`（那會 finalize 並消耗 live intent）。

## 視窗分工

- Window A（client）：只設 `SOLFRONTIER_RPC_URL`；不可有 `SOLFRONTIER_CONTROLLED_WALLET_KEYPAIR`。
- Window B（executor）：相同 RPC；另設 `SOLFRONTIER_CONTROLLED_WALLET_KEYPAIR`。
- Hardened signing page 由 `Serve` mode 在背景啟動，只 bind `127.0.0.1:8081`，不持有任何 key。

## Source pins：CLI runtime objects + pinned server commit

CLI 端**不再以 HEAD 作 GO/NO-GO 判準**。原本 `$ExpectedCliHead` 是自我指涉的：
commit 這支 harness 本身就會改變 HEAD，因此已 commit 的版本永遠無法滿足自己的
pin。改為釘住 demo 實際執行的 runtime objects：

- `$ExpectedCliSrcTree`：`git rev-parse HEAD:src`
- `$ExpectedCliPackageBlob`：`git rev-parse HEAD:package.json`

只增加 tooling 的 commit 不會動到這兩個 object；任何 `src/` 或 `package.json` 的
改動都會令它們改變。除了 object 相符之外，pin 仍要求整個 repo 的 tracked
working-tree 與 index 乾淨，並拒絕 `src/` 內的 untracked runtime file——那些檔案
tree pin 看不見，但 import 解析得到。

HEAD 仍然記錄在 preflight provenance（連同 src tree 與 package blob），只是不再
是閘門。Server 端維持 `$ExpectedServerHead` commit pin：收官 repo 不會再變，沒有
不動點問題。

日後若再修改 `src/`，需更新並**重審**這兩個 object pin；不要只把數值換成新的來令
檢查變綠。

## 0. Offline self-check

Window A：

```powershell
Set-Location C:\Users\jeffr\solfrontiermcpcli
.\scripts\demo\Demo.ps1 -Mode Check
```

這一步不碰 RPC、DB 或資金；它檢查 PowerShell parser、Node 20+、JS syntax、known-good CLI runtime objects（`HEAD:src` tree 與 `HEAD:package.json` blob）＋ pinned server commit、binary/page/guard/config hashes，以及 watcher multi-JSON parser。

## 1. 啟動 hardened signing page

Window A：

```powershell
.\scripts\demo\Demo.ps1 -Mode Serve
```

Serve 由 pinned base page 產生一份 demo-only copy，再注入 hash-pinned `signing-guard.js`，以 Python 靜態 server 只服務於 `127.0.0.1:8081`。Guard 會：

- exact pin intent、amount、user／controlled wallet、ATA、mint、memo、instruction order 與 expiry；
- 要求同一 live executor 的 fresh heartbeat；
- 在 T−60 機械禁用 signing；
- 在第一次 Phantom submission 嘗試前把 one-shot latch 寫入 `localStorage`；
- success、exception、timeout、refresh、第二分頁都不可再送；Retry 永久停用。

原始 8080 signing server 可繼續存在，但 Live 只會顯示／開啟 hardened 8081 URL。

## 2. Preflight（Window A）

```powershell
.\scripts\demo\Demo.ps1 -Mode Preflight
```

Preflight 要求：known-good CLI runtime objects＋pinned server commit／binary／page／guard／config、mainnet genesis、host clock、exact ATA balances、兩端 SOL fee、strict doctor（reserve 必須 fresh 且 APY > 88）、zero actionable DB rows、intent `not_found`，以及鏈上從未出現該 intent memo prefix。任何舊 live marker／result／lock／heartbeat 都會 NO-GO。

## 3. 先啟 Executor（Window B）

```powershell
Set-Location C:\Users\jeffr\solfrontiermcpcli
.\scripts\demo\Demo.ps1 -Mode Executor `
  -Arm `
  -ApprovalText 'EXECUTE ONE PINNED DEMO INTENT'
```

看到 `EXECUTOR READY` 才回 Window A。Executor 使用獨立 throwaway DB 驗 keypair／RPC readiness，不會以 armed call 測 live DB；live DB 每輪先 read-only scan，只有唯一 pinned intent／amount 被分類為 `ready` 才做一次 execute call。

外層 loop 預設 10 分鐘 TTL、poll 只允許 2–5 秒、具有單例 lock 與 browser/client heartbeat。TTL 只控制 call 之間的 loop；若 native execute process 本身卡住，它不會被腳本粗暴 kill，該情況視為 outcome unknown，禁止 rerun。

## 4. Live funding（Window A）

```powershell
.\scripts\demo\Demo.ps1 -Mode Live `
  -Arm `
  -ApprovalText 'FUND 0.2 USDC ON MAINNET; CLICK ONCE; NEVER RETRY' `
  -OpenSigningPage
```

Live 在 finalize 緊前會再次驗 CLI/server/binary/page、balances、DB 與 executor heartbeat。Finalize 後只接受 baseline 之後、同時符合以下全部條件的 funding transaction：

- user wallet 是 signer；
- controlled ATA 的 USDC delta 精確為 `+200000`；
- memo 精確為本次 `claw:w5h:<intent_id>:<rule_hash>`；
- transaction 無 on-chain error。

找到第一筆後立刻以「同一 signature」confirm；`pending_confirmation`／retryable `rpc_error`／`funding_submitted` 只會重試同一 signature，不會重新入金。

Phantom 仍要人工核對連接錢包、0.2 USDC 與 destination。Guard 已機械阻擋第二次 submission，但操作原則仍是：Approve 一次；任何 error／timeout 都先查鏈，不重新 finalize、不重新入金。

## 5. Verify（Window A）

```powershell
.\scripts\demo\Demo.ps1 -Mode Verify
```

Verify 要求：

- DB funding lifecycle 與 watch rule 都是 terminal `completed`；
- executor report 為 `completed`，含 signature／finalized slot 與兩個 completed state；
- funding transaction 是 `finalized + err:null`，exact memo／signer／`+200000` delta；
- execution transaction 是 `finalized + err:null`，controlled wallet signer、Solend program 存在、controlled ATA delta 精確 `-200000`；
- 全歷史只有一筆 exact funding memo transaction；
- controlled ATA 最終 raw balance 回到 Preflight baseline（偵測晚到的第二筆 funding 或錯誤執行量）。

全部成立才輸出 `DEMO VERIFIED`，並寫入 `scratch\demo-live-20260802\verification.json`。

## 6. 額外演示公開 acceptance audit（Window A）

```powershell
.\scripts\demo\Demo.ps1 -Mode Audit
```

Audit 不只看 exit 0／`VERIFIED`，還要求已知 baseline：`13 PASS / 0 FAIL / 1 UNVERIFIED`。這驗的是既有公開 acceptance record，不是本次 demo run。

## 停止與不可重試邊界

- `rows: []` 與唯一 expected intent 的 `reserve_stale`／`condition_not_met` 可在 TTL 內安全等待；這些狀態尚未 lease。
- Exact candidate 在 final revalidation 被明確標示 `SKIPPED BEFORE LEASE` 時，可回到 wait；沒有 lease/sign/broadcast。
- 一旦出現任何 execution-attempt report，loop 必停。只有完整 `completed` 才 exit 0；其他 status、nonzero exit、serialization/cycle error 或不可解析 output 都禁止自動重跑。
- Live 在 finalize 前建立 one-shot marker。其後失敗只能針對原 intent／原 signature reconciliation，不可再跑 Live。
- 不要只搬移／備份 `.db`。SQLite 真實狀態可能仍在同名 `-wal`／`-shm`；保存時需連同 logs 一起保留。
- Executor 結束後關閉 key-bearing Window B。Hardened page PID 記錄在 `scratch\demo-live-20260802\signing-page.pid`；demo 完成後可先核對 PID，再手動 `Stop-Process -Id <pid>`。
