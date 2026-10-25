# Setup — any Windows laptop, from a fresh clone

Follow this top to bottom and the whole project runs: ledger, dashboard, family sync, speech-to-text
and the language model. Nothing here depends on another computer's folders or paths.

Design notes: [`ARCHITECTURE.md`](ARCHITECTURE.md).

---

## 1. Download and install these

| What | Why | Download page |
|---|---|---|
| Git | get the code | https://git-scm.com/downloads |
| Node.js 20 or newer (LTS) | runs the dashboard | https://nodejs.org/en/download |
| uv | installs the Python backend and its packages (it fetches Python 3.12 itself) | https://docs.astral.sh/uv/getting-started/installation/ |
| NVIDIA graphics driver | GPU speech-to-text (skip on laptops without an NVIDIA GPU) | https://www.nvidia.com/en-us/drivers/ |
| Ollama | runs the language model locally | https://ollama.com/download |

Notes:
- **Python:** not needed separately (uv brings it). Only if you want your own: https://www.python.org/downloads/ (3.12).
- **CUDA toolkit:** not needed. The CUDA libraries come as Python packages in step 3.
- **Ollama:** install it normally and start it from the Start menu. Don't set `OLLAMA_MODELS` or any
  model folder: Ollama keeps models in its own default place, and the app only talks to Ollama's
  local API (`http://127.0.0.1:11434`).
- **The language model is optional for most of the app.** Without Ollama, typed text, SMS and voice
  still become ledger entries through the rule parser.

## 2. Download the models

### Language model (Ollama): `qwen3-vl:4b-instruct`, about 3.1 GB

Model page: https://ollama.com/library/qwen3-vl

Ollama downloads models itself; the website has no download button. Open the **Ollama app**, pick
`qwen3-vl:4b-instruct` in its model selector and send any message, and the app downloads it. If your Ollama
version has no model selector, the only alternative is the one command `ollama pull qwen3-vl:4b-instruct`.

Using a different model you already have? Put its name in `LLM_MODEL` in `backend\.env` (step 4).

### Speech-to-text: Whisper `small` (~0.5 GB), the only speech model

Model page: https://huggingface.co/Systran/faster-whisper-small

It is stored in the standard Hugging Face cache in your user profile
(`%USERPROFILE%\.cache\huggingface`), never in the project. `scripts\setup_models.ps1` downloads it
there; otherwise the backend downloads it there on first start (needs internet that one time) and
uses the cached copy offline from then on.

## 3. Get the code and install the packages

Download the project from https://github.com/Bhavyagautam08/Cascade-26 (green **Code** button →
**Download ZIP**, or clone it with Git). Then, in a terminal inside the project folder:

Easiest: run the helper once. It installs everything below into your user profile, not the project:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup_models.ps1
```

| What | Where it goes |
|---|---|
| Python environment | `%LOCALAPPDATA%\cascade\backend-venv` (the script sets the user variable `UV_PROJECT_ENVIRONMENT` to this, written with `%LOCALAPPDATA%`) |
| Python packages (~2.4 GB incl. CUDA libraries) | uv's cache, `%LOCALAPPDATA%\uv` |
| Whisper `small` | `%USERPROFILE%\.cache\huggingface` |
| Dashboard packages | `frontend\node_modules` (Node only looks there; npm's download cache is in `%LOCALAPPDATA%\npm-cache`) |

By hand instead: set the user variable `UV_PROJECT_ENVIRONMENT` to `%LOCALAPPDATA%\cascade\backend-venv`,
open a new terminal, then `cd backend; uv sync --python 3.12` and `cd ..\frontend; npm install`.
Without that variable uv puts the environment in `backend\.venv` (git-ignored; it still works).

## 4. Configure this device

Copy `.env.example` to `backend\.env`. The defaults work; change only what applies:

| Setting | Set it to |
|---|---|
| `DEVICE_ID` | unique per device: `phone-1`, `phone-2`, `phone-3` |
| `MODEL_MODE` | `real` (models installed) or `demo` (labelled stand-ins, no models needed) |
| `LLM_MODEL` | `qwen3-vl:4b-instruct`, or another Ollama model you have |
| `MIC_ENABLED` | `true` on the vendor's main device |
| `SYNC_KEY` | the same secret on every family device (empty = anyone on the Wi-Fi can sync) |
| `PEERS` | the other devices, e.g. `http://192.168.1.12:8000,http://192.168.1.13:8000` |
| `WHISPER_DEVICE` | `cpu` on a laptop without an NVIDIA GPU |

Leave `OLLAMA_HOST=http://127.0.0.1:11434` unless Ollama really runs elsewhere.

## 5. Run

```powershell
cd backend;  uv run uvicorn app.main:app --host 0.0.0.0 --port 8000
cd frontend; npm run dev                  # then open http://localhost:5173
```

## 6. Check it works

Open http://localhost:8000/health in a browser:

| Field | Good | If not |
|---|---|---|
| `llm_ready` | `true` | `llm_problem` says exactly what's missing: Ollama not running, or the model not downloaded |
| `asr.source` | a folder under `%USERPROFILE%\.cache\huggingface` | empty until Whisper has loaded; see `asr.error` |
| `asr.fallback` | `false` | `true` = the GPU failed, so `small` runs on the CPU (slower); see `asr.error` |
| `mic_listening` | `true` when `MIC_ENABLED=true` | `mic.last_error` says why |

Tests: `cd backend; uv run pytest -q` → all pass.

The first transcription after start takes ~20 s (GPU warm-up, done in the background at startup);
after that about 1 s per sentence.

---

## Known problems and fixes

| Symptom | Cause | Fix |
|---|---|---|
| `llm_problem`: Ollama is not running | Ollama closed | start Ollama from the Start menu |
| `llm_problem`: Ollama has no model … | model not downloaded | step 2, or set `LLM_MODEL` to a model you have |
| LLM returns empty output (`Invalid JSON … input_value=''`), each call takes a minute | `LLM_MODEL` is a "thinking" model: the plain `qwen3-vl:4b` tag is the Thinking variant, ignores `think=False` and reasons until the output limit | use `qwen3-vl:4b-instruct` (`ollama show <model>` must not list renderer `qwen3-vl-thinking`) |
| `An Application Control policy has blocked this file` | Windows Smart App Control blocks some unsigned files | handled in code (Whisper works without PyAV; uploaded clips must then be WAV). Don't switch Smart App Control off: it can't be turned back on without reinstalling Windows |
| `Library cublas64_12.dll is not found` | CUDA libraries not on the search path | handled in code; if it persists, re-run `uv sync` |
| `ollama ps` shows a CPU/GPU split, very slow | not enough free graphics memory | close other GPU apps; an 8 GB GPU fits Whisper + the 4B model |
| Sync says `401` | `SYNC_KEY` differs between devices | set the same key on all of them |

## Three devices on one laptop (sync and broken-clock demo)

```powershell
powershell -File scripts\run_device.ps1 -Id phone-1 -Port 8000 -Peers http://127.0.0.1:8001,http://127.0.0.1:8002
powershell -File scripts\run_device.ps1 -Id phone-2 -Port 8001 -Peers http://127.0.0.1:8000,http://127.0.0.1:8002
powershell -File scripts\run_device.ps1 -Id phone-3 -Port 8002 -Peers http://127.0.0.1:8000,http://127.0.0.1:8001 -HostileClock 1970
```

Across laptops, use their Wi-Fi addresses in `-Peers` and allow port 8000 through Windows Firewall
the first time Windows asks.
