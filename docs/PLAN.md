# Build plan (stages)

Each stage ends with something demoable. Don't start polish before stage 5 works.

| Stage | Goal | Done when | Owner |
|---|---|---|---|
| 0 | Setup: models, Ollama, uv env on every laptop | `GET /health` lists `qwen3-vl:4b`; whisper loads on GPU | everyone |
| 1 | Bake-off: whisper turbo vs Tara, qwen3-vl:4b vs gemma3:4b on 5 noisy clips + 3 slips | Models chosen, prompts tuned | perception |
| 2 | Always-on mic: VAD → whisper → extractor → ledger | Speak a sentence, entry appears in UI | perception |
| 3 | Slip reading with confirm-low-confidence UI | Photo → lines → confirmed → posted | perception + UI |
| 4 | Fusion: voice + SMS + tally of the same sale counted once; credit conflicts → suspense | Triple evidence = 1 event | ledger |
| 5 | Inference: recipe per plate (NNLS), loss split, Monte Carlo profit range | Dashboard shows p10/p50/p90 profit | ledger/maths |
| 6 | 3-device sync over LAN, hostile clock demo (set one laptop to 1970) | Merge in any order = same ledger, still balanced | sync |
| 7 | Dashboard polish + Lexicon Drop editor + demo script | Full run-through offline (Wi-Fi off) | UI |
| 8 | Freeze, rehearse 3×, slides | — | everyone |
