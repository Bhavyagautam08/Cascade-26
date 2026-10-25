# Build plan (stages)

Each stage ends with something demoable. Don't start polish before stage 5 works.
Architecture details: [`ARCHITECTURE.md`](ARCHITECTURE.md).

| Stage | Goal | Done when | Owner | Status |
|---|---|---|---|---|
| 0 | Setup on the new laptop(s): [`SETUP.md`](SETUP.md) | `/health` → `llm_ready: true`; `uv run pytest -q` green | everyone | ✅ GPU laptop (RTX 4060) done; other laptops todo |
| 1 | Bake-off: Whisper small on 5 noisy clips; qwen3-vl:4b-instruct on 3 slips | Models chosen, prompts tuned, mic threshold calibrated | perception | 🟡 models chosen + prompts tuned on typed/synthetic input; real Hinglish clips + real slip photos todo |
| 2 | Always-on mic → Whisper → extractor → ledger | Speak a sentence, entry appears in UI | perception | 🟡 clip → Whisper (GPU) → LLM → ledger verified; mic opens and hears the room; live spoken test todo |
| 3 | Slip reading + confirm screen | Photo → lines → confirmed → posted | perception + UI | 🟡 verified with a generated bill image (supplier, total, normalised names); real photos todo |
| 4 | Fusion: voice/SMS/tally counted once; credit conflicts → suspense | Tests pass | ledger | ✅ done |
| 5 | Inference: recipe (NNLS), loss split, Monte Carlo profit range | Tests pass, `/ledger/summary` | ledger/maths | ✅ done incl. UI |
| 6 | 3-device sync over LAN + hostile clock demo | Any merge order = same balanced ledger on all 3 | sync | 🟡 3 real servers on one laptop: identical books, 1970 clock harmless, wrong key → 401; multi-laptop run todo |
| 7 | Dashboard: live transcript, profit range, credit book, suspense, loss split, sync panel, Lexicon Drop editor | Full offline run-through (Wi-Fi off) | UI | 🟡 builds, serves, talks to the real backend, no external URLs; offline run-through todo |
| 8 | Freeze, rehearse 3×, slides, backup demo data | — | everyone | ⏳ todo |

## Suggested split (4 people)

- **Perception** — stages 1–3 (on the GPU laptop)
- **Ledger / maths** — stage 4–5 polish, seeded demo data, explanations judges can read
- **Sync** — stage 6 on 3 laptops, hostile-clock demo
- **UI / demo** — stages 3 (UI) and 7, demo script, slides
