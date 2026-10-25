# Downloads everything the app needs to run offline. Safe to re-run (skips what exists).
# Progress log: E:\ai\logs\setup.log   ->  watch with:  Get-Content E:\ai\logs\setup.log -Wait
param(
    [string]$Root = "E:\ai",
    [switch]$SkipBakeoffModels
)

$ErrorActionPreference = "Continue"
$logDir = Join-Path $Root "logs"
$installers = Join-Path $Root "installers"
New-Item -ItemType Directory -Force $logDir, $installers, "$Root\ollama", "$Root\hf" | Out-Null
$log = Join-Path $logDir "setup.log"

function Log($msg) {
    $line = "[{0}] {1}" -f (Get-Date -Format "HH:mm:ss"), $msg
    Add-Content -Path $log -Value $line
    Write-Host $line
}

# Make sure this process sees the storage locations even if the user env isn't reloaded yet.
$env:OLLAMA_MODELS = "$Root\ollama"
$env:HF_HOME = "$Root\hf"
$env:UV_CACHE_DIR = "$Root\uv-cache"
$env:UV_PYTHON_INSTALL_DIR = "$Root\uv-python"
[Environment]::SetEnvironmentVariable("OLLAMA_MODELS", $env:OLLAMA_MODELS, "User")
[Environment]::SetEnvironmentVariable("HF_HOME", $env:HF_HOME, "User")
[Environment]::SetEnvironmentVariable("UV_CACHE_DIR", $env:UV_CACHE_DIR, "User")
[Environment]::SetEnvironmentVariable("UV_PYTHON_INSTALL_DIR", $env:UV_PYTHON_INSTALL_DIR, "User")

Log "=== setup started (root=$Root) ==="

# --- 1. Ollama -------------------------------------------------------------
$ollamaExe = Join-Path $env:LOCALAPPDATA "Programs\Ollama\ollama.exe"
if (-not (Test-Path $ollamaExe)) {
    $setup = Join-Path $installers "OllamaSetup.exe"
    Log "Downloading Ollama installer (resumable)..."
    curl.exe -L --retry 10 --retry-delay 5 -C - -o $setup "https://ollama.com/download/OllamaSetup.exe" 2>> $log
    Log "Installing Ollama silently..."
    Start-Process -FilePath $setup -ArgumentList "/VERYSILENT", "/NORESTART", "/SUPPRESSMSGBOXES" -Wait
}
if (Test-Path $ollamaExe) { Log "Ollama OK: $ollamaExe" } else { Log "ERROR: Ollama not installed"; }

# Restart the server so it picks up OLLAMA_MODELS=E:\ai\ollama
Get-Process ollama*, "ollama app" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Process -FilePath $ollamaExe -ArgumentList "serve" -WindowStyle Hidden
Start-Sleep -Seconds 5

# --- 2. uv (Python env manager) -------------------------------------------
if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    Log "Installing uv..."
    py -3.13 -m pip install --user --upgrade uv 2>> $log | Out-Null
}
$uv = (Get-Command uv -ErrorAction SilentlyContinue).Source
if (-not $uv) { $uv = Get-ChildItem "$env:APPDATA\Python\Python313\Scripts\uv.exe" -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName }
Log "uv: $uv"

# --- 3. Ollama models ------------------------------------------------------
$models = @("qwen3-vl:4b")
if (-not $SkipBakeoffModels) { $models += "gemma3:4b" }
foreach ($m in $models) {
    Log "Pulling $m ..."
    & $ollamaExe pull $m *>> $log
    if ($LASTEXITCODE -eq 0) { Log "DONE $m" } else { Log "ERROR pulling $m (re-run script to resume)" }
}

# --- 4. Whisper large-v3-turbo (CTranslate2 format for faster-whisper) ------
if ($uv) {
    foreach ($repo in @("mobiuslabsgmbh/faster-whisper-large-v3-turbo")) {
        Log "Downloading $repo ..."
        & $uv tool run --from huggingface_hub hf download $repo *>> $log
        if ($LASTEXITCODE -eq 0) { Log "DONE $repo" } else { Log "ERROR downloading $repo (re-run to resume)" }
    }
} else {
    Log "ERROR: uv missing, skipped Whisper download"
}

Log "=== setup finished ==="
& $ollamaExe list *>> $log
