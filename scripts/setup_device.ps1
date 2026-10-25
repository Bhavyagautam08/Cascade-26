# Set up THIS laptop as one device of the family, from a fresh clone, in one command. See docs/SETUP.md.
#
#   First laptop (it makes up the family key; note it down for the others):
#     powershell -ExecutionPolicy Bypass -File scripts\setup_device.ps1 -DeviceId phone-1 -Mic -NewSyncKey
#   Every other laptop (the key from the first one, the others' addresses printed by their setup):
#     powershell -ExecutionPolicy Bypass -File scripts\setup_device.ps1 -DeviceId phone-2 `
#         -SyncKey <family key> -Peers http://192.168.1.10:8000,http://192.168.1.12:8000
#   See what it would do, change nothing:   ... -DryRun
#
# What it does, in order (each step says what it found; nothing is hidden, nothing is guessed):
#   1. checks Git, Node.js >= 20, uv, Ollama (Ollama is optional: without it the rule parser reads text)
#   2. installs the Python + UI packages and Whisper small into your user profile (scripts\setup_models.ps1)
#   3. writes this device's settings into backend\.env (made from .env.example if missing); only the
#      settings named here change, everything else in the file is kept
#   4. NVIDIA GPU? -> Whisper on the GPU, else on the CPU
#   5. Windows Firewall: lets the other laptops reach port 8000 (needs an Administrator terminal,
#      otherwise prints the one command to run as Administrator)
#   6. prints this laptop's Wi-Fi address, to put in the other laptops' -Peers
#   7. checks each peer: reachable? same family key?
#   8. runs the backend tests
# Re-run it any time: it is safe to repeat. Log: %LOCALAPPDATA%\cascade\setup.log (step 2).
param(
    [Parameter(Mandatory)][string]$DeviceId,
    [string]$Peers = "",                 # comma-separated http://<ip>:8000 of the other family laptops
    [string]$SyncKey = "",               # the family's shared key (same on every laptop)
    [switch]$NewSyncKey,                 # first laptop only: make up a new family key
    [switch]$Mic,                        # this is the vendor's main device: always-on mic
    [ValidateSet("real", "demo")][string]$ModelMode = "real",
    [int]$Port = 8000,
    [switch]$PullModel,                  # also download the language model with `ollama pull` (~3.3 GB)
    [switch]$SkipInstall,                # settings only (packages already installed)
    [switch]$SkipTests,
    [switch]$DryRun
)
$ErrorActionPreference = "Stop"
$repo = Split-Path $PSScriptRoot -Parent
$envFile = Join-Path $repo "backend\.env"
$problems = New-Object System.Collections.Generic.List[string]
function Step($n, $what) { Write-Host ""; Write-Host "[$n] $what" -ForegroundColor Cyan }
function Ok($msg) { Write-Host "    ok: $msg" -ForegroundColor Green }
function Bad($msg) { Write-Host "    PROBLEM: $msg" -ForegroundColor Yellow; $problems.Add($msg) }
function Info($msg) { Write-Host "    $msg" }

# --- 0. the inputs must make sense before anything is touched -----------------------------------------
if ($DeviceId -notmatch '^[A-Za-z0-9_-]{1,32}$' -or $DeviceId -eq "fusion") {
    throw "-DeviceId '$DeviceId' can't be used: 1-32 letters, digits, '-' or '_' (e.g. phone-2), not 'fusion'"
}
if ($SyncKey -and $NewSyncKey) { throw "give either -SyncKey (join a family) or -NewSyncKey (start one), not both" }
if ($NewSyncKey) { $SyncKey = [guid]::NewGuid().ToString("N").Substring(0, 20) }
$peerList = @($Peers -split "," | ForEach-Object { $_.Trim().TrimEnd("/") } | Where-Object { $_ })
foreach ($p in $peerList) {
    if ($p -notmatch '^http://[A-Za-z0-9.\-]+:\d+$') { throw "peer '$p' must look like http://192.168.1.12:8000" }
}
if ($DryRun) { Write-Host "DRY RUN: nothing will be installed or changed" -ForegroundColor Magenta }

# --- 1. prerequisites ---------------------------------------------------------------------------------
Step 1 "Programs this laptop needs"
foreach ($tool in @(
        @{ name = "git"; url = "https://git-scm.com/downloads"; must = $true },
        @{ name = "node"; url = "https://nodejs.org/en/download"; must = $true },
        @{ name = "uv"; url = "https://docs.astral.sh/uv/getting-started/installation/"; must = $true },
        @{ name = "ollama"; url = "https://ollama.com/download"; must = $false })) {
    $cmd = Get-Command $tool.name -ErrorAction SilentlyContinue
    if (-not $cmd) {
        if ($tool.must) { Bad "$($tool.name) is not installed: $($tool.url) (then open a NEW terminal and re-run)" }
        else { Bad "$($tool.name) is not installed: $($tool.url) (optional: without it typed/SMS text is read by the rule parser, slips can't be read)" }
        continue
    }
    if ($tool.name -eq "node") {
        $v = (& node --version).TrimStart("v")
        if ([version]$v -lt [version]"20.0.0") { Bad "Node.js $v is too old: install 20 or newer from $($tool.url)" } else { Ok "Node.js $v" }
    } else { Ok "$($tool.name) found" }
}
if ($problems | Where-Object { $_ -match "^(git|node|uv) is not installed|Node.js .* too old" }) {
    Write-Host ""; Write-Host "Install the programs above first, open a new terminal, then run this again." -ForegroundColor Yellow
    exit 1
}

# --- 2. packages + Whisper -------------------------------------------------------------------------------
Step 2 "Python + UI packages and Whisper small (into your user profile, not the project)"
if ($SkipInstall) { Info "skipped (-SkipInstall)" }
elseif ($DryRun) { Info "would run: scripts\setup_models.ps1" }
else {
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "setup_models.ps1")
    if ($LASTEXITCODE -ne 0) { Bad "package / Whisper install failed: see %LOCALAPPDATA%\cascade\setup.log" } else { Ok "installed" }
}
if ($PullModel) {
    if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) { Bad "-PullModel: Ollama is not installed" }
    elseif ($DryRun) { Info "would run: ollama pull qwen3-vl:4b-instruct" }
    else { & ollama pull qwen3-vl:4b-instruct; if ($LASTEXITCODE -ne 0) { Bad "ollama pull failed (is the Ollama app running?)" } else { Ok "language model downloaded" } }
}

# --- 3 + 4. backend\.env ---------------------------------------------------------------------------------
Step 3 "This device's settings (backend\.env)"
$lines = if (Test-Path $envFile) { [IO.File]::ReadAllLines($envFile) } else { [IO.File]::ReadAllLines((Join-Path $repo ".env.example")) }
function Get-Setting($key) {
    $m = $lines | Where-Object { $_ -match "^\s*$key\s*=" } | Select-Object -First 1
    if ($m) { ($m -split "=", 2)[1].Trim() } else { $null }
}
$oldId, $oldDb = (Get-Setting "DEVICE_ID"), (Get-Setting "DB_PATH")
$newDb = "data/ledger-$DeviceId.db"
if ((Test-Path $envFile) -and $oldId -and $oldId -ne $DeviceId -and $oldDb -and (Test-Path (Join-Path $repo "backend\$oldDb"))) {
    throw ("this laptop is already '$oldId' with a ledger at backend\$oldDb. A ledger can't change its device name " +
           "(the app refuses it). Keep -DeviceId $oldId, or move that ledger file away yourself first.")
}
$gpu = $false
if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) { & nvidia-smi -L *> $null; $gpu = ($LASTEXITCODE -eq 0) }
$set = [ordered]@{
    DEVICE_ID = $DeviceId
    DB_PATH = $newDb
    MODEL_MODE = $ModelMode
    MIC_ENABLED = $(if ($Mic) { "true" } else { "false" })
    WHISPER_DEVICE = $(if ($gpu) { "cuda" } else { "cpu" })
    WHISPER_COMPUTE_TYPE = $(if ($gpu) { "int8_float16" } else { "int8" })
    PEERS = ($peerList -join ",")
}
if ($SyncKey) { $set["SYNC_KEY"] = $SyncKey }
$out = [System.Collections.Generic.List[string]]::new()
$done = @{}
foreach ($l in $lines) {
    $k = if ($l -match '^\s*([A-Z_]+)\s*=') { $Matches[1] } else { $null }
    if ($k -and $set.Contains($k)) { $out.Add("$k=$($set[$k])"); $done[$k] = $true } else { $out.Add($l) }
}
foreach ($k in $set.Keys) { if (-not $done[$k]) { $out.Add("$k=$($set[$k])") } }
foreach ($k in $set.Keys) { Info ("{0,-21} = {1}" -f $k, $(if ($k -eq "SYNC_KEY") { "(set)" } else { $set[$k] })) }
Info ("Whisper runs on the " + $(if ($gpu) { "NVIDIA GPU" } else { "CPU (no NVIDIA GPU found): slower, still works" }))
$key = if ($SyncKey) { $SyncKey } else { Get-Setting "SYNC_KEY" }
if (-not $key) { Bad "no family key (SYNC_KEY): anyone on the Wi-Fi could read and change the books. Re-run with -SyncKey <key> (or -NewSyncKey on the first laptop)" }
if (-not $peerList) { Info "no peers yet: this laptop works alone until -Peers lists the others" }
if ($DryRun) { Info "would write backend\.env" } else { [IO.File]::WriteAllLines($envFile, $out); Ok "backend\.env written" }
if ($NewSyncKey) { Write-Host "    FAMILY KEY (give it to the other laptops): $SyncKey" -ForegroundColor Magenta }

# --- 5. firewall -------------------------------------------------------------------------------------------
Step 5 "Windows Firewall: let the family's laptops reach port $Port"
$rule = "Cascade backend $Port"
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$create = "New-NetFirewallRule -DisplayName '$rule' -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Private,Domain"
if (Get-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue) { Ok "rule '$rule' exists" }
elseif ($DryRun) { Info "would add: $create" }
elseif ($admin) { Invoke-Expression $create | Out-Null; Ok "rule '$rule' added" }
else { Bad "no firewall rule yet. In a terminal opened with 'Run as administrator', run:  $create" }
$public = @(Get-NetConnectionProfile -ErrorAction SilentlyContinue | Where-Object { $_.NetworkCategory -eq "Public" })
foreach ($n in $public) {
    Bad "the network '$($n.Name)' is set to Public, so Windows blocks the other laptops. Settings > Network > (this Wi-Fi) > Network profile: Private"
}

# --- 6. this laptop's address -------------------------------------------------------------------------
Step 6 "This laptop's address (put it in the other laptops' -Peers)"
# Only adapters with a gateway: a real Wi-Fi / hotspot connection, not virtual ones (WSL, Hyper-V, VPN stubs)
$nets = @(Get-NetIPConfiguration -ErrorAction SilentlyContinue | Where-Object { $_.IPv4DefaultGateway -and $_.IPv4Address })
if ($nets) { foreach ($n in $nets) { foreach ($a in $n.IPv4Address | Where-Object { $_.IPAddress -notmatch '^169\.254\.' }) { Info "http://$($a.IPAddress):$Port   ($($n.InterfaceAlias))" } } }
else { Bad "no network address: connect to the family's Wi-Fi / hotspot first" }

# --- 7. peers -------------------------------------------------------------------------------------------
Step 7 "The other laptops"
foreach ($p in $peerList) {
    try {
        $h = Invoke-RestMethod "$p/sync/hello" -Headers @{ "X-Sync-Key" = "$key" } -TimeoutSec 4
        if ($h.name -eq $DeviceId) { Bad "$p is ALSO called '$DeviceId': give every laptop its own -DeviceId" }
        else { Ok "$p is '$($h.name)', same family key" }
    } catch {
        $code = $_.Exception.Response.StatusCode.value__
        if ($code -eq 401) { Bad "$p answers but refuses the key: use the same -SyncKey on every laptop" }
        else { Info "$p not reachable now ($($_.Exception.Message)). Fine if it isn't running yet; sync starts by itself once it is." }
    }
}
if (-not $peerList) { Info "none listed" }

# --- 8. tests -------------------------------------------------------------------------------------------
Step 8 "Backend tests"
if ($SkipTests -or $DryRun) { Info "skipped" }
else {
    if (-not $env:UV_PROJECT_ENVIRONMENT) {
        $env:UV_PROJECT_ENVIRONMENT = [Environment]::ExpandEnvironmentVariables(
            (Get-Item HKCU:\Environment).GetValue("UV_PROJECT_ENVIRONMENT", "", "DoNotExpandEnvironmentNames"))
    }
    Push-Location (Join-Path $repo "backend")
    try { & uv run pytest -q 2>&1 | Select-Object -Last 3 | ForEach-Object { Info $_ } } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { Bad "some tests failed (above)" } else { Ok "all tests pass" }
}

Write-Host ""
if ($problems.Count) {
    Write-Host "Set up, with $($problems.Count) thing(s) to fix:" -ForegroundColor Yellow
    $problems | ForEach-Object { Write-Host "  - $_" -ForegroundColor Yellow }
} else { Write-Host "All set." -ForegroundColor Green }
Write-Host "Start this device:  powershell -ExecutionPolicy Bypass -File scripts\start.ps1   (then open http://localhost:5173)"
if ($problems.Count) { exit 2 }
