# Run one "family phone" backend. Settings here override backend\.env for this process only.
#
#   One laptop, three phones (each in its own terminal), or all at once with scripts\family.ps1:
#     powershell -File scripts\run_device.ps1 -Id phone-1 -Port 8000 -Peers http://127.0.0.1:8001,http://127.0.0.1:8002
#     powershell -File scripts\run_device.ps1 -Id phone-2 -Port 8001 -Peers http://127.0.0.1:8000,http://127.0.0.1:8002
#     powershell -File scripts\run_device.ps1 -Id phone-3 -Port 8002 -Peers http://127.0.0.1:8000,http://127.0.0.1:8001 -HostileClock 1970
#
#   Then point a UI at each:  cd frontend; $env:BACKEND_URL="http://127.0.0.1:8001"; npx vite --port 5174
#   Across laptops use LAN IPs in -Peers instead of 127.0.0.1, and the same -SyncKey on every laptop.
#   -DbDir keeps a demo family's ledgers apart from the real one (backend\data\ledger-phone-1.db).
param(
    [Parameter(Mandatory)][string]$Id,
    [int]$Port = 8000,
    [string]$Peers = "",
    [ValidateSet("off", "1970", "jump")][string]$HostileClock = "off",
    [ValidateSet("", "demo", "real")][string]$ModelMode = "",
    [string]$DbDir = "data",            # relative to backend\
    [string]$SyncKey = "",              # "" = whatever backend\.env says
    [double]$SyncInterval = -1          # seconds; 0 = only on "Sync now"; -1 = backend\.env / default
)

$env:DEVICE_ID = $Id
$env:DB_PATH = "$DbDir/ledger-$Id.db"
$env:PEERS = $Peers
$env:HOSTILE_CLOCK = $HostileClock
if ($ModelMode) { $env:MODEL_MODE = $ModelMode }
if ($SyncKey) { $env:SYNC_KEY = $SyncKey }
if ($SyncInterval -ge 0) { $env:SYNC_INTERVAL_S = "$SyncInterval" }
if ($Id -ne "phone-1") { $env:MIC_ENABLED = "false"; $env:WHISPER_PRELOAD = "false" }   # only the main device listens
if (-not $env:UV_PROJECT_ENVIRONMENT) {   # the user-level setting from scripts\setup_models.ps1
    $env:UV_PROJECT_ENVIRONMENT = [Environment]::ExpandEnvironmentVariables(
        (Get-Item HKCU:\Environment).GetValue("UV_PROJECT_ENVIRONMENT", "", "DoNotExpandEnvironmentNames"))
    if (-not $env:UV_PROJECT_ENVIRONMENT) { throw "UV_PROJECT_ENVIRONMENT is not set: run scripts\setup_models.ps1 first" }
}

Push-Location (Join-Path (Split-Path $PSScriptRoot -Parent) "backend")
try {
    Write-Host "$Id on :$Port  ledger=$env:DB_PATH  peers=[$Peers]  clock=$HostileClock"
    uv run uvicorn app.main:app --host 0.0.0.0 --port $Port
} finally {
    Pop-Location
}
