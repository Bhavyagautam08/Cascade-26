# Build plan (stages)

Each stage ends with something demoable. Don't start polish before stage 5 works.
Architecture details: [`ARCHITECTURE.md`](ARCHITECTURE.md).

| Stage | Goal | Done when | Owner | Status |
|---|---|---|---|---|
| 0 | Setup on the new laptop(s): `scripts\setup_models.ps1` | `/health` → `llm_ready: true`; `uv run pytest -q` green | everyone | ⏳ todo |
| 1 | Bake-off: whisper turbo (vs Tara only if needed), qwen3-vl:4b vs gemma3:4b on 5 noisy clips + 3 slips | Models chosen, prompts tuned, mic threshold calibrated | perception | ⏳ todo |
| 2 | Always-on mic → Whisper → extractor → ledger | Speak a sentence, entry appears in UI | perception | 🟡 code written, untested with models |
| 3 | Slip reading + confirm screen | Photo → lines → confirmed → posted | perception + UI | 🟡 backend done, UI todo |
| 4 | Fusion: voice/SMS/tally counted once; credit conflicts → suspense | Tests pass | ledger | ✅ done |
| 5 | Inference: recipe (NNLS), loss split, Monte Carlo profit range | Tests pass, `/ledger/summary` | ledger/maths | ✅ done (UI todo) |
| 6 | 3-device sync over LAN + hostile clock demo | Any merge order = same balanced ledger on all 3 | sync | 🟡 protocol + tests done, multi-laptop run + UI todo |
| 7 | Dashboard: live transcript, profit range, credit book, suspense, loss split, sync panel, Lexicon Drop editor | Full offline run-through (Wi-Fi off) | UI | ⏳ todo |
| 8 | Freeze, rehearse 3×, slides, backup demo data | — | everyone | ⏳ todo |

## Suggested split (4 people)

- **Perception** — stages 1–3 (on the GPU laptop)
- **Ledger / maths** — stage 4–5 polish, seeded demo data, explanations judges can read
- **Sync** — stage 6 on 3 laptops, hostile-clock demo
- **UI / demo** — stages 3 (UI) and 7, demo script, slides
