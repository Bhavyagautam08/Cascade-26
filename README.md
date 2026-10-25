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

Nothing calls the internet at runtime. Models are downloaded once by `scripts/setup_models.ps1`.

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

```powershell
# 1. Models + Ollama + uv (downloads ~8 GB to E:\ai). Watch: Get-Content E:\ai\logs\setup.log -Wait
powershell -ExecutionPolicy Bypass -File scripts\setup_models.ps1

# 2. Backend
cd backend
uv sync
uv run uvicorn app.main:app --reload --port 8000

# 3. Frontend
cd frontend
npm install
npm run dev
```

Run a second/third "device" on another laptop (or another port) with `DEVICE_ID=phone-2`; see `.env.example`.

## Offline check

Disconnect Wi-Fi, then start the backend and UI. Everything must still work. `GET /health` reports
whether Ollama and the Whisper model are reachable locally.
