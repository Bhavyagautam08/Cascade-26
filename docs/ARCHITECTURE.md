# Architecture — The Invisible Worker (Cascade '26, PS 1.2)

> A fully offline, on-device probabilistic ledger engine for a street vendor. It turns noisy,
> contradictory, multi-channel evidence (shop talk, stained wholesale slips, SMS, handwritten tallies)
> into a balanced double-entry ledger with **ranges and confidence, never blind point guesses**, and
> keeps three family devices in sync over brief peer-to-peer contact while surviving hostile clocks.

Status tags used below: **[CONFIRMED]** decided and built · **[DECIDED]** decided, not yet built ·
**[OPEN]** waiting on bake-off or organisers.

---

## 1. Requirements → where they are handled

| # | Requirement (from the PS) | Plain meaning | Handled in | Status |
|---|---|---|---|---|
| R1 | Passively accept chaotic, contradictory inputs | Always-on mic, slip photos, SMS, tallies | `perception/` | mic + text [CONFIRMED], slip [DECIDED] |
| R2 | Reconstruct a double-entry ledger | Every event balances; books always balance | `ledger/events.py`, `doubleentry.py` | [CONFIRMED] |
| R3 | Ranges and confidence intervals | p10/p50/p90, never a single number | `ledger/inference.py` | [CONFIRMED] |
| R4 | Zero-shot recipe inference | Grams per plate from burn rates, no BOM | `inference.recipe_per_plate` (NNLS) | [CONFIRMED] |
| R5 | Loss attribution | Spoilage / theft / personal as a distribution | `inference.attribute_loss` | [CONFIRMED] |
| R6 | Cross-modal fusion | Same event via voice + SMS + tally counts once | `ledger/fusion.py` | [CONFIRMED] |
| R7 | Dynamic linguistics, mid-event Lexicon Drop | New words/units take effect live | `perception/lexicon.py`, `data/lexicon.json` | [CONFIRMED] |
| R8 | 3 family devices, CRDT sync on brief reconnect | Merge logs with no server | `sync/`, `ledger/store.py` | protocol [CONFIRMED], UI [DECIDED] |
| R9 | Hostile clocks (1970 / jumps) | Wall time never orders history | vector clocks, `causal_order` | [CONFIRMED] |
| R10 | Contradictory credit claims, balance kept | ₹40 vs ₹400 → suspense account | `fusion.fuse` | [CONFIRMED] |

Evaluation chain from the PS, and where each link is computed:

```
Raw Material Burn ──► Inferred Wastage ──► Reconciled Credit ──► True Accrual Profit
recipe_per_plate()    unexplained burn +    fuse(): duplicates,   profit_range(): Monte Carlo
(NNLS)                attribute_loss()      suspense, receivables  incl. bad-debt risk
```

---

## 2. The offline requirement

### What the PS says (verbatim)

| # | Quote | Type | Consequence |
|---|---|---|---|
| O1 | "Design a **fully offline, on-device** probabilistic ledger engine" | Explicit | No internet at runtime. No cloud APIs. |
| O2 | "Most accounting software assumes … **reliable cloud connectivity**" | Implied | Cloud dependence is the thing being criticised. |
| O3 | "passively accept … ambient audio … oil-stained wholesale slip" | Implied by O1 | Speech-to-text and slip reading must run **locally**. |
| O4 | "three devices … briefly reconnect via **Bluetooth** … CRDT sync" | Explicit | Devices are normally disconnected; peer-to-peer, no server. |
| O5 | "survive hostile clocks (devices randomly resetting to 1970…)" | Explicit | No trusted time source. |

### Our interpretation **[DECIDED]**

- **Runtime** is fully offline. **Setup** (installing packages, downloading model weights) may use internet.
- A **laptop counts as "the device"** (team decision). Each laptop = one family phone.
- **Sync transport** is abstracted. Demo over local Wi-Fi/hotspot LAN; real Bluetooth is a stretch goal.
- **No component is allowed to call a remote API at runtime.** Claude Code is a development tool only and is not part of the product.

### Still to confirm with organisers **[OPEN]**

1. Is a laptop acceptable as "on-device"? (We assume yes.)
2. Is a simulated / LAN sync acceptable instead of real Bluetooth?
3. Will judges provide their own audio clips / slip photos? Format?
4. How exactly is the "Lexicon Drop" delivered (file, typed words, spoken)?

---

## 3. System overview

Every device runs the **same backend**. A device without models still works: it falls back to the
rule parser and manual entry, and it still syncs.

```
┌──────────────────────────────── ONE DEVICE (laptop = family phone) ─────────────────────────────────┐
│                                                                                                     │
│  INPUTS                     PERCEPTION                                   LEDGER                      │
│                                                                                                     │
│  Mic (always on) ──► MicListener ──► faster-whisper ──┐                                             │
│  16 kHz mono        energy cut       large-v3-turbo   │ text                                        │
│                     at pauses        + Silero VAD     │                                             │
│                                      + lexicon hotwords│                                            │
│                                                       ▼                                             │
│  SMS / tally / typed ───────────────────────────► Extractor ──► CandidateEvent[] ──► postings_for() │
│                                                   qwen3-vl:4b     (kind, item, qty,      │          │
│                                                   JSON schema     unit, amount, party,   ▼          │
│                                                   ── fallback ──► confidence)       EventStore      │
│                                                   rules.parse()                     (SQLite,        │
│                                                   (lexicon-driven)                   append-only)   │
│  Slip photo ──► SlipReader (qwen3-vl:4b) ──► lines + confidence ──► vendor confirms ──┘   │         │
│                                                                                           ▼         │
│                                                         fuse(): duplicates once, disputes→suspense  │
│                                                                           │                         │
│                                                         inference: recipe · loss split · profit     │
│                                                                           │                         │
│  React dashboard ◄──────────── FastAPI (localhost:8000) ◄─────────────────┘                         │
│                                       ▲                                                             │
└───────────────────────────────────────┼─────────────────────────────────────────────────────────────┘
                                        │ /sync/frontier, /sync/pull, /sync/push  (LAN; BLE later)
                         ┌──────────────┴──────────────┐
                    phone-2 (laptop)              phone-3 (laptop)
```

### Data flows

1. **Voice:** mic → cut at 0.8 s silence (max 20 s) → Whisper (+Silero VAD, +hotwords from lexicon)
   → drop known hallucinations → text → extractor → events. **Raw audio is discarded** after transcription.
2. **Slip:** photo → `POST /ingest/slip` → vision model returns lines with confidence → UI highlights
   low-confidence lines → vendor edits/confirms → `POST /ingest/slip/confirm` → purchase events.
3. **SMS / tally / typed:** `POST /ingest/text` with `source=sms|tally|manual` → extractor → events.
4. **Read path:** all events → `fuse()` (pure, deterministic view) → balances, profit range, conflicts.
5. **Sync:** `POST /sync/now` → for each peer: pull what I'm missing, push what they're missing.

---

## 4. Exact models **[DECIDED]**

| Role | Model (exact ID) | Source | Format / runtime | Download | VRAM (est.) | Settings | Fallback |
|---|---|---|---|---|---|---|---|
| **Speech-to-text (primary)** | `large-v3-turbo` → HF `mobiuslabsgmbh/faster-whisper-large-v3-turbo` | Hugging Face | CTranslate2 / faster-whisper | ~1.6 GB | ~1.5–2 GB | `device=cuda`, `compute_type=int8_float16`, `beam_size=5`, `vad_filter=True`, `condition_on_previous_text=False`, `hotwords=<lexicon>` | CPU model below |
| **Speech-to-text (CPU fallback)** | `small` → HF `Systran/faster-whisper-small` | Hugging Face | CTranslate2 / faster-whisper | ~0.5 GB | 0 (CPU) | `device=cpu`, `compute_type=int8` | typed input |
| **Voice activity detection** | Silero VAD (bundled inside faster-whisper) | ships with `faster-whisper` | ONNX on CPU | 0 (bundled) | 0 | via `vad_filter=True` | energy gate in `mic.py` |
| **Text → ledger events** | `qwen3-vl:4b` | Ollama library | GGUF Q4 / Ollama | ~3.3 GB | ~4–5 GB | `temperature=0`, `format=<pydantic JSON schema>` | `rules.parse()` (no model) |
| **Slip reading (vision)** | `qwen3-vl:4b` (same model, loaded once) | Ollama library | GGUF Q4 / Ollama | shared | shared | `temperature=0`, `format=Slip schema` | manual entry of lines |
| **Bake-off alternative (optional)** | `gemma3:4b` | Ollama library | GGUF Q4 / Ollama | ~3.3 GB | ~4–5 GB | same as above | — |
| **Hinglish ASR alternative (only if turbo fails bake-off)** | `Trelis/tara` (Whisper large-v3 fine-tune, Apache-2.0) | Hugging Face | Transformers (needs PyTorch) or CTranslate2 conversion | ~3–4 GB | ~3.5–4 GB fp16 | `<\|mixedcode\|>` mode | turbo |

**Why these:** one 4B vision-language model does both text extraction and slip reading, so only one
LLM sits in VRAM. Turbo + qwen3-vl:4b ≈ 6–7 GB, which fits an 8 GB laptop GPU; 7–8B LLMs do not fit
next to Whisper. Gemma 3n would do audio+image in one model, but Ollama exposes it as text-only, so it
is not used. Sizes/VRAM are estimates from model pages and community guides; verify on the target laptop.

### Hardware budget (per device that runs models)

| Resource | Need | Notes |
|---|---|---|
| GPU | NVIDIA, ≥ 8 GB VRAM (tested target: RTX 4060 Laptop 8 GB) | Whisper ~2 GB + qwen3-vl:4b ~4–5 GB |
| RAM | 16 GB | Keep browser tabs low; avoid models that spill out of VRAM |
| Disk | ~10 GB free for models + ~3 GB for Python/Node deps | Put models on a data drive via `-Root` |
| OS | Windows 10/11 x64 | Scripts are PowerShell |

Devices **without** a GPU still run everything except fast speech/vision (CPU Whisper `small` works, slower).

---

## 5. Tech stack **[CONFIRMED]**

| Layer | Tech | Version | Why | Runtime internet |
|---|---|---|---|---|
| Backend | Python | 3.12 (3.11–3.13 supported) | All ML libs have wheels; 3.14 is too new | no |
| Env manager | uv | latest | Fast, reproducible (`uv.lock`) | no |
| API | FastAPI + Uvicorn | ≥ 0.115 / ≥ 0.30 | Simple, typed, async | no |
| Models/validation | Pydantic v2 + pydantic-settings | ≥ 2.8 | JSON schema for LLM output + validation | no |
| ASR | faster-whisper (CTranslate2) | ≥ 1.1 | 4× faster than openai-whisper, int8 on GPU, bundles Silero VAD | no |
| CUDA libs | nvidia-cublas-cu12, nvidia-cudnn-cu12 (9.x) via pip | — | Needed by CTranslate2 on Windows | no |
| Mic | sounddevice | ≥ 0.5 | Capture in Python: no browser permission prompts, works when tab unfocused | no |
| LLM runtime | Ollama (+ `ollama` Python client) | latest / ≥ 0.4 | One-command model pulls, structured outputs, GPU offload | no (localhost) |
| Maths | NumPy + SciPy | ≥ 1.26 / ≥ 1.13 | `nnls`, Dirichlet, Monte Carlo | no |
| Storage | SQLite (stdlib) | — | One file per device, zero setup | no |
| Peer sync | httpx over LAN | ≥ 0.27 | Transport-agnostic protocol | LAN only |
| UI | React 18 + Vite 5 + TypeScript | 18.3 / 5.4 / 5.5 | Fast dev server; all assets local, no CDN | no |
| Tests | pytest | ≥ 8 | — | no |

**Not used (deliberately):** cloud LLM/ASR APIs, vector DBs, RAG, agents frameworks, model training,
Docker, native Android, Automerge (our event-set CRDT is simpler to explain and test).

---

## 6. Component design

### 6.1 Perception (`backend/app/perception/`)

| File | Responsibility | Key rules |
|---|---|---|
| `mic.py` | Always-on capture, cut into utterances | 16 kHz mono, 32 ms blocks, cut after 0.8 s quiet or 20 s; raw audio never stored |
| `asr.py` | faster-whisper wrapper | VAD on, no conditioning on previous text, hotwords from lexicon, blocklist of known hallucinations ("thanks for watching"), confidence from avg log-prob × (1 − no_speech_prob) |
| `extractor.py` | Text → `Extraction{is_transaction, events[]}` via Ollama | System prompt: most talk is chatter; never invent amounts; normalise via lexicon. Output constrained by JSON schema, then re-validated by Pydantic |
| `rules.py` | Deterministic parser, no model | Clause split on punctuation/`aur`/`phir`; number before a unit = quantity, others = money; verb → kind; alias/`X ji ka` → party; sale priced from lexicon if amount missing (confidence 0.6) |
| `vision.py` | Slip photo → `Slip{supplier, lines[{item, qty, unit, amount, confidence}], total}` | Unreadable → null + low confidence; never guess numbers |
| `lexicon.py` | Runtime vocabulary | Reloads when the file changes; `POST /lexicon` adds entries live; feeds both Whisper hotwords and the LLM prompt |

**Lexicon Drop** = editing `data/lexicon.json` (or `POST /lexicon`). Sections: `items`, `units`
(with conversion `factor`), `aliases`, `verbs`, `numbers`, `prices`, `perishable`. No retraining.

### 6.2 Ledger (`backend/app/ledger/`)

**Event** (immutable, one per fact):

| Field | Type | Meaning |
|---|---|---|
| `id` | str | `"{device_id}:{seq}"` |
| `device_id`, `seq` | str, int | Per-device counter, never reused |
| `vclock` | {device: int} | What this device had seen when it created the event |
| `wall_time` | float \| null | **Untrusted**, display only |
| `kind` | enum | `purchase`, `sale`, `credit_given`, `credit_paid`, `expense`, `stock_count`, `adjustment` |
| `source` | enum | `voice`, `slip`, `sms`, `tally`, `manual` |
| `confidence` | 0..1 | From ASR/LLM/rules/vendor confirmation |
| `payload` | dict | item, qty, unit, party, amount_rupees, … |
| `postings` | [{account, amount}] | Integer **paise**; must sum to 0 (validated on construction) |
| `raw` | str | Transcript / OCR text it came from |
| `supersedes` | [id] | Human corrections |

**Chart of accounts:** `cash`, `inventory:<item>`, `receivable:<party>`, `revenue:sales`,
`expense:<what>`, `suspense`.

| Kind | Debit | Credit |
|---|---|---|
| purchase | `inventory:<item>` | `cash` |
| sale | `cash` | `revenue:sales` |
| credit_given (udhaar) | `receivable:<party>` | `revenue:sales` |
| credit_paid (jama) | `cash` | `receivable:<party>` |
| expense | `expense:<what>` | `cash` |

**SQLite schema** (`store.py`):

```sql
CREATE TABLE events (
  id        TEXT PRIMARY KEY,        -- device_id:seq
  device_id TEXT NOT NULL,
  seq       INTEGER NOT NULL,
  body      TEXT NOT NULL,           -- full Event JSON
  UNIQUE (device_id, seq)
);
```

Append-only: no UPDATE, no DELETE. Merge = `INSERT OR IGNORE`.

### 6.3 Fusion (`fusion.py`) — a pure, deterministic view

Computed on read from the synced event set, so every device gets the **same** answer and can never
create two different "merge" events for the same evidence.

- **Duplicates:** different sources, same `(kind, item, party)`, amount within 5 %, vector-clock sums
  within 6 → one fused event. Confidence = `1 − Π(1 − cᵢ)` (independent evidence).
- **Conflicting credit claims:** same party and kind, from **different devices**, **concurrent**
  vector clocks, different amounts → book the lower claim as certain, park the difference in
  `suspense`. Books stay balanced. A human resolution later is a new event that `supersedes` it.

### 6.4 Inference (`inference.py`)

| Function | Method | Output |
|---|---|---|
| `recipe_per_plate(burn, plates)` | Non-negative least squares per ingredient (`scipy.optimize.nnls`) | usage per plate, unexplained burn per day (wastage), residual SD |
| `attribute_loss(kg, covariates)` | Priors 0.5/0.2/0.3 (spoilage/theft/personal) × explainable multipliers (heat > 30 °C, perishable, unattended hours, family present); Dirichlet(α = p·20) for intervals | p, p10, p90, kg per cause + plain-language reasons |
| `profit_range(events)` | Monte Carlo (2000 draws, fixed seed): amounts wobble with SD 0.5·(1 − confidence); unsold stock ~ U(0, 0.3) of purchases; collection probability ~ Beta(8, 2) on receivables | p10/p50/p90 accrual profit + components + receivables |

`profit = revenue − cost of stock used − expenses − expected bad debt`

### 6.5 Sync (`sync/`) — CRDT over a swappable transport

- **Data type:** grow-only set of immutable events keyed by `(device_id, seq)` — merge is set union,
  so it is commutative, associative and idempotent (any order, any number of times → same state).
- **Protocol:** exchange frontiers `{device_id: max_seq}`, then send only missing events. Works over
  LAN HTTP now; a `BluetoothTransport` only needs to implement `exchange(store)`.
- **Clocks:** each event carries a vector clock. `causal_order()` sorts by vector-clock sum (a valid
  linear extension of happened-before) then `(device_id, seq)` — **wall time is never used**, so a
  device at 1970 or in 2099 cannot reorder or overwrite history.
- **Balance under merge:** every event balances on its own, so any union of events balances.

---

## 7. Internal API (`backend/app/main.py`, port 8000)

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/health` | — | device_id, ollama_models, llm_ready, mic_listening, events |
| GET | `/events` | — | all events in causal order |
| GET | `/ledger/balances` | — | balances (paise) over fused view, `balanced` |
| GET | `/ledger/summary` | — | balances, profit range, duplicates, conflicts |
| POST | `/ingest/text` | `{text, source, engine: auto\|llm\|rules}` | engine used, events created |
| GET | `/mic/recent` | — | last 20 transcripts (text only) |
| POST | `/ingest/slip` | multipart `file` | proposed lines (not posted) |
| POST | `/ingest/slip/confirm` | `{supplier, lines[]}` | purchase events created |
| GET / POST | `/lexicon` | `{section, key, value}` | full lexicon |
| POST | `/inference/recipe` | `{burn[][], plates[][]}` | recipe estimate |
| POST | `/inference/loss` | `{unexplained_kg, covariates}` | loss split |
| GET | `/sync/frontier` | — | `{device_id, frontier}` |
| POST | `/sync/pull` | `{frontier}` | events the caller lacks |
| POST | `/sync/push` | `{events[]}` | number added |
| POST | `/sync/now` | — | per-peer result |

Errors: model unavailable → `503` (only when `engine=llm`); `auto` silently falls back to rules.

---

## 8. Offline feasibility matrix

| Component | Internet at runtime? | Implementation | Prepared beforehand | Class | Risk → mitigation |
|---|---|---|---|---|---|
| UI | No | Vite dev server on localhost, no CDN assets | `npm install` | Offline after setup | CDN link sneaks in → offline test |
| Backend API | No | FastAPI on localhost | `uv sync` | Offline after setup | — |
| Mic capture + VAD | No | sounddevice + Silero (bundled) | pip deps | Offline after setup | mic levels → calibrate threshold |
| Speech-to-text | No | faster-whisper turbo on GPU | weights in `HF_HOME` | Offline after setup | CUDA libs → CPU `small` fallback |
| Text → events | No | qwen3-vl:4b via Ollama (localhost:11434) | `ollama pull` | Offline after setup | model down → rule parser |
| Slip reading | No | qwen3-vl:4b via Ollama | shared | Offline after setup | bad read → vendor confirm screen |
| Ledger, fusion, inference | No | Python/NumPy/SciPy | pip deps | Fully offline | — |
| Storage | No | SQLite file per device | — | Fully offline | — |
| Sync | No (LAN only) | HTTP between devices on a local hotspot | — | Fully offline | real BLE → [OPEN] |
| Claude Code / GitHub | Yes | Dev tooling only, not in product | — | Excluded | — |

---

## 9. Failure modes and fallbacks

| Failure | Detection | Fallback |
|---|---|---|
| Ollama not running / model missing | `/health.llm_ready=false`, exception in extractor | `rules.parse()` (automatic in `engine=auto`) |
| CUDA/cuDNN broken | `ASR()` raises on GPU | Whisper `small` on CPU (int8) |
| Whisper hallucinates on noise | empty/blocked text, VAD filter | utterance dropped |
| LLM invents amounts | prompt + schema + Pydantic validation; rules cross-check | amount null → low confidence, no posting |
| Slip unreadable | per-line confidence | UI asks vendor to confirm/edit |
| Peer unreachable during sync | `httpx` error per peer | reported in `/sync/now`, retry later; local ledger unaffected |
| Device clock wrong | — | irrelevant by design (vector clocks) |
| Duplicate evidence | `fuse()` | counted once |
| Contradictory claims | `fuse()` | suspense account until resolved |

---

## 10. Privacy and security

- Raw audio is never written to disk; only transcripts are kept.
- Everything stays on the device and the local network; no telemetry, no cloud.
- Customer names live only in the vendor's own devices' ledgers.
- Sync is LAN-only between the family's devices. (Stretch: sign events with a per-device key.)

---

## 11. Device topology for the demo

| Laptop | Role | Runs models? |
|---|---|---|
| L1 (best GPU) | `phone-1` — the vendor's main device; always-on mic + slip camera | Yes (turbo + qwen3-vl:4b) |
| L2 | `phone-2` — family member | Yes if downloaded, else rules |
| L3 | `phone-3` — family member; **hostile clock demo** (set to 1970) | Optional |
| L4 | Development / spare / presenting slides | Optional |

All on the same phone hotspot. Each backend has `PEERS=` pointing at the other two.

---

## 12. Setup on a new laptop

```powershell
# 0. Prerequisites: Git, Node.js 20+, NVIDIA driver. (Python is installed by uv.)
git clone https://github.com/Bhavyagautam08/Cascade-26.git
cd Cascade-26

# 1. Everything: Ollama, models, Python deps, UI deps (resumes and retries on bad networks)
powershell -ExecutionPolicy Bypass -File scripts\setup_models.ps1             # models in E:\ai (or %USERPROFILE%\ai)
#   options: -Root D:\ai   -SkipBakeoffModels
#   watch:   Get-Content E:\ai\logs\setup.log -Wait

# 2. Configure this device
copy .env.example backend\.env       # then edit DEVICE_ID, DB_PATH, PEERS, MIC_ENABLED

# 3. Run
cd backend;  uv run uvicorn app.main:app --host 0.0.0.0 --port 8000
cd frontend; npm run dev              # http://localhost:5173

# 4. Check
curl http://localhost:8000/health     # llm_ready should be true
cd backend; uv run pytest -q          # all tests pass
```

To copy models to another laptop instead of downloading: copy the whole `<Root>` folder
(e.g. `E:\ai`) and the Ollama installer, run the script once (it skips what exists).

---

## 13. Offline acceptance checklist

1. Run setup once with internet. Then **turn Wi-Fi off** (keep only the hotspot LAN for sync, with its mobile data disabled).
2. Start Ollama, backend and UI from a fresh terminal — all start without errors.
3. `/health` → `llm_ready: true`.
4. Speak the PS sentence near the mic → 3 entries appear (purchase tomato ₹180, Sharma paid ₹40, 7 plates poha).
5. Upload a stained slip photo → lines appear with confidence → confirm → purchases posted.
6. `POST /lexicon` a new unit (e.g. `peti = 20 kg`) → next sentence using it parses correctly.
7. Stop Ollama → `/ingest/text` still works (`engine: rules`).
8. Three devices: add conflicting Sharma payments on two devices → sync → same ledger on all three,
   ₹360 in suspense, `balanced: true`.
9. Set L3's clock to 1970, add events, sync → history order unchanged.
10. Browser DevTools → Network tab shows **no** requests leaving localhost/LAN.

**Backup demo:** pre-recorded clips + slip photos in `demo/`, and a seeded SQLite file per device,
in case the venue is too loud or a laptop dies.

---

## 14. Tests

- `tests/test_sync.py`: merge order-independence, duplicate delivery idempotent, 1970 clock doesn't reorder.
- `tests/test_ledger.py`: PS sentence parse, chatter ignored, Lexicon Drop, voice+SMS fused once,
  ₹40 vs ₹400 → suspense and balanced, NNLS recovers 80 g/plate, loss split responds to covariates,
  profit returned as an ordered range.

Run: `cd backend; uv run pytest -q`

---

## 15. Plan, team split, risks

Stage-by-stage plan with status: see [`PLAN.md`](PLAN.md).

| Risk | Impact | Mitigation |
|---|---|---|
| Hinglish ASR accuracy in a noisy hall | Voice demo weak | Bake-off; lexicon hotwords; typed/SMS path; pre-recorded clips |
| Windows CUDA/cuDNN setup | No GPU ASR | pip-installed CUDA libs; CPU `small` fallback |
| Slow / flaky venue network | Setup blocked | Script resumes; copy `<Root>` between laptops by USB |
| 8 GB VRAM pressure | Model swapping, slow | One 4B VLM for both jobs; no 7B+ models |
| Real Bluetooth demanded | Requirement gap | Transport abstraction; LAN demo; ask organisers early |
| Judges probe the maths | Credibility | Every number has a plain-language reason; tests prove properties |
