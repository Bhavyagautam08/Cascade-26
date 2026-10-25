# Run one "family phone" backend. Settings here override backend\.env for this process only.
#
#   One laptop, three phones (each in its own terminal):
#     powershell -File scripts\run_device.ps1 -Id phone-1 -Port 8000 -Peers http://127.0.0.1:8001,http://127.0.0.1:8002
#     powershell -File scripts\run_device.ps1 -Id phone-2 -Port 8001 -Peers http://127.0.0.1:8000,http://127.0.0.1:8002
#     powershell -File scripts\run_device.ps1 -Id phone-3 -Port 8002 -Peers http://127.0.0.1:8000,http://127.0.0.1:8001 -HostileClock 1970
#
#   Then point a UI at each:  cd frontend; $env:BACKEND_URL="http://127.0.0.1:8001"; npx vite --port 5174
#   Across laptops use LAN IPs in -Peers instead of 127.0.0.1.
param(
    [Parameter(Mandatory)][string]$Id,
    [int]$Port = 8000,
    [string]$Peers = "",
    [ValidateSet("off", "1970", "jump")][string]$HostileClock = "off",
    [ValidateSet("", "demo", "real")][string]$ModelMode = ""
)

$env:DEVICE_ID = $Id
$env:DB_PATH = "data/ledger-$Id.db"
$env:PEERS = $Peers
$env:HOSTILE_CLOCK = $HostileClock
if ($ModelMode) { $env:MODEL_MODE = $ModelMode }
if ($Id -ne "phone-1") { $env:MIC_ENABLED = "false" }   # only the vendor's main device listens

Push-Location (Join-Path (Split-Path $PSScriptRoot -Parent) "backend")
try {
    Write-Host "$Id on :$Port  peers=[$Peers]  clock=$HostileClock"
    uv run uvicorn app.main:app --host 0.0.0.0 --port $Port
} finally {
    Pop-Location
}
