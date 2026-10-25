# Optional helper for a fresh clone on Windows: Python deps, UI deps, the Whisper "small" model, and a
# check of Ollama. It never installs Ollama or pulls Ollama models (see docs/SETUP.md).
# Safe to re-run: every step skips what already exists, and retries on flaky networks.
#
# Nothing heavy goes into the project folder:
#   Python environment -> %LOCALAPPDATA%\cascade\backend-venv   (user variable UV_PROJECT_ENVIRONMENT)
#   Python packages    -> uv's own cache in %LOCALAPPDATA%\uv
#   Whisper small      -> the Hugging Face cache in %USERPROFILE%\.cache\huggingface
#   Node packages      -> frontend\node_modules (Node only finds packages there; npm's cache stays in %LOCALAPPDATA%)
#
#   powershell -ExecutionPolicy Bypass -File scripts\setup_models.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\setup_models.ps1 -SkipWhisper    # deps only
#
# Log: %LOCALAPPDATA%\cascade\setup.log
param([switch]$SkipWhisper)

$ErrorActionPreference = "Continue"
$repo = Split-Path $PSScriptRoot -Parent
$home_dir = Join-Path $env:LOCALAPPDATA "cascade"
New-Item -ItemType Directory -Force $home_dir | Out-Null
$log = Join-Path $home_dir "setup.log"

function Log($msg) {
    $line = "[{0}] {1}" -f (Get-Date -Format "HH:mm:ss"), $msg
    Add-Content -Path $log -Value $line
    Write-Host $line
}

function Retry([string]$what, [scriptblock]$action, [int]$tries = 20) {
    for ($i = 1; $i -le $tries; $i++) {
        Log "$what (attempt $i)"
        & $action
        if ($LASTEXITCODE -eq 0) { Log "DONE $what"; return $true }
        Start-Sleep -Seconds 5
    }
    Log "FAILED $what"; $script:failed += $what; return $false
}
$script:failed = @()
$script:missing = @()
Log "=== setup started (repo=$repo) ==="

# --- 1. uv (Python package manager) ------------------------------------------------------
$uv = (Get-Command uv -ErrorAction SilentlyContinue).Source
if (-not $uv) {
    Log "ERROR: uv not found. Install it from https://docs.astral.sh/uv/getting-started/installation/ and re-run."
    exit 1
}

# --- 2. Python environment outside the project ----------------------------------------------
# Stored with %LOCALAPPDATA% unexpanded, so the setting holds no fixed path.
$envKey = Get-Item HKCU:\Environment
if (-not $envKey.GetValue("UV_PROJECT_ENVIRONMENT")) {
    Set-ItemProperty HKCU:\Environment -Name UV_PROJECT_ENVIRONMENT -Value '%LOCALAPPDATA%\cascade\backend-venv' -Type ExpandString
    [Environment]::SetEnvironmentVariable("CASCADE_ENV_REFRESH", "1", "User")   # tell Windows the environment changed
    [Environment]::SetEnvironmentVariable("CASCADE_ENV_REFRESH", $null, "User")
    Log "set user variable UV_PROJECT_ENVIRONMENT=%LOCALAPPDATA%\cascade\backend-venv (open a new terminal to use it)"
}
$env:UV_PROJECT_ENVIRONMENT = [Environment]::ExpandEnvironmentVariables($envKey.GetValue("UV_PROJECT_ENVIRONMENT", '%LOCALAPPDATA%\cascade\backend-venv', 'DoNotExpandEnvironmentNames'))
Log "Python environment: $env:UV_PROJECT_ENVIRONMENT"

Push-Location (Join-Path $repo "backend")
Retry "uv sync (backend deps)" { & $uv sync --python 3.12 2>&1 | Select-Object -Last 2 | Out-File -Append $log } | Out-Null
Pop-Location

# --- 3. UI deps -------------------------------------------------------------------------
if (Get-Command npm -ErrorAction SilentlyContinue) {
    Push-Location (Join-Path $repo "frontend")
    Retry "npm install (frontend)" { npm install --no-audit --no-fund 2>&1 | Select-Object -Last 2 | Out-File -Append $log } | Out-Null
    Pop-Location
} else { Log "MISSING: Node.js - install from https://nodejs.org/en/download"; $script:missing += "Node.js" }

# --- 4. Whisper small into the user's Hugging Face cache ----------------------------------
# Same repo and files faster-whisper itself fetches for "small", so the app finds it offline later.
if (-not $SkipWhisper) {
    Push-Location (Join-Path $repo "backend")
    Retry "whisper small" {
        & $uv run python -c "from huggingface_hub import snapshot_download as d; print(d('Systran/faster-whisper-small', allow_patterns=['config.json','preprocessor_config.json','model.bin','tokenizer.json','vocabulary.*']))" 2>&1 | Select-Object -Last 1 | Out-File -Append $log
    } | Out-Null
    Pop-Location
}

# --- 5. Ollama: check only (install it and download the model yourself, see docs/SETUP.md) ----
$llm = "qwen3-vl:4b-instruct"
$envFile = Join-Path $repo "backend\.env"
if (Test-Path $envFile) {
    $line = Select-String -Path $envFile -Pattern '^\s*LLM_MODEL\s*=\s*(.+)$' | Select-Object -First 1
    if ($line) { $llm = $line.Matches[0].Groups[1].Value.Trim() }
}
if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
    Log "MISSING: Ollama - install from https://ollama.com/download (the app still works without it, using the rule parser)"
    $script:missing += "Ollama"
} else {
    try {
        $tags = Invoke-RestMethod "http://127.0.0.1:11434/api/tags" -TimeoutSec 5
        if ($tags.models.name -contains $llm) { Log "Ollama running, model $llm present" }
        else { Log "MISSING: Ollama model $llm - see https://ollama.com/library/qwen3-vl"; $script:missing += "model $llm" }
    } catch {
        Log "Ollama is installed but not running - start Ollama from the Start menu, then re-run to check the model"
        $script:missing += "Ollama running"
    }
}

if ($script:failed.Count) { Log ("=== setup INCOMPLETE - failed: " + ($script:failed -join "; ") + " ==="); exit 1 }
if ($script:missing.Count) { Log ("=== setup done, still missing: " + ($script:missing -join "; ") + " ==="); exit 0 }
Log "=== setup finished: everything present ==="
