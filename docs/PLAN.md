# Plan and status

Updated 2026-10-26. Design: [`ARCHITECTURE.md`](ARCHITECTURE.md) · Setup: [`SETUP.md`](SETUP.md).
Mark items here when they land (with the commit), so anyone can see what's done and what's left.

## Done

| Area | What works | Verified by |
|---|---|---|
| Setup | one-command device setup (`scripts/setup_device.ps1`), start (`scripts/start.ps1`), deps and models in the user profile | dry runs on the GPU laptop; real run on a 2nd laptop **pending** |
| Speech | Whisper `small` on GPU (CPU fallback), English-mode Hinglish, lexicon hotwords, clarity gate, 60 s repeat window | eval on 3 real clips; tests |
| Text → events | LLM with schema + cross-check, bank-SMS parser, rule parser fallback | text eval 7/7 (`eval/reports/2026-10-26_002410.md`) |
| Slips | rotation by log-prob (12/12 real photos), per-line confidence, price column, confirm screen | slip eval + tests |
| Morning / evening stock | voice or typed, questions instead of guesses, dedup by recording, 409 overwrite guard | tests + real-LLM check |
| Ledger | balanced events, paise, append-only, accounts incl. opening stock and suspense | tests |
| Business days | clock-free day markers, day-scoped views, history kept | tests |
| Fusion | echoes, cross-modal, two-phone twins, disputes, possible duplicates, same / separate decisions | 15 twin tests + API tests |
| Inference | recipe (NNLS) from count-to-count periods, overnight loss, loss split, daily profit range | tests; seeded demo recovers planted recipe within 0.5 % |
| Identity | actor id per ledger file, foreign-file refusal, copy / restore detection | tests |
| Sync | background engine, paged resumable protocol, per-peer status, family key | tests incl. real 3-process runs (5× repeated), manual end-to-end with a 1970 clock |
| UI | Today, Record, Entries, Udhaar, Stock, Books (disputes, one-trade-or-two, counted once), Morning & evening stock, Family devices (live sync status) | type-check + build; **not clicked through yet** |
| Demo data | 5-day seeded ledger (`scripts/seed_demo.py`), 3-phone launcher (`scripts/family.ps1`) | run |

## Left (in priority order)

| # | Item | Why it matters | Owner | Status |
|---|---|---|---|---|
| 1 | Set up the 2nd and 3rd laptop with `setup_device.ps1`; real sync over a phone hotspot | demo centrepiece; firewall / Public-network issues only show on real laptops (this laptop's college Wi-Fi is Public) | | todo |
| 2 | Live spoken test through the always-on mic | voice is only verified with clips and typed text | | todo |
| 3 | Click through every screen in a browser (Family devices, Books decisions, Udhaar, stock) | UI only type-checked | | todo |
| 4 | Twin lag > 30 s: list as "one trade or two?" instead of counting twice silently; measure real per-device processing delay | the only case where the books can go wrong unnoticed | | todo |
| 5 | Record one sale on two real phones/laptops at once, check twins | twin evidence so far uses simulated second-phone audio | | todo |
| 6 | Warn when a peer has been out of touch for long ("phone-2: no sync for 2 h") | the vendor should know entries can't be timed | | todo |
| 7 | Offline run-through (Wi-Fi off, hotspot only) — checklist below | PS requirement | | todo |
| 8 | Freeze, rehearse 3×, slides, backup demo data | demo | everyone | todo |
| 9 | More eval samples (voice clips, stock counts) | evidence for judges | | todo |
| 10 | Turn it into an app (phone build) | product goal after the hackathon | | later |
| 11 | Bluetooth transport | PS mentions Bluetooth; transport is swappable | | stretch |

## Offline acceptance checklist

1. Setup with internet, then turn internet off (keep only the hotspot, mobile data off).
2. `scripts\start.ps1` on every laptop; `/health` → `llm_ready: true` on the model laptop.
3. Speak "3 kilo tamatar liya 180 mein, Sharma ji ne 40 diye, 7 plate poha becha" → 3 entries.
4. Slip photo → lines with confidence → confirm → purchases.
5. `POST /lexicon` a new unit (`peti = 20 kg`) → next sentence uses it.
6. Stop Ollama → typed text still books (`engine: rules`).
7. Two laptops hear one sale → counted once on all; Sharma 40 vs 400 → dispute, books balanced.
8. phone-3 on `-HostileClock 1970`: entries sync, order and days unchanged.
9. Close one laptop's backend, trade on the others, start it → it catches up by itself.
10. Browser Network tab: no request leaves localhost / LAN.
