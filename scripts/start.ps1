# Start this device: the backend (reachable by the family's laptops) and the dashboard, each in its own
# window. Settings come from backend\.env (written by scripts\setup_device.ps1).
#
#   powershell -ExecutionPolicy Bypass -File scripts\start.ps1          # then open http://localhost:5173
#   powershell -ExecutionPolicy Bypass -File scripts\start.ps1 -DryRun  # print the commands only
#
# Stop: close the two windows. The ledger is a file (backend\data\...): nothing is lost on close.
param([int]$Port = 8000, [int]$UiPort = 5173, [switch]$DryRun)
$ErrorActionPreference = "Stop"
$repo = Split-Path $PSScriptRoot -Parent
if (-not (Test-Path (Join-Path $repo "backend\.env"))) { throw "backend\.env is missing: run scripts\setup_device.ps1 first" }
$busy = @($Port, $UiPort | Where-Object { Get-NetTCPConnection -LocalPort $_ -State Listen -ErrorAction SilentlyContinue })
if ($busy.Count) { throw "port(s) $($busy -join ', ') already in use: is this device already running? (close its windows first)" }
if (-not $env:UV_PROJECT_ENVIRONMENT) {
    $env:UV_PROJECT_ENVIRONMENT = [Environment]::ExpandEnvironmentVariables(
        (Get-Item HKCU:\Environment).GetValue("UV_PROJECT_ENVIRONMENT", "", "DoNotExpandEnvironmentNames"))
    if (-not $env:UV_PROJECT_ENVIRONMENT) { throw "UV_PROJECT_ENVIRONMENT is not set: run scripts\setup_device.ps1 first" }
}
$back = "`$env:UV_PROJECT_ENVIRONMENT='$env:UV_PROJECT_ENVIRONMENT'; cd '$repo\backend'; uv run uvicorn app.main:app --host 0.0.0.0 --port $Port"
$ui = "cd '$repo\frontend'; `$env:BACKEND_URL='http://127.0.0.1:$Port'; npx vite --port $UiPort --strictPort"
Write-Host "backend:   $back"
Write-Host "dashboard: $ui"
if ($DryRun) { Write-Host "dry run: nothing started"; exit 0 }
Start-Process powershell -ArgumentList @("-NoExit", "-Command", $back) -WorkingDirectory $repo
Start-Process powershell -ArgumentList @("-NoExit", "-Command", $ui) -WorkingDirectory $repo
Write-Host "starting... open http://localhost:$UiPort  (health: http://localhost:$Port/health)"
