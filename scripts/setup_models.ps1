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
    # Flaky networks drop the connection; keep resuming (-C -) until curl reports success.
    for ($i = 1; $i -le 300; $i++) {
        $mb = if (Test-Path $setup) { [math]::Round((Get-Item $setup).Length / 1MB, 1) } else { 0 }
        Log "Downloading Ollama installer (attempt $i, have $mb MB)..."
        curl.exe -L -sS --retry 5 --retry-all-errors --speed-limit 1024 --speed-time 60 -C - -o $setup "https://ollama.com/download/OllamaSetup.exe" 2>> $log
        if ($LASTEXITCODE -eq 0) { break }
        Start-Sleep -Seconds 5
    }
    Log "Installing Ollama silently..."
    Start-Process -FilePath $setup -ArgumentList "/VERYSILENT", "/NORESTART", "/SUPPRESSMSGBOXES" -Wait
}
if (Test-Path $ollamaExe) { Log "Ollama OK: $ollamaExe" } else { Log "ERROR: Ollama not installed, stopping"; exit 1 }

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
    for ($i = 1; $i -le 100; $i++) {
        Log "Pulling $m (attempt $i)..."
        & $ollamaExe pull $m 2>&1 | Select-Object -Last 1 | Out-File -Append $log
        if ($LASTEXITCODE -eq 0) { Log "DONE $m"; break }
        Start-Sleep -Seconds 5
    }
}

# --- 4. Whisper large-v3-turbo (CTranslate2 format for faster-whisper) ------
if ($uv) {
    foreach ($repo in @("mobiuslabsgmbh/faster-whisper-large-v3-turbo")) {
        for ($i = 1; $i -le 100; $i++) {
            Log "Downloading $repo (attempt $i)..."
            & $uv tool run --from huggingface_hub hf download $repo 2>&1 | Select-Object -Last 1 | Out-File -Append $log
            if ($LASTEXITCODE -eq 0) { Log "DONE $repo"; break }
            Start-Sleep -Seconds 5
        }
    }
} else {
    Log "ERROR: uv missing, skipped Whisper download"
}

Log "=== setup finished ==="
& $ollamaExe list *>> $log
