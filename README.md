# Cascade '26 — The Invisible Worker (PS 1.2)

A fully offline, on-device probabilistic ledger for street vendors. It listens to shop talk, reads
wholesale slips and SMS, takes morning and evening stock counts, and reconstructs a balanced
double-entry ledger with ranges instead of point guesses. The family's devices sync peer-to-peer
without a server, count a trade heard by two phones once, and survive broken clocks.

- **Set up a laptop:** [docs/SETUP.md](docs/SETUP.md) — install 4 programs, then
  `scripts\setup_device.ps1 -DeviceId phone-2 -SyncKey <family key> -Peers http://<ip>:8000` and `scripts\start.ps1`
- **How it works, trade-offs, constraints:** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- **What's done, what's left:** [docs/PLAN.md](docs/PLAN.md)

| Role | Model |
|---|---|
| Speech-to-text | faster-whisper `small` (GPU, or CPU) |
| Text, slips, stock counts | Ollama `qwen3-vl:4b-instruct` |
| No-model fallback | lexicon-driven rule parser |

## Repo layout

| Path | What lives there |
|---|---|
| `backend/app/perception/` | mic, speech-to-text, slip reading, text → events, SMS, lexicon |
| `backend/app/inventory.py` | morning / evening stock counts |
| `backend/app/ledger/` | events, store, identity, double-entry, business days, fusion, inference |
| `backend/app/sync/` | protocol, background engine, LAN transport, vector clocks |
| `backend/app/main.py` | HTTP API for the dashboard and the peers |
| `backend/data/lexicon.json` | vocabulary and units, editable live (Lexicon Drop) |
| `frontend/` | React + Vite dashboard |
| `scripts/` | `setup_device.ps1`, `start.ps1`, `family.ps1` (3 phones on one laptop), `run_device.ps1`, `seed_demo.py`, `setup_models.ps1` |
| `eval/` | real samples, evaluation scripts, reports |

Tests: `cd backend; uv run pytest -q`. Nothing calls the internet at runtime.
