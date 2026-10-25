# Architecture — The Invisible Worker (Cascade '26, PS 1.2)

> A fully offline, on-device probabilistic ledger for a street vendor. It turns noisy, contradictory,
> multi-channel evidence (shop talk, wholesale slips, SMS, tallies, morning/evening stock counts) into a
> balanced double-entry ledger with **ranges and confidence, never blind point guesses**, and keeps the
> family's devices in sync peer-to-peer, surviving broken clocks.

This document describes **what is built** (as of 2026-10-26, `main` at the sync hardening). Status and
what's left: [`PLAN.md`](PLAN.md). Setting up a laptop: [`SETUP.md`](SETUP.md).

---

## 1. Requirements → where they are handled

| # | Requirement (PS) | Handled in | State |
|---|---|---|---|
| R1 | Passively accept chaotic inputs | `perception/` (mic, slip, SMS, text), `inventory.py` (stock counts) | built; live-mic spoken test pending |
| R2 | Double-entry ledger | `ledger/events.py`, `doubleentry.py` | built |
| R3 | Ranges, confidence | `ledger/inference.py` (Monte Carlo p10/p50/p90) | built |
| R4 | Zero-shot recipe | `inference.wastage_from_ledger` (NNLS on count-to-count periods) | built |
| R5 | Loss attribution | `inference.attribute_loss` (priors × covariates, Dirichlet) | built |
| R6 | Cross-modal fusion | `ledger/fusion.py` | built |
| R7 | Lexicon Drop | `perception/lexicon.py`, `data/lexicon.json`, `POST /lexicon` | built |
| R8 | Family devices, CRDT sync on reconnect | `sync/` + `ledger/store.py` + `ledger/identity.py` | built; multi-laptop run pending |
| R9 | Hostile clocks | vector clocks, monotonic run time, sync moments; wall time display-only | built |
| R10 | Contradictory claims, books balanced | `fusion.py` disputes → lower booked, suspense | built |

Evaluation chain: **Raw Material Burn → Inferred Wastage → Reconciled Credit → True Accrual Profit**
(`wastage_from_ledger` → `attribute_loss` → `fuse` → `day_profit`).

---

## 2. Constraints we work under

| Constraint | Source | Consequence |
|---|---|---|
| Fully offline at runtime | PS | no cloud APIs; models local (Ollama, faster-whisper); setup may use internet |
| No trusted clock | PS (1970 / jumps) | nothing is ordered or matched by wall time |
| Devices are mostly disconnected | PS | every device works alone; sync is a set union on contact |
| Laptop = device | team decision | each laptop plays one family phone; an app port comes later |
| LAN instead of Bluetooth | team decision | transport is swappable (`sync/transport.py`); BLE not built |
| 8 GB laptop GPU | hardware | one 4B vision-language model for text and slips; Whisper `small` only |
| No silent fallbacks, no guessing | team rule | every fallback says why; unknown amounts post nothing; ambiguities become questions |
| Deps outside the project folder | team rule | venv in `%LOCALAPPDATA%`, models in user caches |

---

## 3. System overview

```
┌─────────────────────────────── ONE DEVICE (laptop = family phone) ───────────────────────────────┐
│ Mic ─► MicListener (adaptive gate) ─► Whisper small (+VAD, hotwords) ─► heard(): clarity gate,   │
│                                                                          60 s repeat window     │
│ Typed / SMS / tally ─► bank-SMS parser │ LLM (qwen3-vl:4b-instruct, schema) + cross-check │ rules │
│ Slip photo ─► rotation by log-prob ─► transcription ─► parse_slip ─► vendor confirms             │
│ Morning / evening stock (voice or typed) ─► inventory: questions, no guesses ─► vendor confirms  │
│                                   ▼                                                              │
│                    EventStore (SQLite, append-only, one file, own actor id)                      │
│                                   ▼                                                              │
│      fuse(): echoes · cross-modal · two-phone twins · disputes · possible duplicates (a view)    │
│                                   ▼                                                              │
│      days (business days by markers) · inference (recipe, wastage, loss, profit ranges)          │
│                                   ▼                                                              │
│      FastAPI :8000  ◄──►  React dashboard :5173 (Vite proxy)                                     │
│                                   ▲                                                              │
│      SyncEngine (background, every 5 s + on every new entry) ── protocol: hello / pull / push    │
└───────────────────────────────────┼──────────────────────────────────────────────────────────────┘
                                    │ LAN HTTP, X-Sync-Key
                       phone-2 ─────┴───── phone-3
```

---

## 4. Models

| Role | Model | Runtime | Notes |
|---|---|---|---|
| Speech-to-text | Whisper `small` (`Systran/faster-whisper-small`) | faster-whisper, CUDA `int8_float16`; CPU `int8` | `language=en` on purpose (Hindi mode writes garbled Devanagari; English mode writes Roman Hinglish with digits); lexicon hotwords without units |
| VAD | Silero (bundled) | `vad_filter=True` | plus the mic's adaptive loudness gate |
| Text → events, slips, stock counts | `qwen3-vl:4b-instruct` | Ollama, structured outputs, `think=False`, logprobs | must be the `-instruct` tag (the plain tag "thinks" and returns empty JSON) |
| No-model fallback | `rules.parse` (lexicon-driven) | Python | used automatically only when the model is unavailable / off-schema, and says so |

---

## 5. Stack

Python 3.12 (uv), FastAPI, Pydantic v2, SQLite, NumPy/SciPy, faster-whisper, sounddevice, httpx,
Ollama; React 18 + Vite 5 + TypeScript; pytest. No cloud, no Docker, no vector DB, no CRDT library
(our grow-only event set is small and fully tested).

---

## 6. Components

### 6.1 Perception (`backend/app/perception/`, `pipeline.py`)

| Piece | What it does | Rules that keep it honest |
|---|---|---|
| `mic.py` | always-on capture, cut at pauses | device chosen by name; rescans on start; watchdog reopens a dead device; raw audio never stored |
| `asr.py` | Whisper wrapper | known-hallucination blocklist; clarity from log-prob × (1 − no-speech) |
| `pipeline.heard` | voice → ledger | clarity < `VOICE_MIN_CLARITY` → shown, not booked; same trade within `VOICE_REPEAT_WINDOW_S` (monotonic clock) → booked once |
| `extractor.py` | text → candidate events via the LLM | small schema, worked examples; `cross_check` removes any amount not in the text; confidence capped (`LLM_MAX_CONFIDENCE`) |
| `sms.py` | bank / UPI SMS | exact amount and direction; money in from a debtor → repayment, else suspense; never a guessed sale |
| `rules.py` | deterministic parser | money vs quantity vs time-of-day; priced from the lexicon only with a flag |
| `vision.py` + `slip_lines.py` | slip photo → lines | orientation by mean token log-prob over 4 rotations (12/12 on real photos); per-line confidence from token log-probs; deterministic parsing; price column read when present, else an order (no price) |
| `lexicon.py` | runtime vocabulary | reloads on change; feeds hotwords, prompts and the rule parser |

### 6.2 Stock counts (`inventory.py`)

Morning (opening) and evening (closing) counts by voice or typing. The model reports only what was
said; code converts numbers/units, checks every number against the transcript and asks a question for
every ambiguity. Nothing saves while a question is open. A recording is hashed: saving it twice returns
the first save (also across devices). A second count of the same item on the same business day is
refused (409) until the vendor says "replace"; the replacement supersedes the old entries.

### 6.3 Ledger (`backend/app/ledger/`)

**Event** (immutable):

| Field | Meaning |
|---|---|
| `id` = `actor:seq` | `actor` = this ledger file's id, e.g. `phone-1.k3x9qa` (6.5); `seq` never reused |
| `vclock` | what this device had seen when it wrote the event |
| `wall_time` | untrusted, display only |
| `mono` | (run id, seconds) on the device's monotonic clock: exact within one run of one device |
| `marks` | per peer, `(sync id, seconds since that sync)` for recent syncs: times two phones' entries (6.6) |
| `kind` | `purchase sale credit_given credit_paid expense stock_count order opening_stock day_start adjustment` |
| `source` | `voice slip sms tally manual` |
| `confidence`, `payload`, `raw`, `supersedes` | as named; corrections, voids and settlements supersede |
| `postings` | integer paise, must sum to 0 (validated) |

Accounts: `cash`, `inventory:<item>`, `receivable:<party>`, `revenue:sales`, `expense:<what>`,
`equity:opening_stock` (other side of stock already held), `suspense`. Unknown amounts post nothing and
are listed as incomplete; an `order` (bought, no price said) moves no money.

**Store** (`store.py`): SQLite tables `events(id, device_id, seq, body)` and `meta(key, value)` (the
file's owner name, actor, previous actors). Append-only. Ingest is one transaction and refuses malformed
ids, vector clocks that don't count the event itself, and an id already held with different content.

**Business days** (`days.py`): "Start a new day" appends a `day_start` marker. An event belongs to the
newest marker it had seen (vector clock), so days are clock-free and every phone computes the same days;
two phones starting the day concurrently create the same day. Profit and today's lists are per day;
balances, udhaar and disputes are cumulative.

### 6.4 Fusion (`fusion.py`) — a pure, deterministic view

Recomputed on every read from the synced set, so all devices agree and nobody stores "merge" events.
Only human decisions are events: `same`, `separate`, settle, correct, void (latest per pair wins).

| Rule | When | Result |
|---|---|---|
| Echo | same device and source, back to back, identical words and trade, ≤ 10 s apart on the same run | once |
| Cross-modal | identical trade from different sources: ≤ 5 entries apart on one device, or ≤ 300 s apart on two devices (or, time unknown, concurrent on the same day) | once; confidence `1 − Π(1 − cᵢ)` over distinct sources |
| Twins | two devices, ≤ 30 s apart, same kind / party / amount, same item or one missing | once; matched closest-first, one per device |
| Dispute | two devices ≤ 30 s apart with different amounts; or concurrent udhaar claims of unknown timing that look misheard (40/400, 140/410) | lower booked; for udhaar the gap sits in `suspense`; vendor settles |
| Possible conflict | concurrent udhaar claims of unknown timing, not a misheard pattern | both count, listed |
| Possible duplicate | identical trade on two devices that were out of touch, same day | both count, listed: "one trade or two?" |

Candidate pairs come from indexes (neighbours on a device, shared sync moments, out-of-touch devices
per day), not all-pairs: ~0.04 s for 1,400 entries.

### 6.5 Identity (`identity.py`)

`DEVICE_ID` is the human name. Each ledger file writes as its own **actor** `<name>.<6 random letters>`,
chosen on first open and stored in the file, so a ledger created again (deleted, reinstalled, a copied
`.env`) never reuses ids. Opening a file under another name is refused. If an entry under our own actor
arrives that we don't hold (a copied or restored file), it is kept and we switch to a fresh actor before
writing again; a peer saying hello with our actor triggers the same. All switches are shown in the UI.

### 6.6 Sync (`sync/`)

- **Data type:** grow-only set of immutable events; merge = union (commutative, associative, idempotent).
- **Protocol** (`protocol.py`, both ends share the code):
  `hello` → name, actor, held seq ranges (`have`); `pull` → what we lack, ordered by (actor, seq), pages
  of 500 with a cursor; `push` → what the peer lacks. Pages are saved as they arrive; an interrupted sync
  resumes; a refused entry is reported and never stalls the rest. A peer that is this device itself is refused.
- **Engine** (`engine.py`): a round with every peer in parallel every `SYNC_INTERVAL_S` (5 s) and
  ~1 s after any new entry; rounds never overlap; per-peer state (ok / unreachable / refused / error,
  last good sync by monotonic clock, totals, refusals, warnings) at `GET /sync/status`; bugs logged with
  traceback and shown.
- **Sync moments:** the caller of `hello` may make the sync a shared moment (at most every 5 s per peer;
  once a minute a long one). Both phones note it on their own monotonic clock. Entries carry marks for
  the last 60 s (long ones for 10 min). Two entries sharing a mark are timed exactly:
  `|seconds since S on A − seconds since S on B|`. No wall clock involved.
- **Transport** (`transport.py`): HTTP on the LAN with `X-Sync-Key`; a Bluetooth transport would only
  implement `hello / pull / push`.
- **Ordering:** `causal_order` = vector-clock sum, then (actor, seq). Every event balances, so any union balances.

### 6.7 Inference (`inference.py`)

| Function | Method |
|---|---|
| `wastage_from_ledger` | count-to-count periods: morning→evening = trading, evening→next morning = overnight (reported separately); NNLS with a non-negative intercept per ingredient; needs enough trading periods, else says how many it has |
| `attribute_loss` | priors 0.5/0.2/0.3 × explainable covariates, Dirichlet(α=p·20) intervals; assumptions returned |
| `day_profit` / `profit_range` | Monte Carlo 2,000 draws (seed 7): amount noise SD 0.5·(1−confidence), uncounted stock U(0, 0.3), collection Beta(8, 2); opening stock carried from the last count, valued at a known price, or reported unvalued (never invented) |

---

## 7. API (`main.py`, port 8000)

UI endpoints answer loopback only (unless `ALLOW_REMOTE_UI=true`); peer endpoints need `X-Sync-Key`.

| Area | Endpoints |
|---|---|
| health | `GET /health` (name, actor, models, mic, peers) |
| ledger | `GET /events` (with `day`), `GET /days`, `GET /ledger/balances`, `GET /ledger/summary?day=` (profit, receivables, duplicates, conflicts, possible_conflicts, possible_duplicates), `POST /ledger/resolve`, `/void`, `/correct`, `/separate`, `/same`, `POST /day/new` |
| input | `POST /ingest/text`, `/ingest/audio`, `/ingest/slip`, `/ingest/slip/confirm`; `GET /mic/recent`, `/mic/status`, `/mic/devices`; `POST /mic/start`, `/mic/stop`, `/mic/simulate` |
| stock | `POST /inventory/voice?mode=`, `/inventory/text`, `/inventory/confirm`; `GET /inventory/today` |
| maths | `GET /inference/ledger`; `POST /inference/recipe`, `/inference/loss` |
| lexicon | `GET / POST /lexicon` |
| sync (peers) | `GET / POST /sync/hello`, `GET /sync/frontier` (older form), `POST /sync/pull`, `POST /sync/push` |
| sync (UI) | `POST /sync/now`, `GET /sync/status` |

Errors: 503 model unavailable, 502 model off-schema, 422 bad input, 404 unknown id/day, 409 would
overwrite a confirmed count, 500 a bug (never relabelled).

---

## 8. Decisions and trade-offs

| Decision | Chosen | Traded off | Why |
|---|---|---|---|
| Duplicates as a view | recompute on read | a little CPU per request | devices can't disagree; humans can undo anything |
| Twins by time, not words | sync moments | needs syncs to have happened | measured: one utterance on a degraded 2nd phone scored 0.00–0.78 word similarity, different utterances up to 0.28 (`eval/twin_phones.py`) |
| Twin window 30 s | fixed constant | a phone lagging > 30 s double-counts unnoticed; two real identical sales within 30 s, each heard by one phone, merge (undo: "different trades") | covers ~9 s measured LLM time ×3 |
| Cross-modal window 300 s | fixed | a repeat payment within 5 min, one by voice, one by SMS, merges | bank SMS can lag minutes |
| Out of touch → ask | list "one trade or two?" | the vendor must decide | nothing can tell; no silent guess |
| Disputes book the lower amount | conservative | profit understated until settled | never claims money that may not exist |
| Actor id per ledger file | random suffix | ids longer, vector clocks grow per reinstall | a reset or copied ledger can't fork the family's books |
| Fresh actor for pre-actor ledgers | always | old plain `phone-1` entries stay beside new ids | can't prove the plain name was only that file's |
| Sync every 5 s + on change | chatty on LAN | negligible LAN traffic | keeps devices seconds apart; makes sync moments dense |
| LAN, not Bluetooth | HTTP | not the PS's literal transport | reliable demo; transport swappable |
| Business days by markers | clock-free | a phone that hasn't synced books into the old day | identical days on every phone, broken clocks harmless |
| `language=en` for Whisper | Roman Hinglish | some Hindi words spelt oddly | Hindi mode produced garbled Devanagari the parser can't read |
| One 4B VLM | text + slips + counts | less accurate than bigger models | fits an 8 GB GPU next to Whisper |
| Lower confidence cap on LLM | 0.85 | confident answers look less certain | LLM self-confidence is uncalibrated |

---

## 9. What changed from the first design

| Area | Before | Now |
|---|---|---|
| Duplicate rule | amount within 5 %, vclock sums within 6 | exact trade; time-based (mono, sync moments); closest-first one-to-one |
| Two phones, same input | not handled (counted twice) | twins / disputes / possible duplicates |
| Echo | any back-to-back identical entries | only ≤ 10 s apart on the same run (quiet stalls were losing sales) |
| Voice + SMS on two phones | merged only if concurrent (almost never once synced) | ≤ 300 s by sync moments |
| Sync | manual "Sync now", gap-free frontier, one request | background engine, held ranges, paged with a cursor, status page |
| Ids | `device_id:seq` from `.env` | `actor:seq`, actor per ledger file; copy / reset detection |
| New day | archived the book and started empty | day markers; history kept; day-scoped views |
| Stock | single "stock_count" | morning (opening) and evening (closing) counts; overnight vs trading periods |
| Disputes | udhaar only | any money kind; udhaar gap in suspense, others book the lower |

---

## 10. Failure modes

| Failure | What the user sees |
|---|---|
| Ollama down / model missing | `llm_problem` in health; rule parser used, `fallback_reason` says why |
| GPU fails | Whisper on CPU, `asr.fallback=true` |
| Mic unplugged / stalls | watchdog reopens; errors counted in mic status |
| Unclear speech | shown in the feed, not booked until confirmed |
| Peer unreachable / wrong key / protocol error / bug | per-peer state and error on Family devices |
| Entry refused during sync | listed with its reason; the rest still syncs |
| Copied / restored ledger | actor switch, shown with the reason |
| Broken clock | irrelevant to ordering, days and duplicate timing; dates marked "phone clock looks wrong" |

---

## 11. Privacy and security

Raw audio is never stored. Everything stays on the devices and the local network. Peer endpoints need
the family key; UI endpoints answer only the laptop itself. (Not built: per-device signatures.)

---

## 12. Tests and evaluation

`cd backend; uv run pytest -q` → 177 tests: ledger, days, stock, inventory, vision, faults (incl. real
2- and 3-process sync over HTTP: auto-sync, a killed and restarted phone, two phones hearing one sale),
identity, sync store, protocol/engine, twins (incl. performance), twin API, seed.

`eval/run_eval.py` runs real samples through the running backend (text 7/7 on 2026-10-26).
`eval/twin_phones.py` measured transcript similarity for the twin decision. Reports in `eval/reports/`.
