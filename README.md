# Cascade '26 — The Invisible Worker (PS 1.2)

A fully offline, on-device probabilistic ledger for street vendors. It listens to shop talk, reads
wholesale slips, and reconstructs a double-entry ledger with ranges instead of point guesses.
Three family devices sync peer-to-peer without a server, and survive broken clocks.

## Layers

```
[Perception]   mic (always on) / slip photo / SMS / tally  ->  candidate events + confidence
               Silero VAD -> faster-whisper (large-v3-turbo) -> local LLM via Ollama (JSON schema)
[Ledger]       append-only event log -> evidence fusion -> double-entry postings
               -> recipe inference / loss attribution / credit reconciliation -> Monte Carlo ranges
[Sync]         grow-only event set (CRDT) + vector clocks; wall clocks are stored but never trusted
```

Nothing calls the internet at runtime. Models are downloaded once during setup ([docs/SETUP.md](docs/SETUP.md)).

**Full design, exact models, offline matrix, API, setup and demo checklist:** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
· **Stage plan + status:** [docs/PLAN.md](docs/PLAN.md)
· **Setup on any laptop (download links, configuration, known fixes):** [docs/SETUP.md](docs/SETUP.md)

| Role | Model |
|---|---|
| Speech-to-text | faster-whisper `large-v3-turbo` (int8_float16, CUDA); CPU fallback `small` |
| VAD | Silero (bundled in faster-whisper) |
| Text → events + slip reading | Ollama `qwen3-vl:4b` (bake-off rival `gemma3:4b`) |
| No-model fallback | lexicon-driven rule parser |

## Repo layout

| Path | What lives there |
|---|---|
| `backend/app/perception/` | mic + VAD, speech-to-text, slip reading, text → events, lexicon |
| `backend/app/ledger/` | event model, SQLite store, double-entry, fusion, inference |
| `backend/app/sync/` | vector clocks, merge, transports |
| `backend/app/main.py` | FastAPI app (HTTP API for the UI and for peer sync) |
| `backend/data/lexicon.json` | vocabulary + units; editable at runtime (Lexicon Drop) |
| `frontend/` | React + Vite dashboard |
| `scripts/` | setup + dev helpers |

## Setup (Windows)

Full guide with download links: **[docs/SETUP.md](docs/SETUP.md)**. In short: install Git, Node.js, uv and
Ollama (standard installers, no special model folder), download `qwen3-vl:4b` in Ollama, then:

```powershell
cd backend;  uv sync --python 3.12
cd frontend; npm install
copy .env.example backend\.env          # set DEVICE_ID, MODEL_MODE, SYNC_KEY, PEERS
cd backend;  uv run uvicorn app.main:app --host 0.0.0.0 --port 8000
cd frontend; npm run dev                 # http://localhost:5173
```

Run a second/third "device" on another laptop with `DEVICE_ID=phone-2`, or all three on one laptop with
`scripts\run_device.ps1` (see the header of that script; `-HostileClock 1970` plays the broken phone).

No models yet? Set `MODEL_MODE=demo` in `backend\.env`: the full UI and ledger run on labelled stand-ins.

## Offline check

Disconnect Wi-Fi, then start the backend and UI. Everything must still work. `GET /health` reports
whether Ollama and the Whisper model are reachable locally.
