[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Check', 'Serve', 'Preflight', 'Executor', 'Live', 'Verify', 'Audit')]
    [string]$Mode,

    [switch]$Arm,
    [string]$ApprovalText = '',
    [switch]$OpenSigningPage,
    [ValidateRange(2, 5)]
    [int]$PollSeconds = 3,
    [ValidateRange(8, 30)]
    [int]$ExecutorTtlMinutes = 10,
    [ValidateRange(30, 600)]
    [int]$VerifyTimeoutSeconds = 180
)

# Windows PowerShell 5.1 compatible. This file intentionally contains only
# ASCII text so that it also parses correctly when the host assumes ANSI.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $Utf8NoBom
$OutputEncoding = $Utf8NoBom

# Pinned demo contract. Do not silently change one value without reviewing all
# of them: the deterministic intent, funding memo, signer page and executor DB
# must describe the same run.
$CliRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$ServerRoot = 'C:\Users\jeffr\solfrontiermcpskeleton'
$CliEntry = Join-Path $CliRoot 'src\index.mjs'
$Binary = Join-Path $ServerRoot 'target\release\solfrontier-mcp.exe'
$Db = Join-Path $CliRoot 'scratch\demo-20260802-run.db'
$RunDir = Join-Path $CliRoot 'scratch\demo-live-20260802'
$LogDir = Join-Path $RunDir 'logs'
$HeartbeatPath = Join-Path $RunDir 'executor-heartbeat.json'
$ExecutorLockPath = Join-Path $RunDir 'executor.lock'
$LiveMarkerPath = Join-Path $RunDir 'live-started.json'
$ExecutorResultPath = Join-Path $RunDir 'executor-result.json'
$FundingResultPath = Join-Path $RunDir 'funding-result.json'
$PreflightPath = Join-Path $RunDir 'preflight.json'
$SigningPageSource = Join-Path $ServerRoot 'web\signing-page\index.html'
$SigningGuardSource = Join-Path $PSScriptRoot 'signing-guard.js'
$DemoConfig = Join-Path $PSScriptRoot 'demo.config.json'
$HardenedPageDir = Join-Path $RunDir 'hardened-signing-page'
$HardenedPagePath = Join-Path $HardenedPageDir 'index.html'
$HardenedGuardPath = Join-Path $HardenedPageDir 'signing-guard.js'
$BrowserHeartbeatPath = Join-Path $HardenedPageDir 'executor-heartbeat.json'
$SigningPagePidPath = Join-Path $RunDir 'signing-page.pid'
$SigningPageBase = 'http://127.0.0.1:8081/index.html'
$FinalizeSigningPageBase = 'http://127.0.0.1:8080/index.html'
$AcceptanceDoc = Join-Path $ServerRoot 'docs\phase3b-2-mainnet-acceptance.en.md'

$AmountUsdc = '0.2'
$AmountRaw = '200000'
$ThresholdBps = 88
$ExpectedIntentId = '58000000400d0300000000009a62dace'
$UserWallet = 'C4QQjzWxnJ5QFAbkzhQJ3wTzyX6nw1vyFvJwbPXJGPNW'
$UserUsdcAta = '4bDArC4UVoBjecHUZaCKqhuhTYPoiKS4qpQQpxuvm1qn'
$ControlledWallet = 'BPfDMmeMBmCbMC1rWh7hwigMBoKGBrKwXxSeUu9hhs5L'
$ControlledUsdcAta = '7LFdKcSV7JQYi3or5y9phHVPjhGigu5DDjUakAFbBmk3'
$UsdcMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
# Pinned so funding proof reads the instructions themselves rather than the
# RPC's memo summary field, which is formatted "[byte_len] memo" and joins
# multiple memos with "; ".
$MemoProgramId = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'
$TokenProgramId = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
$SolendProgram = 'So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo'
# The full 44-character base58 genesis hash that getGenesisHash returns.
# Not to be confused with the 32-character CAIP-2 short chain identifier
# (solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp), which is that hash truncated
# to 32 characters and is a different identifier. Compared with exact
# equality on purpose: a prefix comparison would accept the CAIP-2 form and
# silently weaken the chain-identity check.
$MainnetGenesisHash = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
# Verified against every reserve snapshot, never used to define the rule: the
# 16-slot bound belongs to the reviewed executor and CLI. A mismatch means the
# runtime moved underneath this harness and is a hard failure, not a wait.
$ExpectedMaxReserveStalenessSlots = 16
# CLI is pinned by the runtime objects it actually executes, not by HEAD.
# Pinning HEAD is self-defeating here: committing this harness changes HEAD,
# so the pin could never be satisfied by a committed copy of itself. These
# two objects are what the demo actually runs; they are unchanged by any
# commit that only adds tooling, and any edit to src/ or package.json moves
# them. HEAD is still recorded as provenance, it is just not a gate.
$ExpectedCliSrcTree = 'eaa9447c2050e9266db8eb487baf60b42512c025'
$ExpectedCliPackageBlob = 'a072245bfce5f95a1aff82537a001151031dc47e'
$ExpectedServerHead = 'e27ce3de129a62e1de69ccaf5b2b7d44fab4d52d'
$ExpectedBinarySha256 = '610117761832FCB7336D47E192BA5558439BE89CCABA1F2D1C6CD0CC3333EA80'
$ExpectedSigningPageSha256 = '500FFBD866B230AF09E998A64EE3B1C90721A67BC7BA1B6690D38E2CDEA25F4A'
$ExpectedSigningGuardSha256 = 'BA3C5F1F9CA71D5D0B01269210EF0AE899FCACD85AD10C1B2E47A76514CA4837'
$ExpectedDemoConfigSha256 = '10419FBA0620608690C6B51A217A766DD2D2B599DEBFA71E477523E205F9328E'
$LiveApproval = 'FUND 0.2 USDC ON MAINNET; CLICK ONCE; NEVER RETRY'
$ExecutorApproval = 'EXECUTE ONE PINNED DEMO INTENT'

function Write-Step([string]$Message) {
    Write-Host "`n== $Message ==" -ForegroundColor Cyan
}

function Stop-Demo([string]$Message) {
    throw "NO-GO: $Message"
}

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { Stop-Demo $Message }
}

function Assert-Equal($Actual, $Expected, [string]$Label) {
    if ([string]$Actual -cne [string]$Expected) {
        Stop-Demo "$Label mismatch (expected '$Expected', got '$Actual')"
    }
}

function Assert-File([string]$Path, [string]$Label) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        Stop-Demo "$Label not found: $Path"
    }
}

function Assert-KeylessShell {
    if (-not [string]::IsNullOrWhiteSpace($env:SOLFRONTIER_CONTROLLED_WALLET_KEYPAIR)) {
        Stop-Demo 'controlled-wallet keypair is present in this client shell; use a separate keyless PowerShell window'
    }
}

function Assert-RpcPresent {
    if ([string]::IsNullOrWhiteSpace($env:SOLFRONTIER_RPC_URL)) {
        Stop-Demo 'SOLFRONTIER_RPC_URL is not set'
    }
}

function Get-Sha256Text([string]$Text) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes($Text)
        return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '')
    }
    finally { $sha.Dispose() }
}

function Get-RpcFingerprint {
    Assert-RpcPresent
    return Get-Sha256Text $env:SOLFRONTIER_RPC_URL
}

function Write-JsonFile([string]$Path, $Value) {
    $parent = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $parent)) {
        [void](New-Item -ItemType Directory -Path $parent -Force)
    }
    $json = $Value | ConvertTo-Json -Depth 40
    $tempPath = "$Path.tmp-$PID-$([Guid]::NewGuid().ToString('N'))"
    try {
        [IO.File]::WriteAllText($tempPath, $json + [Environment]::NewLine, $Utf8NoBom)
        # [NullString]::Value, not $null. Windows PowerShell 5.1 marshals a
        # bare $null to a string parameter as "", and File.Replace rejects an
        # empty backup path with "The path is not of a legal form" -- so the
        # overwrite branch failed on every write after the first, while the
        # create branch worked. Atomic replacement is kept deliberately: a
        # Remove-Item plus Move would leave a window in which the destination
        # does not exist.
        if (Test-Path -LiteralPath $Path) {
            [IO.File]::Replace($tempPath, $Path, [NullString]::Value)
        }
        else {
            try { [IO.File]::Move($tempPath, $Path) }
            catch [IO.IOException] { [IO.File]::Replace($tempPath, $Path, [NullString]::Value) }
        }
    }
    finally {
        if (Test-Path -LiteralPath $tempPath) { Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue }
    }
}

function New-ExclusiveJsonFile([string]$Path, $Value) {
    $parent = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $parent)) {
        [void](New-Item -ItemType Directory -Path $parent -Force)
    }
    $stream = $null
    try {
        $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        $bytes = $Utf8NoBom.GetBytes(($Value | ConvertTo-Json -Depth 40) + [Environment]::NewLine)
        $stream.Write($bytes, 0, $bytes.Length)
    }
    catch [IO.IOException] {
        Stop-Demo "one-shot marker already exists; do not rerun Live: $Path"
    }
    finally {
        if ($null -ne $stream) { $stream.Dispose() }
    }
}

function Read-JsonFile([string]$Path, [string]$Label) {
    Assert-File $Path $Label
    try { return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json }
    catch { Stop-Demo "$Label is not valid JSON: $Path" }
}

function Invoke-Rpc([string]$Method, [object[]]$Params = @()) {
    Assert-RpcPresent
    $request = @{
        jsonrpc = '2.0'
        id = 1
        method = $Method
        params = $Params
    } | ConvertTo-Json -Depth 30 -Compress
    try {
        $response = Invoke-RestMethod -Method Post -Uri $env:SOLFRONTIER_RPC_URL `
            -ContentType 'application/json' -Body $request -TimeoutSec 20
    }
    catch { Stop-Demo "RPC $Method failed: $($_.Exception.Message)" }
    $errorProperty = $response.PSObject.Properties['error']
    if ($null -ne $errorProperty -and $null -ne $errorProperty.Value) {
        Stop-Demo "RPC $Method returned error code $($errorProperty.Value.code): $($errorProperty.Value.message)"
    }
    $resultProperty = $response.PSObject.Properties['result']
    if ($null -eq $resultProperty) { Stop-Demo "RPC $Method returned neither result nor error" }
    return $resultProperty.Value
}

function Invoke-CliJson([string[]]$Arguments, [int[]]$AcceptedExitCodes = @(0), [switch]$NoServerConfig, [string]$Database = $Db) {
    Assert-File $CliEntry 'CLI entry point'
    $stderrPath = [IO.Path]::GetTempFileName()
    try {
        $allArgs = @($CliEntry) + $Arguments + @('--json', '--color', 'never')
        if (-not $NoServerConfig) {
            $allArgs += @('--bin', $Binary, '--db', $Database, '--config', $DemoConfig, '--timeout-ms', '20000')
        }
        $previousPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            $stdoutLines = @(& node.exe @allArgs 2> $stderrPath)
            $code = $LASTEXITCODE
        }
        finally { $ErrorActionPreference = $previousPreference }
        if (Test-Path -LiteralPath $stderrPath) {
            Get-Content -LiteralPath $stderrPath | ForEach-Object { Write-Host $_ -ForegroundColor DarkGray }
        }
        if ($AcceptedExitCodes -notcontains $code) {
            Stop-Demo "CLI exited ${code}: node $($Arguments -join ' ')"
        }
        $raw = [string]::Join([Environment]::NewLine, $stdoutLines).Trim()
        if ([string]::IsNullOrWhiteSpace($raw)) {
            Stop-Demo "CLI returned no JSON: node $($Arguments -join ' ')"
        }
        try { $body = $raw | ConvertFrom-Json }
        catch { Stop-Demo "CLI stdout was not one JSON document: $raw" }
        return [pscustomobject]@{ Code = $code; Body = $body; Raw = $raw }
    }
    finally { Remove-Item -LiteralPath $stderrPath -Force -ErrorAction SilentlyContinue }
}

function Get-JsonObjectsFromText([string]$Text) {
    $found = @()
    $start = -1
    $depth = 0
    $inString = $false
    $escaped = $false
    for ($i = 0; $i -lt $Text.Length; $i++) {
        $ch = $Text[$i]
        if ($start -lt 0) {
            if ($ch -eq '{') { $start = $i; $depth = 1; $inString = $false; $escaped = $false }
            continue
        }
        if ($inString) {
            if ($escaped) { $escaped = $false; continue }
            if ($ch -eq '\') { $escaped = $true; continue }
            if ($ch -eq '"') { $inString = $false }
            continue
        }
        if ($ch -eq '"') { $inString = $true; continue }
        if ($ch -eq '{') { $depth++; continue }
        if ($ch -eq '}') {
            $depth--
            if ($depth -eq 0) {
                $candidate = $Text.Substring($start, $i - $start + 1)
                try { $found += ,($candidate | ConvertFrom-Json) } catch { }
                $start = -1
            }
        }
    }
    return @($found)
}

function Invoke-WatchOnce([switch]$Execute, [switch]$QuietDisplay, [string]$Database = $Db) {
    Assert-File $Binary 'release server binary'
    $stderrPath = [IO.Path]::GetTempFileName()
    $stdoutPath = [IO.Path]::GetTempFileName()
    try {
        $args = @('--db', $Database, 'watch', '--once')
        if ($Execute) { $args += '--execute' }
        $previousPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            & $Binary @args 1> $stdoutPath 2> $stderrPath
            $code = $LASTEXITCODE
        }
        finally { $ErrorActionPreference = $previousPreference }
        $stderrText = if (Test-Path -LiteralPath $stderrPath) { Get-Content -LiteralPath $stderrPath -Raw } else { '' }
        $stdoutText = if (Test-Path -LiteralPath $stdoutPath) { Get-Content -LiteralPath $stdoutPath -Raw } else { '' }
        $text = ($stderrText + [Environment]::NewLine + $stdoutText).Trim()
        if (-not $QuietDisplay) { Write-Host $text -ForegroundColor DarkGray }
        return [pscustomobject]@{
            Code = $code
            Text = $text
            Objects = @(Get-JsonObjectsFromText $text)
        }
    }
    finally {
        Remove-Item -LiteralPath $stderrPath, $stdoutPath -Force -ErrorAction SilentlyContinue
    }
}

function Get-CycleReport($WatchResult) {
    $cycles = @($WatchResult.Objects | Where-Object {
        $_.PSObject.Properties.Name -contains 'rows' -and
        $_.PSObject.Properties.Name -contains 'scan_errors'
    })
    if ($cycles.Count -ne 1) { Stop-Demo "expected one parseable watch cycle report, got $($cycles.Count)" }
    return $cycles[0]
}

function Assert-EmptyCycle($WatchResult) {
    if ($WatchResult.Code -ne 0) { Stop-Demo "watch exited $($WatchResult.Code)" }
    if ($WatchResult.Text -match 'REPORT SERIALIZATION FAILED|EXECUTE CYCLE ABORTED') {
        Stop-Demo 'watch reported a serialization or cycle failure'
    }
    $cycle = Get-CycleReport $WatchResult
    Assert-True (@($cycle.scan_errors).Count -eq 0) 'watch scan_errors is not empty'
    Assert-True (@($cycle.rows).Count -eq 0) 'dedicated demo DB has actionable or orphan rows'
    return $cycle
}

function Assert-RepoPinned([string]$Root, [string]$ExpectedHead, [string]$Label) {
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $head = (& git.exe -c "safe.directory=$($Root.Replace('\','/'))" -C $Root rev-parse HEAD 2>$null).Trim()
        $headCode = $LASTEXITCODE
    }
    finally { $ErrorActionPreference = $previousPreference }
    if ($headCode -ne 0) { Stop-Demo "cannot read $Label git HEAD" }
    Assert-Equal $head $ExpectedHead "$Label HEAD"
    try {
        $ErrorActionPreference = 'Continue'
        & git.exe -c "safe.directory=$($Root.Replace('\','/'))" -C $Root diff --quiet
        $diffCode = $LASTEXITCODE
        & git.exe -c "safe.directory=$($Root.Replace('\','/'))" -C $Root diff --cached --quiet
        $cachedCode = $LASTEXITCODE
    }
    finally { $ErrorActionPreference = $previousPreference }
    if ($diffCode -ne 0) { Stop-Demo "$Label has tracked working-tree changes" }
    if ($cachedCode -ne 0) { Stop-Demo "$Label has staged changes" }
    return $head
}

function Assert-CliRuntimePinned([string]$Root) {
    $safe = "safe.directory=$($Root.Replace('\','/'))"
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $head = (& git.exe -c $safe -C $Root rev-parse HEAD 2>$null)
        $headCode = $LASTEXITCODE
        $srcTree = (& git.exe -c $safe -C $Root rev-parse 'HEAD:src' 2>$null)
        $srcCode = $LASTEXITCODE
        $packageBlob = (& git.exe -c $safe -C $Root rev-parse 'HEAD:package.json' 2>$null)
        $packageCode = $LASTEXITCODE
    }
    finally { $ErrorActionPreference = $previousPreference }
    if ($headCode -ne 0) { Stop-Demo 'cannot read CLI repo git HEAD' }
    if ($srcCode -ne 0) { Stop-Demo 'cannot read CLI repo HEAD:src tree object' }
    if ($packageCode -ne 0) { Stop-Demo 'cannot read CLI repo HEAD:package.json blob object' }

    # The gate: the executed runtime, not the commit that carries it.
    Assert-Equal ([string]$srcTree).Trim() $ExpectedCliSrcTree 'CLI repo HEAD:src tree'
    Assert-Equal ([string]$packageBlob).Trim() $ExpectedCliPackageBlob 'CLI repo HEAD:package.json blob'

    # A committed tree proves nothing if the checkout is dirty, so the whole
    # repository must still be clean in both the working tree and the index.
    try {
        $ErrorActionPreference = 'Continue'
        & git.exe -c $safe -C $Root diff --quiet
        $diffCode = $LASTEXITCODE
        & git.exe -c $safe -C $Root diff --cached --quiet
        $cachedCode = $LASTEXITCODE
        $untracked = @(& git.exe -c $safe -C $Root ls-files --others --exclude-standard -- src package.json 2>$null)
        $untrackedCode = $LASTEXITCODE
    }
    finally { $ErrorActionPreference = $previousPreference }
    if ($diffCode -ne 0) { Stop-Demo 'CLI repo has tracked working-tree changes' }
    if ($cachedCode -ne 0) { Stop-Demo 'CLI repo has staged changes' }
    if ($untrackedCode -ne 0) { Stop-Demo 'cannot enumerate CLI repo untracked runtime files' }

    # Untracked files under src/ are invisible to the tree pin but are loaded
    # at runtime by any import that resolves to them.
    $untracked = @($untracked | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($untracked.Count -gt 0) {
        Stop-Demo "CLI repo has untracked runtime file(s) the tree pin cannot cover: $($untracked -join ', ')"
    }

    return [pscustomobject]@{
        head = ([string]$head).Trim()
        srcTree = ([string]$srcTree).Trim()
        packageBlob = ([string]$packageBlob).Trim()
    }
}

function Assert-TokenAccount([string]$Address, [string]$ExpectedOwner, [long]$MinimumRaw, [string]$Label) {
    $result = Invoke-Rpc 'getAccountInfo' @($Address, @{ encoding = 'jsonParsed'; commitment = 'confirmed' })
    if ($null -eq $result.value) { Stop-Demo "$Label does not exist: $Address" }
    $info = $result.value.data.parsed.info
    Assert-Equal $info.mint $UsdcMint "$Label mint"
    Assert-Equal $info.owner $ExpectedOwner "$Label owner"
    Assert-Equal $info.state 'initialized' "$Label state"
    Assert-Equal $info.tokenAmount.decimals 6 "$Label decimals"
    $raw = [long]$info.tokenAmount.amount
    Assert-True ($raw -ge $MinimumRaw) "$Label balance $raw is below required $MinimumRaw raw USDC"
    return $raw
}

function Get-SolBalance([string]$Wallet) {
    $result = Invoke-Rpc 'getBalance' @($Wallet, @{ commitment = 'confirmed' })
    return [long]$result.value
}

function Get-SignatureRows([string]$Address, [int]$Limit = 1000, [string]$Before = '') {
    $options = @{ limit = $Limit; commitment = 'confirmed' }
    if (-not [string]::IsNullOrWhiteSpace($Before)) { $options.before = $Before }
    return @(Invoke-Rpc 'getSignaturesForAddress' @($Address, $options))
}

function Get-Transaction([string]$Signature, [string]$Commitment = 'confirmed') {
    return Invoke-Rpc 'getTransaction' @($Signature, @{
        encoding = 'jsonParsed'
        commitment = $Commitment
        maxSupportedTransactionVersion = 0
    })
}

# Balance delta for one owner+mint pair, from the parsed pre/post rows.
function Get-OwnerTokenDelta($Transaction, [string]$Owner, [string]$Mint) {
    $preRow = @($Transaction.meta.preTokenBalances | Where-Object {
        [string]$_.owner -eq $Owner -and [string]$_.mint -eq $Mint
    }) | Select-Object -First 1
    $postRow = @($Transaction.meta.postTokenBalances | Where-Object {
        [string]$_.owner -eq $Owner -and [string]$_.mint -eq $Mint
    }) | Select-Object -First 1
    if ($null -eq $postRow -and $null -eq $preRow) { return $null }
    $pre = if ($null -eq $preRow) { [long]0 } else { [long]$preRow.uiTokenAmount.amount }
    $post = if ($null -eq $postRow) { [long]0 } else { [long]$postRow.uiTokenAmount.amount }
    return [pscustomobject]@{ Pre = $pre; Post = $post; Delta = $post - $pre }
}

# Every outer (top-level) Memo instruction's exact text, taken from the
# instruction data rather than from logs or the RPC's memo summary field.
function Get-OuterMemoTexts($Transaction) {
    $texts = @()
    foreach ($ix in @($Transaction.transaction.message.instructions)) {
        if ([string]$ix.programId -ne $MemoProgramId) { continue }
        # jsonParsed renders the Memo program's payload into .parsed as a
        # plain string; fall back to nothing rather than guessing.
        if ($null -ne $ix.parsed -and $ix.parsed -is [string]) { $texts += ,([string]$ix.parsed) }
    }
    return @($texts)
}

# Authoritative client-side proof that one transaction is THIS run's funding.
#
# Deliberately reads the instructions, not the RPC's memo summary: that field
# is formatted as "[byte_len] memo" and joins multiple memos with "; ", so
# neither equality nor EndsWith over it is a correctness gate. The server
# re-verifies all of this independently; this exists so the client never hands
# confirm_funding a transaction that is not exactly the one it is waiting for.
function Test-FundingTransaction($Transaction, [string]$ExpectedMemo) {
    if ($null -eq $Transaction) { return $null }
    if ($null -ne $Transaction.meta.err) { return $null }

    # 1. The registered payer must have signed it.
    $keys = @($Transaction.transaction.message.accountKeys)
    $userSigner = @($keys | Where-Object {
        [string]$_.pubkey -eq $UserWallet -and [bool]$_.signer
    }).Count -gt 0
    if (-not $userSigner) { return $null }

    # 2. Exactly one outer Memo instruction, exactly this run's text.
    $memos = @(Get-OuterMemoTexts $Transaction)
    if ($memos.Count -ne 1) { return $null }
    if ([string]$memos[0] -cne $ExpectedMemo) { return $null }

    # 3. Exactly one outer TransferChecked, with every field pinned.
    $transfers = @()
    foreach ($ix in @($Transaction.transaction.message.instructions)) {
        if ([string]$ix.programId -ne $TokenProgramId) { continue }
        if ([string]$ix.parsed.type -ne 'transferChecked') { continue }
        $transfers += ,$ix
    }
    if ($transfers.Count -ne 1) { return $null }
    $info = $transfers[0].parsed.info
    if ([string]$info.source -cne $UserUsdcAta) { return $null }
    if ([string]$info.destination -cne $ControlledUsdcAta) { return $null }
    if ([string]$info.mint -cne $UsdcMint) { return $null }
    if ([string]$info.authority -cne $UserWallet) { return $null }
    if ([string]$info.tokenAmount.amount -cne [string]$AmountRaw) { return $null }
    if ([int]$info.tokenAmount.decimals -ne 6) { return $null }

    # 4. Both sides of the ledger moved by exactly the pinned amount.
    $controlled = Get-OwnerTokenDelta $Transaction $ControlledWallet $UsdcMint
    $user = Get-OwnerTokenDelta $Transaction $UserWallet $UsdcMint
    if ($null -eq $controlled -or $null -eq $user) { return $null }
    if ($controlled.Delta -ne [long]$AmountRaw) { return $null }
    if ($user.Delta -ne -[long]$AmountRaw) { return $null }

    return [pscustomobject]@{
        Slot = [long]$Transaction.slot
        Pre = $controlled.Pre
        Post = $controlled.Post
        Delta = $controlled.Delta
        UserDelta = $user.Delta
        Memo = [string]$memos[0]
    }
}

function Test-ExecutionTransaction($Transaction) {
    if ($null -eq $Transaction -or $null -ne $Transaction.meta.err) { return $null }
    $keys = @($Transaction.transaction.message.accountKeys)
    $controlledSigner = @($keys | Where-Object {
        [string]$_.pubkey -eq $ControlledWallet -and [bool]$_.signer
    }).Count -gt 0
    if (-not $controlledSigner) { return $null }
    $hasSolendProgram = @($keys | Where-Object { [string]$_.pubkey -eq $SolendProgram }).Count -gt 0
    if (-not $hasSolendProgram) { return $null }
    $controlledIndex = -1
    for ($i = 0; $i -lt $keys.Count; $i++) {
        if ([string]$keys[$i].pubkey -eq $ControlledUsdcAta) { $controlledIndex = $i; break }
    }
    if ($controlledIndex -lt 0) { return $null }
    $preRow = @($Transaction.meta.preTokenBalances | Where-Object {
        [int]$_.accountIndex -eq $controlledIndex -and [string]$_.mint -eq $UsdcMint
    }) | Select-Object -First 1
    $postRow = @($Transaction.meta.postTokenBalances | Where-Object {
        [int]$_.accountIndex -eq $controlledIndex -and [string]$_.mint -eq $UsdcMint
    }) | Select-Object -First 1
    if ($null -eq $preRow -or $null -eq $postRow) { return $null }
    $pre = [long]$preRow.uiTokenAmount.amount
    $post = [long]$postRow.uiTokenAmount.amount
    if (($post - $pre) -ne -[long]$AmountRaw) { return $null }
    return [pscustomobject]@{
        Slot = [long]$Transaction.slot
        ControlledWalletSigner = $true
        SolendProgramPresent = $true
        ControlledAtaPre = $pre
        ControlledAtaPost = $post
        ControlledAtaDelta = $post - $pre
    }
}

function Find-MemoPrefixOnChain([string]$Prefix) {
    $before = ''
    $matches = @()
    do {
        $rows = @(Get-SignatureRows $ControlledUsdcAta 1000 $before)
        foreach ($row in $rows) {
            $tx = Get-Transaction ([string]$row.signature) 'finalized'
            if ($null -eq $tx) { continue }
            $logs = [string]::Join([Environment]::NewLine, @($tx.meta.logMessages))
            if ($logs.Contains($Prefix)) { $matches += [string]$row.signature }
        }
        if ($rows.Count -gt 0) { $before = [string]$rows[$rows.Count - 1].signature }
    } while ($rows.Count -eq 1000)
    return @($matches)
}

function Find-ExactFundingSignatures([string]$Memo) {
    $before = ''
    $matches = @()
    do {
        $rows = @(Get-SignatureRows $ControlledUsdcAta 1000 $before)
        foreach ($row in $rows) {
            if ($null -ne $row.err) { continue }
            $tx = Get-Transaction ([string]$row.signature) 'finalized'
            if ($null -ne (Test-FundingTransaction $tx $Memo)) { $matches += [string]$row.signature }
        }
        if ($rows.Count -gt 0) { $before = [string]$rows[$rows.Count - 1].signature }
    } while ($rows.Count -eq 1000)
    return @($matches)
}

# Everything a strict doctor gate requires EXCEPT reserve freshness. Any
# failure here is terminal: these conditions do not improve by waiting.
function Get-DoctorSnapshotStrict {
    $doctor = Invoke-CliJson @('doctor', '--threshold-bps', [string]$ThresholdBps)
    Assert-Equal $doctor.Body.verdict 'GO' 'doctor verdict'
    Assert-True ($null -ne $doctor.Body.reserve) 'doctor returned no reserve snapshot'
    Assert-True ([int]$doctor.Body.reserve.supplyAprBps -gt $ThresholdBps) 'supply APY does not clear the threshold'
    $condition = @($doctor.Body.checks | Where-Object { $_.name -eq 'condition vs threshold' })
    Assert-True ($condition.Count -eq 1 -and $condition[0].status -eq 'pass') 'doctor threshold check is not PASS'
    $rpcCheck = @($doctor.Body.checks | Where-Object { $_.name -eq 'SOLFRONTIER_RPC_URL' })
    Assert-True ($rpcCheck.Count -eq 1 -and $rpcCheck[0].status -eq 'pass') 'doctor RPC check is not PASS'
    $keyCheck = @($doctor.Body.checks | Where-Object { $_.name -eq 'controlled wallet keypair' })
    Assert-True ($keyCheck.Count -eq 1 -and $keyCheck[0].status -eq 'pass') 'doctor says the client shell contains the controlled keypair'
    return $doctor.Body
}

# Pure decision over one reserve snapshot: 'pass', 'wait' or 'fail'.
#
# Freshness is NOT "age <= 16". The executor requires all three of:
#     staleFlag == false  AND  ageSlots >= 0  AND  ageSlots <= maxStalenessSlots
# An account can report age 0 while its explicit stale bit is still set, which
# reads as fresh if you only look at age and would pick a moment the executor
# still refuses. Only the two genuinely transient shapes may be waited out;
# anything else fails closed rather than spinning until timeout.
#
# Kept free of I/O so Check can exercise it offline against synthetic cases.
function Get-FreshnessDecision($Reserve) {
    if ($null -eq $Reserve) { return 'fail' }
    if ($null -eq $Reserve.staleFlag -or $null -eq $Reserve.ageSlots) { return 'fail' }

    # Verified, not defined here: the threshold belongs to the reviewed CLI.
    $max = [int]$Reserve.maxStalenessSlots
    if ($max -ne $ExpectedMaxReserveStalenessSlots) { return 'fail' }

    if ([int]$Reserve.supplyAprBps -le $ThresholdBps) { return 'fail' }

    $age = [int]$Reserve.ageSlots
    $stale = [bool]$Reserve.staleFlag
    if ($age -lt 0) { return 'fail' }              # future last_update: impossible
    if (-not $stale -and $age -le $max) { return 'pass' }
    if ($stale) { return 'wait' }                  # explicit stale bit, refresh pending
    if ($age -gt $max) { return 'wait' }           # merely too old, a refresh fixes it
    return 'fail'
}

# Bounded read-only wait for a genuinely fresh reserve.
#
# Re-runs the full pinned doctor every poll so a run cannot slip through on a
# stale reading: the verdict, RPC, keyless shell, APY and condition checks are
# all re-verified each time. Returns the exact snapshot that passed -- never a
# remembered earlier sighting of freshness, which would be a lie about the
# state at the moment the caller proceeds.
function Assert-DoctorFreshnessBounded([int]$TimeoutSeconds = 120, [int]$PollSeconds = 2) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $attempts = 0
    $startedAt = Get-Date
    while ($true) {
        $attempts++
        $snapshot = Get-DoctorSnapshotStrict          # hard failures stop here
        $reserve = $snapshot.reserve
        $decision = Get-FreshnessDecision $reserve

        if ($decision -eq 'pass') {
            $waited = [int]((Get-Date) - $startedAt).TotalSeconds
            Write-Host "reserve fresh after $attempts doctor poll(s), ${waited}s (age $([int]$reserve.ageSlots) slots, stale=$([bool]$reserve.staleFlag))"
            return [pscustomobject]@{ Body = $snapshot; Attempts = $attempts; WaitedSeconds = $waited }
        }
        if ($decision -eq 'fail') {
            Stop-Demo "reserve snapshot is not waitable (ageSlots=$($reserve.ageSlots), staleFlag=$($reserve.staleFlag), maxStalenessSlots=$($reserve.maxStalenessSlots), supplyAprBps=$($reserve.supplyAprBps))"
        }
        if ((Get-Date) -ge $deadline) {
            Stop-Demo "reserve did not become fresh within ${TimeoutSeconds}s ($attempts polls; last ageSlots=$($reserve.ageSlots), staleFlag=$($reserve.staleFlag))"
        }
        Write-Host "waiting for a fresh reserve: age $([int]$reserve.ageSlots) slots, stale=$([bool]$reserve.staleFlag) (poll $attempts)"
        Start-Sleep -Seconds $PollSeconds
    }
}

function Assert-IntentUnused {
    $status = Invoke-CliJson @('status', '--ref', $ExpectedIntentId) @(1)
    Assert-Equal $status.Body.status 'not_found' 'expected intent status'
    Assert-Equal $status.Body.resolved_intent_id $ExpectedIntentId 'resolved intent id'
}

function Get-ExpectedHardenedPageText {
    $sourceText = [IO.File]::ReadAllText($SigningPageSource, [Text.Encoding]::UTF8)
    $baseConnectSrc = 'connect-src https://solana-rpc.publicnode.com;'
    $demoConnectSrc = 'connect-src https://solana-rpc.publicnode.com http://127.0.0.1:8081;'
    Assert-True (([regex]::Matches($sourceText, [regex]::Escape($baseConnectSrc))).Count -eq 1) 'base page CSP connect-src is not the pinned value'
    Assert-True (([regex]::Matches($sourceText, '</body>')).Count -eq 1) 'base page does not have exactly one closing body tag'
    $injection = '  <script src="signing-guard.js"></script>' + [Environment]::NewLine + '</body>'
    $hardenedText = $sourceText.Replace($baseConnectSrc, $demoConnectSrc).Replace('</body>', $injection)
    Assert-True ($hardenedText.Contains($demoConnectSrc)) 'hardened page CSP does not allow the exact loopback heartbeat origin'
    return $hardenedText
}

function Assert-SigningPage {
    Assert-File $SigningPageSource 'base signing page source'
    Assert-File $SigningGuardSource 'demo signing guard'
    Assert-File $HardenedPagePath 'hardened signing page (run Serve first)'
    Assert-File $HardenedGuardPath 'served signing guard (run Serve first)'
    $sourceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $SigningPageSource).Hash
    $guardSourceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $SigningGuardSource).Hash
    $guardFileHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $HardenedGuardPath).Hash
    $hardenedHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $HardenedPagePath).Hash
    $expectedHardenedHash = Get-Sha256Text (Get-ExpectedHardenedPageText)
    Assert-Equal $sourceHash $ExpectedSigningPageSha256 'base signing page SHA256'
    Assert-Equal $guardSourceHash $ExpectedSigningGuardSha256 'demo signing guard SHA256'
    Assert-Equal $guardFileHash $ExpectedSigningGuardSha256 'served guard file SHA256'
    Assert-Equal $hardenedHash $expectedHardenedHash 'hardened page deterministic SHA256'
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $SigningPageBase -TimeoutSec 5
    }
    catch { Stop-Demo "hardened loopback signing page is not reachable: $($_.Exception.Message)" }
    Assert-Equal $response.StatusCode 200 'signing page HTTP status'
    $servedStream = $response.RawContentStream
    if ($servedStream.CanSeek) { $servedStream.Position = 0 }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $servedHash = ([BitConverter]::ToString($sha.ComputeHash($servedStream))).Replace('-', '') }
    finally { $sha.Dispose() }
    Assert-Equal $servedHash $hardenedHash 'served hardened signing page SHA256'
    try { $guardResponse = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8081/signing-guard.js' -TimeoutSec 5 }
    catch { Stop-Demo "served signing guard is not reachable: $($_.Exception.Message)" }
    $guardStream = $guardResponse.RawContentStream
    if ($guardStream.CanSeek) { $guardStream.Position = 0 }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $servedGuardHash = ([BitConverter]::ToString($sha.ComputeHash($guardStream))).Replace('-', '') }
    finally { $sha.Dispose() }
    Assert-Equal $servedGuardHash $ExpectedSigningGuardSha256 'HTTP signing guard SHA256'
    try {
        $listeners = @([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() |
            Where-Object { $_.Port -eq 8081 })
    }
    catch { Stop-Demo 'cannot verify the signing server listener binding on TCP 8081' }
    Assert-True ($listeners.Count -gt 0) 'no TCP 8081 listener was found'
    $nonLoopback = @($listeners | Where-Object { [string]$_.Address -notin @('127.0.0.1', '::1') })
    Assert-True ($nonLoopback.Count -eq 0) 'the signing page listener is exposed beyond loopback'
    return $hardenedHash
}

function Invoke-Serve {
    Write-Step 'Prepare and serve the hardened loopback signing page'
    Assert-File $SigningPageSource 'base signing page source'
    Assert-File $SigningGuardSource 'demo signing guard'
    Assert-Equal (Get-FileHash -Algorithm SHA256 -LiteralPath $SigningPageSource).Hash $ExpectedSigningPageSha256 'base signing page SHA256'
    Assert-Equal (Get-FileHash -Algorithm SHA256 -LiteralPath $SigningGuardSource).Hash $ExpectedSigningGuardSha256 'demo signing guard SHA256'
    $python = 'C:\Users\jeffr\AppData\Local\Programs\Python\Python312\python.exe'
    Assert-File $python 'Python 3.12 executable'

    $existingListeners = @([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() |
        Where-Object { $_.Port -eq 8081 })
    if ($existingListeners.Count -gt 0) {
        [void](Assert-SigningPage)
        Write-Host 'HARDENED SIGNING PAGE ALREADY READY on 127.0.0.1:8081' -ForegroundColor Green
        return
    }

    if (-not (Test-Path -LiteralPath $HardenedPageDir)) {
        [void](New-Item -ItemType Directory -Path $HardenedPageDir -Force)
    }
    $hardenedText = Get-ExpectedHardenedPageText
    [IO.File]::WriteAllText($HardenedPagePath, $hardenedText, $Utf8NoBom)
    Copy-Item -LiteralPath $SigningGuardSource -Destination $HardenedGuardPath -Force
    $vendorSource = Join-Path (Split-Path -Parent $SigningPageSource) 'vendor'
    Assert-True (Test-Path -LiteralPath $vendorSource -PathType Container) 'signing page vendor directory is missing'
    Copy-Item -LiteralPath $vendorSource -Destination $HardenedPageDir -Recurse -Force

    $stdoutLog = Join-Path $RunDir 'signing-page.stdout.log'
    $stderrLog = Join-Path $RunDir 'signing-page.stderr.log'
    $process = Start-Process -FilePath $python `
        -ArgumentList '-m', 'http.server', '8081', '--bind', '127.0.0.1', '--directory', $HardenedPageDir `
        -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog
    [IO.File]::WriteAllText($SigningPagePidPath, [string]$process.Id + [Environment]::NewLine, $Utf8NoBom)
    Start-Sleep -Seconds 2
    [void](Assert-SigningPage)
    Write-Host 'HARDENED SIGNING PAGE READY on 127.0.0.1:8081' -ForegroundColor Green
    Write-Host "PID: $($process.Id)"
}

function Write-ExecutorHeartbeat($Heartbeat) {
    Write-JsonFile $HeartbeatPath $Heartbeat
    if (Test-Path -LiteralPath $HardenedPageDir -PathType Container) {
        try { Write-JsonFile $BrowserHeartbeatPath $Heartbeat }
        catch { Write-Host "browser heartbeat mirror write failed; signing guard will remain blocked until the next cycle" -ForegroundColor Yellow }
    }
}

function Assert-RpcMainnetAndClock {
    $genesis = Invoke-Rpc 'getGenesisHash'
    Assert-Equal $genesis $MainnetGenesisHash 'RPC genesis hash'
    $slot = Invoke-Rpc 'getSlot' @(@{ commitment = 'confirmed' })
    $blockTime = Invoke-Rpc 'getBlockTime' @([long]$slot)
    if ($null -eq $blockTime) { Stop-Demo 'RPC returned no block time for the confirmed slot' }
    $localUnix = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    $skew = [Math]::Abs([long]$localUnix - [long]$blockTime)
    Assert-True ($skew -le 45) "host/RPC clock skew is $skew seconds"
    return [pscustomobject]@{ GenesisHash = $genesis; ConfirmedSlot = [long]$slot; ClockSkewSeconds = $skew }
}

function Assert-Heartbeat([int]$MinimumTtlSeconds = 300) {
    $heartbeat = Read-JsonFile $HeartbeatPath 'executor heartbeat'
    Assert-Equal $heartbeat.db ([IO.Path]::GetFullPath($Db)) 'heartbeat DB'
    Assert-Equal $heartbeat.intentId $ExpectedIntentId 'heartbeat intent'
    Assert-Equal $heartbeat.amountRaw $AmountRaw 'heartbeat amount'
    Assert-Equal $heartbeat.rpcFingerprint (Get-RpcFingerprint) 'executor/client RPC fingerprint'
    Assert-Equal $heartbeat.state 'idle-no-candidate' 'executor readiness state'
    try { $process = Get-Process -Id ([int]$heartbeat.pid) -ErrorAction Stop }
    catch { Stop-Demo 'executor heartbeat PID is not alive' }
    $age = ([DateTimeOffset]::UtcNow - [DateTimeOffset]::Parse([string]$heartbeat.updatedAtUtc)).TotalSeconds
    Assert-True ($age -ge -5 -and $age -le 20) "executor heartbeat is stale ($([Math]::Round($age, 1)) seconds)"
    $ttlLeft = ([DateTimeOffset]::Parse([string]$heartbeat.expiresAtUtc) - [DateTimeOffset]::UtcNow).TotalSeconds
    Assert-True ($ttlLeft -ge $MinimumTtlSeconds) "executor TTL has only $([Math]::Round($ttlLeft)) seconds left; required $MinimumTtlSeconds"
    return $heartbeat
}

function Update-LiveMarker([string]$Phase, $Extra = $null) {
    $current = Read-JsonFile $LiveMarkerPath 'live marker'
    $record = [ordered]@{}
    foreach ($property in $current.PSObject.Properties) { $record[$property.Name] = $property.Value }
    $record.phase = $Phase
    $record.updatedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
    if ($null -ne $Extra) {
        foreach ($property in $Extra.PSObject.Properties) { $record[$property.Name] = $property.Value }
    }
    Write-JsonFile $LiveMarkerPath $record
}

function Assert-NodeVersion {
    Assert-True ($null -ne (Get-Command node.exe -ErrorAction SilentlyContinue)) 'node.exe is not on PATH'
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $versionText = (& node.exe --version 2>$null).Trim()
        $versionCode = $LASTEXITCODE
    }
    finally { $ErrorActionPreference = $previousPreference }
    if ($versionCode -ne 0 -or $versionText -notmatch '^v(\d+)\.') { Stop-Demo "cannot parse Node version: $versionText" }
    Assert-True ([int]$Matches[1] -ge 20) "Node 20+ is required, got $versionText"
    return $versionText
}

function Invoke-Preflight {
    Write-Step 'Pinned paths and source state'
    Assert-KeylessShell
    Assert-RpcPresent
    Assert-Equal $CliRoot 'C:\Users\jeffr\solfrontiermcpcli' 'CLI root'
    Assert-Equal ([IO.Path]::GetFullPath($Db)) 'C:\Users\jeffr\solfrontiermcpcli\scratch\demo-20260802-run.db' 'demo DB'
    Assert-File $CliEntry 'CLI entry point'
    Assert-File $Binary 'release server binary'
    Assert-File $Db 'dedicated demo DB'
    Assert-File $DemoConfig 'pinned demo config'
    Assert-File $SigningGuardSource 'demo signing guard'
    foreach ($artifact in @($LiveMarkerPath, $ExecutorResultPath, $FundingResultPath, $ExecutorLockPath, $HeartbeatPath, $BrowserHeartbeatPath)) {
        if (Test-Path -LiteralPath $artifact) { Stop-Demo "prior/in-progress demo artifact requires reconciliation: $artifact" }
    }
    Assert-True (-not $Db.ToLowerInvariant().Contains('acceptance')) 'acceptance DB paths are forbidden'
    $nodeVersion = Assert-NodeVersion
    $cliRuntime = Assert-CliRuntimePinned $CliRoot
    $serverHead = Assert-RepoPinned $ServerRoot $ExpectedServerHead 'server repo'
    $binaryHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $Binary).Hash
    Assert-Equal $binaryHash $ExpectedBinarySha256 'release binary SHA256'
    $configHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $DemoConfig).Hash
    $guardHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $SigningGuardSource).Hash
    Assert-Equal $configHash $ExpectedDemoConfigSha256 'demo config SHA256'
    Assert-Equal $guardHash $ExpectedSigningGuardSha256 'demo signing guard SHA256'
    $pageHash = Assert-SigningPage

    Write-Step 'RPC identity, clock and exact accounts'
    $rpc = Assert-RpcMainnetAndClock
    $userUsdc = Assert-TokenAccount $UserUsdcAta $UserWallet ([long]$AmountRaw) 'user USDC ATA'
    $controlledUsdc = Assert-TokenAccount $ControlledUsdcAta $ControlledWallet 0 'controlled USDC ATA'
    $userSol = Get-SolBalance $UserWallet
    $controlledSol = Get-SolBalance $ControlledWallet
    Assert-True ($userSol -ge 1000000) "user SOL balance is too low for a funding fee: $userSol lamports"
    Assert-True ($controlledSol -ge 20000000) "controlled SOL balance is below the 0.02 SOL demo floor: $controlledSol lamports"

    Write-Step 'Dedicated DB is empty and deterministic intent is unused'
    Assert-IntentUnused
    $cycle = Assert-EmptyCycle (Invoke-WatchOnce -QuietDisplay)

    Write-Step 'No historical on-chain memo for this deterministic intent'
    $memoPrefix = "claw:w5h:${ExpectedIntentId}:"
    $memoMatches = @(Find-MemoPrefixOnChain $memoPrefix)
    Assert-True ($memoMatches.Count -eq 0) "found prior on-chain memo(s) for this intent: $($memoMatches -join ', ')"

    # Last, because the reserve is fresh for only a few seconds at a time:
    # every slow check above must already be done, so the snapshot recorded
    # below is still true when the record is written.
    Write-Step 'Bounded wait for a strictly fresh reserve'
    $doctorWait = Assert-DoctorFreshnessBounded
    $doctor = $doctorWait.Body

    $record = [ordered]@{
        schemaVersion = 1
        passedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
        db = [IO.Path]::GetFullPath($Db)
        amountUsdc = $AmountUsdc
        amountRaw = $AmountRaw
        thresholdBps = $ThresholdBps
        intentId = $ExpectedIntentId
        userWallet = $UserWallet
        userUsdcAta = $UserUsdcAta
        controlledWallet = $ControlledWallet
        controlledUsdcAta = $ControlledUsdcAta
        rpcFingerprint = Get-RpcFingerprint
        rpc = $rpc
        balances = @{ userUsdcRaw = [string]$userUsdc; controlledUsdcRaw = [string]$controlledUsdc; userSolLamports = [string]$userSol; controlledSolLamports = [string]$controlledSol }
        source = @{ nodeVersion = $nodeVersion; cliHead = $cliRuntime.head; cliSrcTree = $cliRuntime.srcTree; cliPackageBlob = $cliRuntime.packageBlob; serverHead = $serverHead; binarySha256 = $binaryHash; signingPageSha256 = $pageHash; signingGuardSha256 = $guardHash; demoConfigSha256 = $configHash }
        reserve = $doctor.reserve
        freshnessWait = @{ polls = $doctorWait.Attempts; waitedSeconds = $doctorWait.WaitedSeconds }
        cycleSummary = $cycle.summary
    }
    Write-JsonFile $PreflightPath $record
    Write-Host "`nPRECHECK PASS" -ForegroundColor Green
    Write-Host "DB: $Db"
    Write-Host "Intent: $ExpectedIntentId"
    Write-Host "Next: start Executor mode in the separate key-bearing PowerShell window."
}

function Invoke-Executor {
    Write-Step 'Executor arming gate'
    Assert-RpcPresent
    Assert-File $Binary 'release server binary'
    Assert-File $Db 'dedicated demo DB'
    if ([string]::IsNullOrWhiteSpace($env:SOLFRONTIER_CONTROLLED_WALLET_KEYPAIR)) {
        Stop-Demo 'SOLFRONTIER_CONTROLLED_WALLET_KEYPAIR is not set in this executor shell'
    }
    Assert-File $env:SOLFRONTIER_CONTROLLED_WALLET_KEYPAIR 'controlled-wallet keypair file'
    Assert-True ($Arm.IsPresent -and $ApprovalText -ceq $ExecutorApproval) "arming requires -Arm -ApprovalText '$ExecutorApproval'"
    $preflight = Read-JsonFile $PreflightPath 'preflight record'
    Assert-Equal $preflight.db ([IO.Path]::GetFullPath($Db)) 'preflight DB'
    Assert-Equal $preflight.rpcFingerprint (Get-RpcFingerprint) 'preflight/executor RPC fingerprint'
    $preflightAge = ([DateTimeOffset]::UtcNow - [DateTimeOffset]::Parse([string]$preflight.passedAtUtc)).TotalMinutes
    Assert-True ($preflightAge -le 15) "preflight is $([Math]::Round($preflightAge, 1)) minutes old; rerun Preflight"
    [void](Assert-RpcMainnetAndClock)
    if (Test-Path -LiteralPath $LiveMarkerPath) { Stop-Demo 'live marker already exists; this demo run cannot be armed again' }
    $binaryHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $Binary).Hash
    Assert-Equal $binaryHash $ExpectedBinarySha256 'executor release binary SHA256'

    if (-not (Test-Path -LiteralPath $RunDir)) { [void](New-Item -ItemType Directory -Path $RunDir -Force) }
    if (-not (Test-Path -LiteralPath $LogDir)) { [void](New-Item -ItemType Directory -Path $LogDir -Force) }
    $lockStream = $null
    $exitCode = 1
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $logPath = Join-Path $LogDir "executor-$stamp.log"
    try {
        try {
            $lockStream = [IO.File]::Open($ExecutorLockPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        }
        catch [IO.IOException] { Stop-Demo "executor lock exists; verify no old executor is alive: $ExecutorLockPath" }

        Write-Step 'Positive keypair/RPC readiness on an isolated empty DB'
        [void](Assert-EmptyCycle (Invoke-WatchOnce -QuietDisplay))
        $readinessDb = Join-Path $RunDir "executor-readiness-$stamp.db"
        foreach ($path in @($readinessDb, "$readinessDb-wal", "$readinessDb-shm")) {
            if (Test-Path -LiteralPath $path) { Stop-Demo "readiness DB artifact already exists: $path" }
        }
        [void](Invoke-CliJson @('tools', 'list') @(0) -Database $readinessDb)
        $readiness = Invoke-WatchOnce -Execute -Database $readinessDb
        [IO.File]::AppendAllText($logPath, $readiness.Text + [Environment]::NewLine, $Utf8NoBom)
        [void](Assert-EmptyCycle $readiness)

        # The readiness call above exercised the real signing path on an
        # isolated empty DB and exited 0. Reaching here therefore means the
        # pinned server already loaded the keypair and verified its format,
        # its secret/public consistency, and its exact match to the pinned
        # controlled wallet -- all before any RPC, execution DB, candidate
        # scan or CAS lease. A wrong keypair exits non-zero and neither this
        # line nor the heartbeat is ever produced. Every real execute reloads
        # and re-verifies, so swapping the file mid-run also fails closed.
        #
        # Asserted by the server, reported here: this script never reads,
        # parses or derives anything from the key file itself.
        Write-Host "KEYPAIR_PIN_VERIFIED: $ControlledWallet" -ForegroundColor Green

        $deadline = [DateTimeOffset]::UtcNow.AddMinutes($ExecutorTtlMinutes)
        $heartbeat = [ordered]@{
            schemaVersion = 1
            pid = $PID
            db = [IO.Path]::GetFullPath($Db)
            intentId = $ExpectedIntentId
            amountRaw = $AmountRaw
            rpcFingerprint = Get-RpcFingerprint
            state = 'idle-no-candidate'
            updatedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
            expiresAtUtc = $deadline.ToString('o')
        }
        Write-ExecutorHeartbeat $heartbeat
        Write-Host "EXECUTOR READY until $($deadline.ToString('o'))" -ForegroundColor Green
        Write-Host "It will execute only after a read-only scan sees exactly the pinned intent."

        while ([DateTimeOffset]::UtcNow -lt $deadline) {
            $heartbeat.state = 'idle-no-candidate'
            $heartbeat.updatedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
            Write-ExecutorHeartbeat $heartbeat

            $scan = Invoke-WatchOnce -QuietDisplay
            [IO.File]::AppendAllText($logPath, $scan.Text + [Environment]::NewLine, $Utf8NoBom)
            if ($scan.Code -ne 0 -or $scan.Text -match 'REPORT SERIALIZATION FAILED|EXECUTE CYCLE ABORTED') {
                Stop-Demo 'read-only executor scan failed; do not retry automatically'
            }
            $cycle = Get-CycleReport $scan
            Assert-True (@($cycle.scan_errors).Count -eq 0) 'executor scan_errors is not empty'
            $rows = @($cycle.rows)
            if ($rows.Count -eq 0) {
                $heartbeat.state = 'idle-no-candidate'
                $heartbeat.updatedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
                Write-ExecutorHeartbeat $heartbeat
                Write-Host '.' -NoNewline -ForegroundColor DarkGray
                Start-Sleep -Seconds $PollSeconds
                continue
            }
            if ($rows.Count -ne 1) { Stop-Demo "expected one candidate, saw $($rows.Count); executor remains stopped" }
            $row = $rows[0]
            Assert-Equal $row.intent_id $ExpectedIntentId 'candidate intent'
            Assert-True ($null -ne $row.candidate) 'candidate detail is missing'
            Assert-Equal $row.candidate.amounts.funding_amount_raw $AmountRaw 'candidate funding amount'
            $classification = [string]$row.status
            if ($classification -eq 'reserve_stale' -or $classification -eq 'condition_not_met') {
                $heartbeat.state = "waiting-$classification"
                $heartbeat.updatedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
                Write-ExecutorHeartbeat $heartbeat
                Write-Host "`nWAIT $classification (no lease)" -ForegroundColor Yellow
                Start-Sleep -Seconds $PollSeconds
                continue
            }
            if ($classification -ne 'ready') {
                Stop-Demo "candidate classification '$classification' is not auto-retryable"
            }

            Write-Step 'Pinned candidate is ready; one execute cycle only'
            $binaryHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $Binary).Hash
            Assert-Equal $binaryHash $ExpectedBinarySha256 'pre-execution release binary SHA256'
            $heartbeat.state = 'executing-one-attempt'
            $heartbeat.updatedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
            Write-ExecutorHeartbeat $heartbeat
            $execution = Invoke-WatchOnce -Execute
            [IO.File]::AppendAllText($logPath, $execution.Text + [Environment]::NewLine, $Utf8NoBom)
            if ($execution.Code -ne 0 -or $execution.Text -match 'REPORT SERIALIZATION FAILED|EXECUTE CYCLE ABORTED') {
                Stop-Demo 'execute cycle failed or became unparseable; STOP and reconcile manually'
            }
            $attempts = @($execution.Objects | Where-Object { $_.PSObject.Properties.Name -contains 'abort_remaining_cycle' })
            if ($attempts.Count -eq 0) {
                if ($execution.Text -match 'EXECUTE CANDIDATE SKIPPED BEFORE LEASE') {
                    if ($execution.Text -match "EXECUTE CANDIDATE SKIPPED BEFORE LEASE:.*intent_id=$([regex]::Escape($ExpectedIntentId))") {
                        Write-Host 'final revalidation skipped the exact candidate before lease; safely returning to wait' -ForegroundColor Yellow
                        Start-Sleep -Seconds $PollSeconds
                        continue
                    }
                    Stop-Demo 'an unpinned candidate was skipped during final revalidation; stop and inspect'
                }
                $retryCycle = Get-CycleReport $execution
                $retryRows = @($retryCycle.rows)
                Assert-True (@($retryCycle.scan_errors).Count -eq 0) 'execute re-scan has scan_errors'
                if ($retryRows.Count -eq 1 -and
                    [string]$retryRows[0].intent_id -eq $ExpectedIntentId -and
                    [string]$retryRows[0].candidate.amounts.funding_amount_raw -eq $AmountRaw -and
                    [string]$retryRows[0].status -in @('reserve_stale', 'condition_not_met')) {
                    Write-Host "execute re-scan became $($retryRows[0].status) before lease; safely returning to wait" -ForegroundColor Yellow
                    Start-Sleep -Seconds $PollSeconds
                    continue
                }
                Stop-Demo 'execute cycle produced no attempt outside the two safe pre-lease classifications'
            }
            if ($attempts.Count -ne 1) { Stop-Demo "expected exactly one execution attempt report, got $($attempts.Count); do not rerun" }
            $attempt = $attempts[0]
            Assert-Equal $attempt.intent_id $ExpectedIntentId 'execution intent'
            Assert-Equal $attempt.amount_raw $AmountRaw 'execution amount'
            $resultRecord = [ordered]@{
                recordedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
                logPath = $logPath
                report = $attempt
            }
            Write-JsonFile $ExecutorResultPath $resultRecord
            if ([string]$attempt.status -eq 'completed' -and
                [string]$attempt.funding_state -eq 'completed' -and
                [string]$attempt.watch_rule_state -eq 'completed' -and
                -not [string]::IsNullOrWhiteSpace([string]$attempt.signature) -and
                $null -ne $attempt.finalized_slot) {
                Write-Host 'EXECUTION COMPLETED' -ForegroundColor Green
                Write-Host "signature: $($attempt.signature)"
                Write-Host "slot: $($attempt.finalized_slot)"
                $exitCode = 0
                break
            }
            Stop-Demo "execution attempt status '$($attempt.status)'; do not run Executor or Live again"
        }
        if ($exitCode -ne 0) { Stop-Demo 'executor TTL elapsed without a completed attempt' }
    }
    finally {
        if (Test-Path -LiteralPath $HeartbeatPath) { Remove-Item -LiteralPath $HeartbeatPath -Force -ErrorAction SilentlyContinue }
        if (Test-Path -LiteralPath $BrowserHeartbeatPath) { Remove-Item -LiteralPath $BrowserHeartbeatPath -Force -ErrorAction SilentlyContinue }
        if ($null -ne $lockStream) { $lockStream.Dispose() }
        if (Test-Path -LiteralPath $ExecutorLockPath) { Remove-Item -LiteralPath $ExecutorLockPath -Force -ErrorAction SilentlyContinue }
        Write-Host "`nExecutor stopped. Close this key-bearing PowerShell window." -ForegroundColor Yellow
    }
    if ($exitCode -ne 0) { exit $exitCode }
}

function Assert-FinalizePayload($Body) {
    Assert-Equal $Body.status 'funding_required' 'finalize status'
    Assert-True ([bool]$Body.funding_actionable) 'finalize result is not funding_actionable'
    Assert-Equal $Body.intent_id $ExpectedIntentId 'finalize intent'
    Assert-True (-not [bool]$Body.reused_existing_intent) 'finalize reused an existing intent'
    Assert-Equal $Body.funding.amount_raw $AmountRaw 'funding amount'
    Assert-Equal $Body.funding.user_wallet $UserWallet 'funding user wallet'
    Assert-Equal $Body.funding.user_usdc_ata $UserUsdcAta 'funding user ATA'
    Assert-Equal $Body.funding.controlled_wallet $ControlledWallet 'funding controlled wallet'
    Assert-Equal $Body.funding.controlled_usdc_ata $ControlledUsdcAta 'funding controlled ATA'
    Assert-Equal $Body.funding.mint $UsdcMint 'funding mint'
    Assert-Equal $Body.funding.decimals 6 'funding decimals'
    Assert-Equal $Body.funding.memo_program_id 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr' 'funding memo program'
    Assert-True (@($Body.funding.instruction_order).Count -eq 2) 'funding instruction order length is not two'
    Assert-Equal $Body.funding.instruction_order[0] 'memo' 'instruction 0'
    Assert-Equal $Body.funding.instruction_order[1] 'transfer_checked' 'instruction 1'
    Assert-Equal $Body.expires_at_ms $Body.funding.expires_at_ms 'top-level/funding expiry'
    Assert-True ([string]$Body.rule_hash -match '^[0-9a-f]{64}$') 'finalize rule hash is invalid'
    $expectedMemo = "claw:w5h:${ExpectedIntentId}:$($Body.rule_hash)"
    Assert-Equal $Body.funding.memo $expectedMemo 'funding memo'
    Assert-True ([string]$Body.signing_page_url -clike "$FinalizeSigningPageBase#payload=*") 'server signing URL is not pinned to the reviewed loopback base'
    $encoded = ([string]$Body.signing_page_url -split '#payload=', 2)[1]
    try { $urlPayload = [Uri]::UnescapeDataString($encoded) | ConvertFrom-Json }
    catch { Stop-Demo 'signing URL payload is not valid encoded JSON' }
    Assert-Equal $urlPayload.status 'funding_required' 'URL funding status'
    Assert-True ([bool]$urlPayload.funding_actionable) 'URL is not funding_actionable'
    Assert-Equal $urlPayload.intent_id $ExpectedIntentId 'URL intent'
    Assert-Equal $urlPayload.rule_hash $Body.rule_hash 'URL rule hash'
    Assert-Equal $urlPayload.funding.amount_raw $AmountRaw 'URL amount'
    Assert-Equal $urlPayload.funding.user_wallet $UserWallet 'URL user wallet'
    Assert-Equal $urlPayload.funding.user_usdc_ata $UserUsdcAta 'URL user ATA'
    Assert-Equal $urlPayload.funding.controlled_wallet $ControlledWallet 'URL controlled wallet'
    Assert-Equal $urlPayload.funding.controlled_usdc_ata $ControlledUsdcAta 'URL controlled ATA'
    Assert-Equal $urlPayload.funding.memo $expectedMemo 'URL memo'
    Assert-Equal $urlPayload.funding.mint $UsdcMint 'URL mint'
    Assert-Equal $urlPayload.funding.decimals 6 'URL decimals'
    Assert-Equal $urlPayload.funding.memo_program_id 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr' 'URL memo program'
    Assert-Equal $urlPayload.funding.expires_at_ms $Body.expires_at_ms 'URL/body expiry'
    Assert-True (@($urlPayload.funding.instruction_order).Count -eq 2) 'URL instruction order length is not two'
    Assert-Equal $urlPayload.funding.instruction_order[0] 'memo' 'URL instruction 0'
    Assert-Equal $urlPayload.funding.instruction_order[1] 'transfer_checked' 'URL instruction 1'
    return $expectedMemo
}

function Invoke-Live {
    Write-Step 'Live funding arming gate'
    Assert-KeylessShell
    Assert-RpcPresent
    Assert-True ($Arm.IsPresent -and $ApprovalText -ceq $LiveApproval) "arming requires -Arm -ApprovalText '$LiveApproval'"
    $preflight = Read-JsonFile $PreflightPath 'preflight record'
    Assert-Equal $preflight.db ([IO.Path]::GetFullPath($Db)) 'preflight DB'
    Assert-Equal $preflight.rpcFingerprint (Get-RpcFingerprint) 'preflight/client RPC fingerprint'
    $preflightAge = ([DateTimeOffset]::UtcNow - [DateTimeOffset]::Parse([string]$preflight.passedAtUtc)).TotalMinutes
    Assert-True ($preflightAge -le 15) "preflight is $([Math]::Round($preflightAge, 1)) minutes old; rerun Preflight"
    [void](Assert-Heartbeat)
    [void](Assert-SigningPage)
    [void](Assert-RpcMainnetAndClock)
    Assert-IntentUnused
    [void](Assert-EmptyCycle (Invoke-WatchOnce -QuietDisplay))

    Write-Host "`nIRREVERSIBLE FUNDING RULES" -ForegroundColor Red
    Write-Host '1. Phantom must show exactly 0.2 USDC from the pinned user wallet.' -ForegroundColor Yellow
    Write-Host '2. Click Approve exactly once. After any success, error or timeout, NEVER click Retry.' -ForegroundColor Yellow
    Write-Host '3. If the outcome is unclear, leave this script running; it searches the exact memo and amount.' -ForegroundColor Yellow

    Write-Step 'Capture controlled-ATA baseline'
    $baselineRows = @(Get-SignatureRows $ControlledUsdcAta 1000)
    $baselineSignatures = @{}
    foreach ($row in $baselineRows) { $baselineSignatures[[string]$row.signature] = $true }
    Write-Host "baseline signatures captured: $($baselineRows.Count)"

    Write-Step 'Propose (pure)'
    $proposal = Invoke-CliJson @('propose', '--amount', $AmountUsdc, '--threshold-bps', [string]$ThresholdBps)
    Assert-Equal $proposal.Body.status 'ok' 'proposal status'
    Assert-True ([string]$proposal.Body.draft_hash -match '^[0-9a-f]{64}$') 'proposal draft hash is invalid'
    Write-JsonFile (Join-Path $RunDir 'proposal.json') $proposal.Body

    # Proposal is pure. Re-check positive executor readiness immediately before
    # the one-shot marker and finalize DB write.
    [void](Assert-Heartbeat)
    [void](Assert-CliRuntimePinned $CliRoot)
    [void](Assert-RepoPinned $ServerRoot $ExpectedServerHead 'server repo')
    Assert-Equal (Get-FileHash -Algorithm SHA256 -LiteralPath $Binary).Hash $ExpectedBinarySha256 'pre-finalize release binary SHA256'
    [void](Assert-SigningPage)
    $liveUserUsdc = Assert-TokenAccount $UserUsdcAta $UserWallet ([long]$AmountRaw) 'live user USDC ATA'
    $liveControlledUsdc = Assert-TokenAccount $ControlledUsdcAta $ControlledWallet 0 'live controlled USDC ATA'
    Assert-Equal $liveControlledUsdc $preflight.balances.controlledUsdcRaw 'controlled USDC balance since preflight'
    $liveUserSol = Get-SolBalance $UserWallet
    $liveControlledSol = Get-SolBalance $ControlledWallet
    Assert-True ($liveUserSol -ge 1000000) "live user SOL balance is too low: $liveUserSol lamports"
    Assert-True ($liveControlledSol -ge 20000000) "live controlled SOL balance is too low: $liveControlledSol lamports"

    # All slower source/page/account checks are now complete. The reserve is
    # fresh only a few seconds at a time, so wait for it here -- after
    # everything slow, and immediately before the one-shot marker -- rather
    # than earlier, where the window would have expired before finalize.
    Write-Step 'Bounded wait for a strictly fresh reserve'
    [void](Assert-DoctorFreshnessBounded)

    # Then one last fresh, idle executor heartbeat immediately before
    # consuming this run's one-shot marker and writing the live intent.
    [void](Assert-Heartbeat)

    $liveRecord = [ordered]@{
        schemaVersion = 1
        startedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
        updatedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
        phase = 'before-finalize'
        db = [IO.Path]::GetFullPath($Db)
        intentId = $ExpectedIntentId
        amountRaw = $AmountRaw
        rpcFingerprint = Get-RpcFingerprint
    }
    New-ExclusiveJsonFile $LiveMarkerPath $liveRecord

    Write-Step 'Finalize (DB write; 180-second clock starts now)'
    $finalize = Invoke-CliJson @(
        'finalize', '--amount', $AmountUsdc, '--threshold-bps', [string]$ThresholdBps,
        '--draft-id', [string]$proposal.Body.draft_id,
        '--draft-hash', [string]$proposal.Body.draft_hash,
        '--user-wallet', $UserWallet
    )
    Write-JsonFile (Join-Path $RunDir 'finalize.json') $finalize.Body
    $memo = Assert-FinalizePayload $finalize.Body
    $expiresAtMs = [long]$finalize.Body.expires_at_ms
    $remaining = [Math]::Floor(($expiresAtMs - [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) / 1000)
    Assert-True ($remaining -ge 120) "only $remaining seconds remain after finalize"
    Update-LiveMarker 'awaiting-one-funding-signature' ([pscustomobject]@{ ruleHash = $finalize.Body.rule_hash; memo = $memo; expiresAtMs = $expiresAtMs })
    [void](Assert-SigningPage)
    $encodedPayload = ([string]$finalize.Body.signing_page_url -split '#payload=', 2)[1]
    $hardenedSigningUrl = "$SigningPageBase#payload=$encodedPayload"
    [IO.File]::WriteAllText((Join-Path $RunDir 'signing-url.txt'), $hardenedSigningUrl + [Environment]::NewLine, $Utf8NoBom)

    Write-Host "`nHARDENED SIGNING URL (payload and one-shot guard verified):" -ForegroundColor Green
    Write-Host $hardenedSigningUrl
    Write-Host "`nExpected destination: $ControlledUsdcAta"
    Write-Host "Expected amount:      0.2 USDC ($AmountRaw raw)"
    Write-Host "Expected memo:        $memo"
    Write-Host 'CLICK ONCE. NEVER USE THE PAGE RETRY BUTTON.' -ForegroundColor Red
    if ($OpenSigningPage) {
        try { Start-Process $hardenedSigningUrl }
        catch { Write-Host "browser launch failed; copy the printed hardened URL manually: $($_.Exception.Message)" -ForegroundColor Yellow }
    }

    Write-Step 'Wait for one exact funding transaction'
    $fundingSignature = $null
    $fundingProof = $null
    $seenSignatures = @{}
    foreach ($signature in $baselineSignatures.Keys) { $seenSignatures[$signature] = $true }
    $warnedStopSigning = $false
    $warnedHeartbeatLost = $false
    while ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt $expiresAtMs) {
        $heartbeatTtlRequired = [int][Math]::Ceiling(($expiresAtMs - [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) / 1000) + 60
        try { [void](Assert-Heartbeat $heartbeatTtlRequired) }
        catch {
            if (-not $warnedHeartbeatLost) {
                Write-Host "`nEXECUTOR HEARTBEAT LOST. Do not approve a new Phantom prompt. Continuing exact-chain monitoring because a prior broadcast may exist." -ForegroundColor Red
                Update-LiveMarker 'executor-heartbeat-lost-monitoring-chain'
                $warnedHeartbeatLost = $true
            }
        }
        try {
            $rows = @(Get-SignatureRows $ControlledUsdcAta 100)
            $matches = @()
            foreach ($row in $rows) {
                if ($null -ne $row.err) { continue }
                $signature = [string]$row.signature
                if ($baselineSignatures.ContainsKey($signature) -or $seenSignatures.ContainsKey($signature)) { continue }
                # No memo prefilter here, deliberately. getSignaturesForAddress
                # does not return the raw memo: the RPC formats it as
                # "[byte_len] memo" and joins multiple memos with "; ". An
                # exact-equality prefilter on that field rejected the one
                # correct, on-time funding transaction of the 2026-08-02 run
                # and blacklisted it for the rest of the window, so the real
                # verifier below was never reached and 0.2 USDC was stranded.
                # EndsWith would not be a correct gate either, since a
                # transaction carrying an unrelated memo followed by ours
                # would pass it. Every non-baseline candidate now goes to
                # Test-FundingTransaction, which reads the instruction itself.
                $tx = Get-Transaction $signature 'confirmed'
                if ($null -eq $tx) { continue }
                $proof = Test-FundingTransaction $tx $memo
                if ($null -ne $proof) {
                    $matches += ,([pscustomobject]@{ Signature = $signature; Proof = $proof })
                }
                else {
                    $seenSignatures[$signature] = $true
                }
            }
        }
        catch {
            Write-Host "`ntransient RPC read while looking for the exact funding transaction; retrying: $($_.Exception.Message)" -ForegroundColor Yellow
            Start-Sleep -Seconds 2
            continue
        }
        $unique = @($matches | Group-Object Signature | ForEach-Object { $_.Group[0] })
        if ($unique.Count -gt 1) {
            Write-Host "multiple exact funding transactions found; confirming only the earliest, then manual reconciliation is required" -ForegroundColor Red
            Update-LiveMarker 'multiple-funding-transactions-confirming-earliest' ([pscustomobject]@{ signatures = @($unique.Signature) })
        }
        if ($unique.Count -ge 1) {
            $selected = @($unique | Sort-Object { [long]$_.Proof.Slot })[0]
            $fundingSignature = [string]$selected.Signature
            $fundingProof = $selected.Proof
            break
        }
        $secondsLeft = [Math]::Floor(($expiresAtMs - [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) / 1000)
        if ($secondsLeft -le 60 -and -not $warnedStopSigning) {
            Write-Host "`nT-${secondsLeft}: DO NOT START A NEW PHANTOM APPROVAL. Monitoring only." -ForegroundColor Red
            $warnedStopSigning = $true
        }
        Write-Host "`rwaiting for exact memo + amount + signer... T-$secondsLeft  " -NoNewline
        Start-Sleep -Seconds 2
    }
    Write-Host ''
    if ([string]::IsNullOrWhiteSpace($fundingSignature)) {
        Update-LiveMarker 'no-funding-signature-before-deadline'
        Stop-Demo 'no exact funding transaction appeared before the deadline; do not rerun Live without manual reconciliation'
    }
    Write-Host "Exact funding signature found: $fundingSignature" -ForegroundColor Green
    Write-Host 'Close the signing page now. Do not click its button again.' -ForegroundColor Red
    Write-JsonFile (Join-Path $RunDir 'funding-observed.json') ([ordered]@{ signature = $fundingSignature; memo = $memo; proof = $fundingProof; observedAtUtc = [DateTimeOffset]::UtcNow.ToString('o') })

    Write-Step 'Confirm the same exact signature (idempotent retries only)'
    $confirmation = $null
    while ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt ($expiresAtMs - 5000)) {
        try {
            $confirm = Invoke-CliJson @('confirm', '--intent-id', $ExpectedIntentId, '--tx-signature', $fundingSignature) @(0, 1)
        }
        catch {
            Write-Host "confirm transport/output failure; retrying the SAME signature only: $($_.Exception.Message)" -ForegroundColor Yellow
            Start-Sleep -Seconds 2
            continue
        }
        $status = [string]$confirm.Body.status
        if ($status -eq 'budget_reserved') {
            Assert-Equal $confirm.Body.intent_id $ExpectedIntentId 'confirmed intent'
            Assert-Equal $confirm.Body.tx_signature $fundingSignature 'confirmed signature'
            Assert-Equal $confirm.Body.amount_raw $AmountRaw 'confirmed amount'
            Assert-True (-not [bool]$confirm.Body.arrived_after_funding_deadline) 'funding arrived after the deadline'
            Assert-True (-not [bool]$confirm.Body.watch_rule.expired_at_funding_slot) 'watch rule had expired at the funding slot'
            $confirmation = $confirm.Body
            break
        }
        $retryable = $status -in @('pending_confirmation', 'rpc_error', 'funding_submitted') -and [bool]$confirm.Body.retryable
        if (-not $retryable) {
            Update-LiveMarker 'confirm-nonretryable-manual-reconciliation' ([pscustomobject]@{ confirmStatus = $status; fundingSignature = $fundingSignature })
            Stop-Demo "confirm returned non-retryable status '$status'; never use a different signature or rerun Live"
        }
        Write-Host "confirm status $status; retrying the SAME signature only" -ForegroundColor Yellow
        Start-Sleep -Seconds 2
    }
    if ($null -eq $confirmation) {
        Update-LiveMarker 'confirm-timeout-manual-reconciliation' ([pscustomobject]@{ fundingSignature = $fundingSignature })
        Stop-Demo 'confirmation did not reach budget_reserved; reconcile the same signature, never re-fund'
    }
    Write-JsonFile $FundingResultPath ([ordered]@{ recordedAtUtc = [DateTimeOffset]::UtcNow.ToString('o'); memo = $memo; proof = $fundingProof; confirmation = $confirmation })
    Update-LiveMarker 'budget-reserved-executor-active' ([pscustomobject]@{ fundingSignature = $fundingSignature })
    Write-Host "`nBUDGET RESERVED. The separate executor owns the next transition." -ForegroundColor Green
    Write-Host 'Do not rerun Live. Run Verify in this keyless window.'
}

function Wait-FinalizedTransaction([string]$Signature, [int]$TimeoutSeconds) {
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        try {
            $statuses = Invoke-Rpc 'getSignatureStatuses' @(@($Signature), @{ searchTransactionHistory = $true })
        }
        catch {
            Write-Host "finality RPC read failed; retrying: $($_.Exception.Message)" -ForegroundColor Yellow
            Start-Sleep -Seconds 2
            continue
        }
        $status = @($statuses.value)[0]
        if ($null -ne $status -and $null -ne $status.err) { Stop-Demo "transaction $Signature has an on-chain error" }
        if ($null -ne $status -and [string]$status.confirmationStatus -eq 'finalized') {
            try { $tx = Get-Transaction $Signature 'finalized' }
            catch {
                Write-Host "finalized transaction read failed; retrying: $($_.Exception.Message)" -ForegroundColor Yellow
                Start-Sleep -Seconds 2
                continue
            }
            if ($null -ne $tx -and $null -eq $tx.meta.err) { return $tx }
        }
        Start-Sleep -Seconds 2
    } while ([DateTimeOffset]::UtcNow -lt $deadline)
    Stop-Demo "transaction did not become finalized within $TimeoutSeconds seconds: $Signature"
}

function Invoke-Verify {
    Write-Step 'Verify DB lifecycle and both transactions'
    Assert-KeylessShell
    Assert-RpcPresent
    $live = Read-JsonFile $LiveMarkerPath 'live marker'
    $funding = Read-JsonFile $FundingResultPath 'funding result'
    $preflight = Read-JsonFile $PreflightPath 'preflight record'
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($VerifyTimeoutSeconds)
    $statusBody = $null
    do {
        $status = Invoke-CliJson @('status', '--ref', $ExpectedIntentId)
        $statusBody = $status.Body
        if ([string]$statusBody.status -eq 'completed') { break }
        if ([string]$statusBody.status -in @('failed', 'expired', 'refunding', 'refunded', 'funding_invalid')) {
            Stop-Demo "intent reached terminal/non-success state '$($statusBody.status)'"
        }
        Write-Host "status=$($statusBody.status), watch_rule=$($statusBody.watch_rule_status); waiting..."
        Start-Sleep -Seconds 2
    } while ([DateTimeOffset]::UtcNow -lt $deadline)
    Assert-Equal $statusBody.status 'completed' 'funding lifecycle status'
    Assert-Equal $statusBody.watch_rule_status 'completed' 'watch rule status'
    Assert-True ([bool]$statusBody.is_terminal) 'completed intent is not marked terminal'
    Assert-Equal $statusBody.amount_raw $AmountRaw 'completed amount'
    Assert-Equal $statusBody.canonical_rule_hash $live.ruleHash 'completed canonical rule hash'

    $resultDeadline = [DateTimeOffset]::UtcNow.AddSeconds(15)
    while (-not (Test-Path -LiteralPath $ExecutorResultPath) -and [DateTimeOffset]::UtcNow -lt $resultDeadline) {
        Start-Sleep -Milliseconds 250
    }
    $executor = Read-JsonFile $ExecutorResultPath 'executor result'
    $report = $executor.report
    Assert-Equal $report.intent_id $ExpectedIntentId 'executor result intent'
    Assert-Equal $report.amount_raw $AmountRaw 'executor result amount'
    Assert-Equal $report.status 'completed' 'executor result status'
    Assert-Equal $report.funding_state 'completed' 'executor funding state'
    Assert-Equal $report.watch_rule_state 'completed' 'executor watch-rule state'
    Assert-True (-not [string]::IsNullOrWhiteSpace([string]$report.signature)) 'executor result has no signature'
    Assert-True ($null -ne $report.finalized_slot) 'executor result has no finalized slot'

    $fundingSig = [string]$funding.confirmation.tx_signature
    $fundingTx = Wait-FinalizedTransaction $fundingSig $VerifyTimeoutSeconds
    $fundingProof = Test-FundingTransaction $fundingTx ([string]$funding.memo)
    Assert-True ($null -ne $fundingProof) 'finalized funding transaction no longer matches exact memo/amount/signer proof'
    $executionTx = Wait-FinalizedTransaction ([string]$report.signature) $VerifyTimeoutSeconds
    Assert-Equal $executionTx.slot $report.finalized_slot 'execution finalized slot'
    $executionProof = Test-ExecutionTransaction $executionTx
    Assert-True ($null -ne $executionProof) 'execution transaction does not prove controlled signer + Solend program + exact -200000 raw ATA movement'

    Start-Sleep -Seconds 5
    $exactMemoSignatures = @(Find-ExactFundingSignatures ([string]$funding.memo) | Sort-Object -Unique)
    Assert-True ($exactMemoSignatures.Count -eq 1) "expected one exact funding memo transaction, found $($exactMemoSignatures.Count)"
    Assert-Equal $exactMemoSignatures[0] $fundingSig 'unique funding memo signature'
    $finalControlledRaw = Assert-TokenAccount $ControlledUsdcAta $ControlledWallet 0 'final controlled USDC ATA'
    Assert-Equal $finalControlledRaw $preflight.balances.controlledUsdcRaw 'final controlled USDC balance vs preflight baseline'

    $verified = [ordered]@{
        verifiedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
        intentId = $ExpectedIntentId
        amountRaw = $AmountRaw
        status = $statusBody
        funding = @{ signature = $fundingSig; slot = [long]$fundingTx.slot; proof = $fundingProof }
        execution = @{ signature = [string]$report.signature; slot = [long]$executionTx.slot; err = $executionTx.meta.err; proof = $executionProof }
        reconciliation = @{ exactFundingMemoSignatures = $exactMemoSignatures; controlledUsdcRawBefore = [string]$preflight.balances.controlledUsdcRaw; controlledUsdcRawAfter = [string]$finalControlledRaw }
        verdict = 'VERIFIED'
    }
    Write-JsonFile (Join-Path $RunDir 'verification.json') $verified
    Update-LiveMarker 'verified-complete'
    Write-Host "`nDEMO VERIFIED" -ForegroundColor Green
    Write-Host "funding:   $fundingSig"
    Write-Host "execution: $($report.signature)"
    Write-Host "record:    $(Join-Path $RunDir 'verification.json')"
}

function Invoke-Audit {
    Write-Step 'Strict audit of the published acceptance record'
    Assert-KeylessShell
    Assert-RpcPresent
    Assert-File $AcceptanceDoc 'acceptance document'
    $audit = Invoke-CliJson @('audit', $AcceptanceDoc, '--commitment', 'finalized') @(0) -NoServerConfig
    Assert-Equal $audit.Body.verdict 'VERIFIED' 'audit verdict'
    Assert-Equal $audit.Body.counts.passed 13 'audit PASS count'
    Assert-Equal $audit.Body.counts.failed 0 'audit FAIL count'
    Assert-Equal $audit.Body.counts.unverified 1 'audit UNVERIFIED count'
    Write-Host "`nAUDIT VERIFIED: 13 PASS / 0 FAIL / 1 explicitly UNVERIFIED" -ForegroundColor Green
}

function Invoke-Check {
    Write-Step 'Offline demo-script self-check'
    Assert-Equal $CliRoot 'C:\Users\jeffr\solfrontiermcpcli' 'CLI root'
    Assert-File $CliEntry 'CLI entry point'
    Assert-File $Binary 'release server binary'
    Assert-File $SigningPageSource 'base signing page'
    Assert-File $SigningGuardSource 'signing guard'
    Assert-File $DemoConfig 'demo config'
    [void](Assert-NodeVersion)
    [void](Assert-CliRuntimePinned $CliRoot)
    [void](Assert-RepoPinned $ServerRoot $ExpectedServerHead 'server repo')
    Assert-Equal (Get-FileHash -Algorithm SHA256 -LiteralPath $Binary).Hash $ExpectedBinarySha256 'release binary SHA256'
    Assert-Equal (Get-FileHash -Algorithm SHA256 -LiteralPath $SigningPageSource).Hash $ExpectedSigningPageSha256 'base signing page SHA256'
    Assert-Equal (Get-FileHash -Algorithm SHA256 -LiteralPath $SigningGuardSource).Hash $ExpectedSigningGuardSha256 'signing guard SHA256'
    Assert-Equal (Get-FileHash -Algorithm SHA256 -LiteralPath $DemoConfig).Hash $ExpectedDemoConfigSha256 'demo config SHA256'
    $expectedPage = Get-ExpectedHardenedPageText
    Assert-True (([regex]::Matches($expectedPage, '<script src="signing-guard.js"></script>')).Count -eq 1) 'hardened page does not contain exactly one guard tag'
    $sample = 'warning' + [Environment]::NewLine + '{"rows":[],"scan_errors":[]}' + [Environment]::NewLine + '{"abort_remaining_cycle":true,"status":"completed"}'
    $objects = @(Get-JsonObjectsFromText $sample)
    Assert-True ($objects.Count -eq 2) "JSON object extractor returned $($objects.Count), expected two"
    Assert-True (@($objects[0].rows).Count -eq 0) 'JSON object extractor corrupted the cycle report'
    Assert-True ([bool]$objects[1].abort_remaining_cycle) 'JSON object extractor corrupted the attempt report'
    # Funding-proof regressions over synthetic transactions.
    #
    # The 2026-08-02 run stranded 0.2 USDC because a prefilter compared the
    # RPC's memo summary field for exact equality. That field is formatted
    # "[byte_len] memo", so the one correct, on-time transaction was rejected
    # and blacklisted, and the real verifier below never saw it. These cases
    # pin both halves of the lesson: the summary field is never trusted, and
    # the verifier reads the instructions.
    $mkFunding = {
        param($memoTexts, $amount, $userSigns, $source, $dest, $authority, $userDelta, $ctlDelta)
        $instructions = @()
        foreach ($t in @($memoTexts)) {
            $instructions += ,([pscustomobject]@{ programId = $MemoProgramId; parsed = $t })
        }
        $instructions += ,([pscustomobject]@{
            programId = $TokenProgramId
            parsed = [pscustomobject]@{
                type = 'transferChecked'
                info = [pscustomobject]@{
                    source = $source; destination = $dest; mint = $UsdcMint; authority = $authority
                    tokenAmount = [pscustomobject]@{ amount = [string]$amount; decimals = 6 }
                }
            }
        })
        [pscustomobject]@{
            slot = 1
            meta = [pscustomobject]@{
                err = $null
                logMessages = @('Program MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr invoke [1]')
                preTokenBalances = @(
                    [pscustomobject]@{ owner = $UserWallet; mint = $UsdcMint; uiTokenAmount = [pscustomobject]@{ amount = '1000000' } },
                    [pscustomobject]@{ owner = $ControlledWallet; mint = $UsdcMint; uiTokenAmount = [pscustomobject]@{ amount = '0' } }
                )
                postTokenBalances = @(
                    [pscustomobject]@{ owner = $UserWallet; mint = $UsdcMint; uiTokenAmount = [pscustomobject]@{ amount = [string](1000000 + $userDelta) } },
                    [pscustomobject]@{ owner = $ControlledWallet; mint = $UsdcMint; uiTokenAmount = [pscustomobject]@{ amount = [string]$ctlDelta } }
                )
            }
            transaction = [pscustomobject]@{
                message = [pscustomobject]@{
                    accountKeys = @([pscustomobject]@{ pubkey = $UserWallet; signer = $userSigns })
                    instructions = $instructions
                }
            }
        }
    }
    $goodMemo = 'claw:w5h:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:' + ('b' * 64)
    $good = & $mkFunding @($goodMemo) $AmountRaw $true $UserUsdcAta $ControlledUsdcAta $UserWallet (-[long]$AmountRaw) ([long]$AmountRaw)
    Assert-True ($null -ne (Test-FundingTransaction $good $goodMemo)) 'funding proof rejected an exactly correct transaction'

    # The regression that cost real money: the RPC summary carries a length
    # prefix, but the instruction text does not. The verifier must not care.
    $rpcSummary = "[$($goodMemo.Length)] $goodMemo"
    Assert-True ($rpcSummary -ne $goodMemo) 'RPC memo summary fixture is not actually prefixed'
    Assert-True ($null -ne (Test-FundingTransaction $good $goodMemo)) 'funding proof must ignore the RPC memo summary format'

    # A prefixed memo in the INSTRUCTION is a different memo, and must fail.
    $prefixedIx = & $mkFunding @($rpcSummary) $AmountRaw $true $UserUsdcAta $ControlledUsdcAta $UserWallet (-[long]$AmountRaw) ([long]$AmountRaw)
    Assert-True ($null -eq (Test-FundingTransaction $prefixedIx $goodMemo)) 'funding proof accepted a length-prefixed instruction memo'

    # Extra memos, in either position: EndsWith would accept the first of
    # these, which is why EndsWith is not the fix.
    $memoBefore = & $mkFunding @('unrelated', $goodMemo) $AmountRaw $true $UserUsdcAta $ControlledUsdcAta $UserWallet (-[long]$AmountRaw) ([long]$AmountRaw)
    Assert-True ($null -eq (Test-FundingTransaction $memoBefore $goodMemo)) 'funding proof accepted an extra leading memo'
    $memoAfter = & $mkFunding @($goodMemo, 'unrelated') $AmountRaw $true $UserUsdcAta $ControlledUsdcAta $UserWallet (-[long]$AmountRaw) ([long]$AmountRaw)
    Assert-True ($null -eq (Test-FundingTransaction $memoAfter $goodMemo)) 'funding proof accepted an extra trailing memo'
    $noMemo = & $mkFunding @() $AmountRaw $true $UserUsdcAta $ControlledUsdcAta $UserWallet (-[long]$AmountRaw) ([long]$AmountRaw)
    Assert-True ($null -eq (Test-FundingTransaction $noMemo $goodMemo)) 'funding proof accepted a transaction with no memo'

    # A memo present only in logs, with no outer instruction, must not count.
    $logsOnly = & $mkFunding @() $AmountRaw $true $UserUsdcAta $ControlledUsdcAta $UserWallet (-[long]$AmountRaw) ([long]$AmountRaw)
    $logsOnly.meta.logMessages = @("Program log: Memo (len 106): ""$goodMemo""")
    Assert-True ($null -eq (Test-FundingTransaction $logsOnly $goodMemo)) 'funding proof accepted a memo that exists only in logs'

    # A longer memo that merely contains ours is not ours.
    $superset = & $mkFunding @($goodMemo + ':extra') $AmountRaw $true $UserUsdcAta $ControlledUsdcAta $UserWallet (-[long]$AmountRaw) ([long]$AmountRaw)
    Assert-True ($null -eq (Test-FundingTransaction $superset $goodMemo)) 'funding proof accepted a superset memo'

    # Amount, routing, authority and signer are each independently fatal.
    $wrongAmount = & $mkFunding @($goodMemo) 199999 $true $UserUsdcAta $ControlledUsdcAta $UserWallet (-199999) 199999
    Assert-True ($null -eq (Test-FundingTransaction $wrongAmount $goodMemo)) 'funding proof accepted a wrong amount'
    $wrongDest = & $mkFunding @($goodMemo) $AmountRaw $true $UserUsdcAta $UserUsdcAta $UserWallet (-[long]$AmountRaw) ([long]$AmountRaw)
    Assert-True ($null -eq (Test-FundingTransaction $wrongDest $goodMemo)) 'funding proof accepted a wrong destination'
    $wrongAuthority = & $mkFunding @($goodMemo) $AmountRaw $true $UserUsdcAta $ControlledUsdcAta $ControlledWallet (-[long]$AmountRaw) ([long]$AmountRaw)
    Assert-True ($null -eq (Test-FundingTransaction $wrongAuthority $goodMemo)) 'funding proof accepted a wrong authority'
    $notSigned = & $mkFunding @($goodMemo) $AmountRaw $false $UserUsdcAta $ControlledUsdcAta $UserWallet (-[long]$AmountRaw) ([long]$AmountRaw)
    Assert-True ($null -eq (Test-FundingTransaction $notSigned $goodMemo)) 'funding proof accepted an unsigned payer'
    $lopsided = & $mkFunding @($goodMemo) $AmountRaw $true $UserUsdcAta $ControlledUsdcAta $UserWallet (-1) ([long]$AmountRaw)
    Assert-True ($null -eq (Test-FundingTransaction $lopsided $goodMemo)) 'funding proof accepted mismatched balance deltas'
    $failed = & $mkFunding @($goodMemo) $AmountRaw $true $UserUsdcAta $ControlledUsdcAta $UserWallet (-[long]$AmountRaw) ([long]$AmountRaw)
    $failed.meta.err = [pscustomobject]@{ InstructionError = @(0, 'Custom') }
    Assert-True ($null -eq (Test-FundingTransaction $failed $goodMemo)) 'funding proof accepted a failed transaction'

    # Atomic-write regression. The first Preflight succeeded and the second
    # crashed because Write-JsonFile only ever took its create branch in
    # testing; the overwrite branch passed $null as File.Replace's backup
    # path, which Windows PowerShell 5.1 marshals to "" and .NET rejects.
    # Writing the same path twice is the case that reproduces it, so it is
    # the case that gets a test. Runs entirely in a temp directory.
    $writeProbeDir = Join-Path ([IO.Path]::GetTempPath()) ("sfdemo-write-" + [Guid]::NewGuid().ToString('N'))
    [void](New-Item -ItemType Directory -Path $writeProbeDir)
    try {
        $writeProbe = Join-Path $writeProbeDir 'probe.json'
        Write-JsonFile $writeProbe ([ordered]@{ pass = 1; note = 'create branch' })
        Assert-True (Test-Path -LiteralPath $writeProbe) 'atomic write did not create the file'
        # Second write over an existing file: the branch that was broken.
        Write-JsonFile $writeProbe ([ordered]@{ pass = 2; note = 'overwrite branch' })
        $reread = Get-Content -LiteralPath $writeProbe -Raw | ConvertFrom-Json
        Assert-Equal ([int]$reread.pass) 2 'atomic overwrite did not land the second document'
        Assert-Equal ([string]$reread.note) 'overwrite branch' 'atomic overwrite content'
        $leftovers = @(Get-ChildItem -LiteralPath $writeProbeDir -Filter '*.tmp-*' -Force)
        Assert-True ($leftovers.Count -eq 0) "atomic write left $($leftovers.Count) temp file(s) behind"
        Assert-Equal (@(Get-ChildItem -LiteralPath $writeProbeDir -Force).Count) 1 'atomic write left unexpected files in the directory'
    }
    finally {
        # Precise cleanup: only this probe directory, only if it was created.
        if (Test-Path -LiteralPath $writeProbeDir) {
            Remove-Item -LiteralPath $writeProbeDir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    # Raw-byte ASCII gate. Windows PowerShell 5.1 reads a script without a BOM
    # using the system ANSI codepage, so a UTF-8 multi-byte character is
    # decoded as two or three separate characters. In a comment that is merely
    # ugly; in a string literal, a regex or a pinned constant it silently
    # changes what the script compares against. Held to zero rather than
    # "valid UTF-8" so the file means the same thing under every codepage.
    $asciiTargets = @(
        @{ Path = $PSCommandPath; Label = 'Demo.ps1' },
        @{ Path = $SigningGuardSource; Label = 'signing-guard.js' },
        @{ Path = $DemoConfig; Label = 'demo.config.json' }
    )
    $nonAsciiTotal = 0
    foreach ($target in $asciiTargets) {
        $bytes = [IO.File]::ReadAllBytes($target.Path)
        $count = @($bytes | Where-Object { $_ -gt 127 }).Count
        $nonAsciiTotal += $count
        if ($count -ne 0) {
            Stop-Demo "$($target.Label) contains $count non-ASCII byte(s); demo sources must be pure ASCII"
        }
    }
    Assert-Equal $nonAsciiTotal 0 'non-ASCII byte total across demo sources'
    Write-Host "NON_ASCII_BYTES=$nonAsciiTotal"

    # Freshness decision, offline. These encode the distinction that matters:
    # fresh is not "age <= 16", it is "stale bit clear AND 0 <= age <= 16".
    $mk = {
        param($age, $stale, $apr)
        [pscustomobject]@{ ageSlots = $age; staleFlag = $stale; maxStalenessSlots = 16; supplyAprBps = $apr }
    }
    $goodApr = $ThresholdBps + 1
    Assert-Equal (Get-FreshnessDecision (& $mk 3 $false $goodApr)) 'pass' 'freshness case age=3 stale=false'
    Assert-Equal (Get-FreshnessDecision (& $mk 0 $false $goodApr)) 'pass' 'freshness case age=0 stale=false'
    Assert-Equal (Get-FreshnessDecision (& $mk 16 $false $goodApr)) 'pass' 'freshness case age=16 stale=false (boundary)'
    # Age 0 with the stale bit set: reads fresh if you only look at age.
    Assert-Equal (Get-FreshnessDecision (& $mk 0 $true $goodApr)) 'wait' 'freshness case age=0 stale=true'
    Assert-Equal (Get-FreshnessDecision (& $mk 17 $false $goodApr)) 'wait' 'freshness case age=17 stale=false'
    Assert-Equal (Get-FreshnessDecision (& $mk 999 $true $goodApr)) 'wait' 'freshness case very old and stale'
    # Hard failures: never waited out.
    Assert-Equal (Get-FreshnessDecision (& $mk -1 $false $goodApr)) 'fail' 'freshness case negative age'
    Assert-Equal (Get-FreshnessDecision (& $mk 3 $false $ThresholdBps)) 'fail' 'freshness case APY equal to threshold'
    Assert-Equal (Get-FreshnessDecision (& $mk 3 $false ($ThresholdBps - 1))) 'fail' 'freshness case APY below threshold'
    Assert-Equal (Get-FreshnessDecision $null) 'fail' 'freshness case null reserve'
    $wrongMax = [pscustomobject]@{ ageSlots = 3; staleFlag = $false; maxStalenessSlots = 32; supplyAprBps = $goodApr }
    Assert-Equal (Get-FreshnessDecision $wrongMax) 'fail' 'freshness case unexpected staleness bound'

    $tokens = $null
    $errors = $null
    [void][Management.Automation.Language.Parser]::ParseFile($PSCommandPath, [ref]$tokens, [ref]$errors)
    Assert-True ($errors.Count -eq 0) "PowerShell parser found $($errors.Count) error(s)"
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & node.exe --check $SigningGuardSource 2>$null
        $guardSyntaxCode = $LASTEXITCODE
    }
    finally { $ErrorActionPreference = $previousPreference }
    Assert-Equal $guardSyntaxCode 0 'signing guard syntax check exit'
    Write-Host "`nOFFLINE SELF-CHECK PASS" -ForegroundColor Green
}

try {
    switch ($Mode) {
        'Check'     { Invoke-Check }
        'Serve'     { Invoke-Serve }
        'Preflight' { Invoke-Preflight }
        'Executor'  { Invoke-Executor }
        'Live'      { Invoke-Live }
        'Verify'    { Invoke-Verify }
        'Audit'     { Invoke-Audit }
    }
}
catch {
    Write-Host "`n$($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
