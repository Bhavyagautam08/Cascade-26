# One-shot setup for a fresh Windows laptop: Ollama + models + Python deps + UI deps.
# Everything needed at runtime is downloaded here; after this the app runs with Wi-Fi OFF.
# Safe to re-run: every step resumes / skips what already exists, and retries on flaky networks.
#
#   powershell -ExecutionPolicy Bypass -File scripts\setup_models.ps1                 # all
#   powershell -ExecutionPolicy Bypass -File scripts\setup_models.ps1 -Root D:\ai     # custom drive
#   powershell -ExecutionPolicy Bypass -File scripts\setup_models.ps1 -SkipBakeoffModels
#
# Progress log: <Root>\logs\setup.log   (watch: Get-Content <Root>\logs\setup.log -Wait)
param(
    [string]$Root = $(if (Test-Path "E:\") { "E:\ai" } else { Join-Path $env:USERPROFILE "ai" }),
    [switch]$SkipBakeoffModels
)

$ErrorActionPreference = "Continue"
$repo = Split-Path $PSScriptRoot -Parent
$logDir = Join-Path $Root "logs"
$installers = Join-Path $Root "installers"
New-Item -ItemType Directory -Force $logDir, $installers, "$Root\ollama", "$Root\hf", "$Root\uv-cache" | Out-Null
$log = Join-Path $logDir "setup.log"

function Log($msg) {
    $line = "[{0}] {1}" -f (Get-Date -Format "HH:mm:ss"), $msg
    Add-Content -Path $log -Value $line
    Write-Host $line
}

function Retry([string]$what, [scriptblock]$action, [int]$tries = 100) {
    for ($i = 1; $i -le $tries; $i++) {
        Log "$what (attempt $i)"
        & $action
        if ($LASTEXITCODE -eq 0) { Log "DONE $what"; return $true }
        Start-Sleep -Seconds 5
    }
    Log "FAILED $what"; return $false
}

# Storage locations (persisted for future shells too)
$envs = @{
    OLLAMA_MODELS = "$Root\ollama"; HF_HOME = "$Root\hf"
    UV_CACHE_DIR = "$Root\uv-cache"; UV_HTTP_TIMEOUT = "300"
}
foreach ($k in $envs.Keys) {
    Set-Item "env:$k" $envs[$k]
    [Environment]::SetEnvironmentVariable($k, $envs[$k], "User")
}
Log "=== setup started (root=$Root, repo=$repo) ==="

# --- 1. Ollama ---------------------------------------------------------------------------
$ollamaExe = Join-Path $env:LOCALAPPDATA "Programs\Ollama\ollama.exe"
if (-not (Test-Path $ollamaExe)) {
    $setup = Join-Path $installers "OllamaSetup.exe"
    Retry "download Ollama installer" {
        curl.exe -L -sS --retry 5 --retry-all-errors --speed-limit 1024 --speed-time 60 -C - -o $setup "https://ollama.com/download/OllamaSetup.exe" 2>> $log
    } | Out-Null
    Log "Installing Ollama silently..."
    Start-Process -FilePath $setup -ArgumentList "/VERYSILENT", "/NORESTART", "/SUPPRESSMSGBOXES" -Wait
}
if (-not (Test-Path $ollamaExe)) { Log "ERROR: Ollama not installed, stopping"; exit 1 }
Log "Ollama OK: $ollamaExe"

# Restart the server so it uses OLLAMA_MODELS
Get-Process ollama*, "ollama app" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Process -FilePath $ollamaExe -ArgumentList "serve" -WindowStyle Hidden
Start-Sleep -Seconds 5

# --- 2. uv ------------------------------------------------------------------------------
$uv = (Get-Command uv -ErrorAction SilentlyContinue).Source
if (-not $uv) {
    Retry "install uv" { winget install --id astral-sh.uv -e --silent --accept-source-agreements --accept-package-agreements | Out-Null } 3 | Out-Null
    $uv = (Get-Command uv -ErrorAction SilentlyContinue).Source
    if (-not $uv) { $uv = Join-Path $env:USERPROFILE ".local\bin\uv.exe" }
    if (-not (Test-Path $uv)) { $uv = (Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Links\uv.exe" -ErrorAction SilentlyContinue).FullName }
}
if (-not $uv -or -not (Test-Path $uv)) { Log "ERROR: uv not found, stopping"; exit 1 }
Log "uv: $uv"

# --- 3. Ollama models (primary first, bake-off last) -------------------------------------
Retry "ollama pull qwen3-vl:4b" { & $ollamaExe pull qwen3-vl:4b 2>&1 | Select-Object -Last 1 | Out-File -Append $log } | Out-Null

# --- 4. Whisper models (CTranslate2 format for faster-whisper) ---------------------------
Retry "whisper large-v3-turbo" { & $uv tool run --from huggingface_hub hf download mobiuslabsgmbh/faster-whisper-large-v3-turbo 2>&1 | Select-Object -Last 1 | Out-File -Append $log } | Out-Null
Retry "whisper small (CPU fallback)" { & $uv tool run --from huggingface_hub hf download Systran/faster-whisper-small 2>&1 | Select-Object -Last 1 | Out-File -Append $log } | Out-Null

# --- 5. Python deps (backend\.venv, Python 3.12) -----------------------------------------
Push-Location (Join-Path $repo "backend")
Retry "uv sync (backend deps)" { & $uv sync --python 3.12 2>&1 | Select-Object -Last 2 | Out-File -Append $log } 30 | Out-Null
Pop-Location

# --- 6. UI deps -------------------------------------------------------------------------
if (Get-Command npm -ErrorAction SilentlyContinue) {
    Push-Location (Join-Path $repo "frontend")
    Retry "npm install (frontend)" { npm install --no-audit --no-fund 2>&1 | Select-Object -Last 2 | Out-File -Append $log } 10 | Out-Null
    Pop-Location
} else { Log "WARN: npm not found - install Node.js 20+ and run 'npm install' in frontend\" }

# --- 7. Bake-off model (optional, biggest, last) ----------------------------------------
if (-not $SkipBakeoffModels) {
    Retry "ollama pull gemma3:4b" { & $ollamaExe pull gemma3:4b 2>&1 | Select-Object -Last 1 | Out-File -Append $log } | Out-Null
}

Log "=== setup finished ==="
& $ollamaExe list 2>&1 | Out-File -Append $log
& $ollamaExe list
