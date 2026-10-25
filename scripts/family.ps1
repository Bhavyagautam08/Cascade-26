# A whole family of phones on this laptop for the sync demo: one backend + one UI per phone, each in its
# own window. Each phone keeps its own ledger file in backend\data\family\ (never the real ledger), so
# a phone can be closed ("taken to the mandi") and started again: its book comes back from disk and
# catches up by itself. Only phone-1 listens to the mic.
#
#   powershell -File scripts\family.ps1                        # phone-1..3: backends 8000-8002, UIs 5173-5175
#   powershell -File scripts\family.ps1 -BrokenClock 3:1970    # phone-3's clock says 1970
#   powershell -File scripts\family.ps1 -DryRun                # print the commands, start nothing
#
# Bring one phone back after closing its window: run the line printed for it.
param(
    [ValidateRange(2, 9)][int]$Phones = 3,
    [int]$BasePort = 8000,
    [int]$UiBasePort = 5173,
    [string]$SyncKey = "",                  # "" = a fresh random key for this family, printed below
    [string]$BrokenClock = "",              # "N:1970" or "N:jump" for phone-N
    [ValidateSet("", "demo", "real")][string]$ModelMode = "",
    [switch]$DryRun
)
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent

$broken = @{}
if ($BrokenClock) {
    if ($BrokenClock -notmatch '^(\d):(1970|jump)$') { throw "-BrokenClock must look like 3:1970 or 2:jump" }
    $broken[[int]$Matches[1]] = $Matches[2]
}
$ports = 0..($Phones - 1) | ForEach-Object { $BasePort + $_ }
$uiPorts = 0..($Phones - 1) | ForEach-Object { $UiBasePort + $_ }
$busy = @($ports + $uiPorts | Where-Object { Get-NetTCPConnection -LocalPort $_ -State Listen -ErrorAction SilentlyContinue })
if ($busy.Count) { throw "port(s) $($busy -join ', ') already in use: stop what runs there, or pass -BasePort / -UiBasePort" }
if (-not $SyncKey) { $SyncKey = [guid]::NewGuid().ToString("N").Substring(0, 16) }

Write-Host "family sync key: $SyncKey   (other laptops joining this family need the same -SyncKey)"
for ($i = 1; $i -le $Phones; $i++) {
    $id = "phone-$i"
    $peers = ($ports | Where-Object { $_ -ne $ports[$i - 1] } | ForEach-Object { "http://127.0.0.1:$_" }) -join ","
    $clock = if ($broken.ContainsKey($i)) { $broken[$i] } else { "off" }
    $back = @("-NoExit", "-File", "$PSScriptRoot\run_device.ps1", "-Id", $id, "-Port", $ports[$i - 1], "-Peers", $peers,
              "-DbDir", "data/family", "-SyncKey", $SyncKey, "-HostileClock", $clock)
    if ($ModelMode) { $back += @("-ModelMode", $ModelMode) }
    $ui = "cd '$root\frontend'; `$env:BACKEND_URL='http://127.0.0.1:$($ports[$i - 1])'; npx vite --port $($uiPorts[$i - 1]) --strictPort"
    Write-Host "$id  backend: powershell $($back -join ' ')"
    Write-Host "$id  ui:      http://localhost:$($uiPorts[$i - 1])   ($ui)"
    if (-not $DryRun) {
        Start-Process powershell -ArgumentList $back -WorkingDirectory $root
        Start-Process powershell -ArgumentList @("-NoExit", "-Command", $ui) -WorkingDirectory $root
    }
}
if ($DryRun) { Write-Host "dry run: nothing started" }
