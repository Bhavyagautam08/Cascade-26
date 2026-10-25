# Real-sample evaluation: what to record, how, and where to put it

The app is only as good as what it reads and hears. Unit tests (`backend/tests/`) prove the ledger
maths; **this folder proves the models work on real input**. Every sample is a real photo or recording
plus a human-written answer key. `run_eval.py` (coming next) sends each sample through the running
backend with the real models and reports how many it got right.

**Rule: never fake a sample.** Real paper, real phone, real voices. A sample without a checked answer
key is useless.

```
eval/
  samples/
    slips/   NNN_short-name.jpg   + NNN_short-name.expected.json
    audio/   NNN_short-name.wav   + NNN_short-name.expected.json
    text/    cases.jsonl          (one typed / SMS case per line)
  reports/   written by run_eval.py, one file per run
```

Naming: 3-digit number, then a short name with dashes, no spaces. Number the next free one
(`004_...`). Add a tag to the name if the sample is deliberately hard: `_sideways`, `_noisy`,
`_stained`, `_dim`.

---

## 1. Bill / slip photos  ->  `samples/slips/`

### File
| Property | Required |
|---|---|
| Format | `.jpg` (or `.png`) straight from the phone camera, no filters, no screenshots |
| Size | long side **at least 1200 px** (any modern phone is fine); max 8 MB |
| Content | **one bill per photo**, the whole bill inside the frame |
| Orientation | upright for most; a few deliberately sideways (`_sideways`) |

### What to write on the paper (realistic vendor bills)
- Handwritten in pen, Hinglish or English item names: `Tamatar`, `Pyaaz`, `Poha`, `Tel`, `Doodh`...
- **Quantity AND unit on every line**: `5 kg`, `500 g`, `2 L`, `250 ml`, `1 dozen`, `3 packet`.
- **A price on most lines** (`Rs 300`, `₹105`, or just `300`), because the app books money, not just lists.
- A **supplier name at the top** on most bills (`Gupta Traders`, `Shri Ganesh Kirana`).
- A **total at the bottom** on most bills.

### How many (target 10)
| # | What | Why |
|---|---|---|
| 4 | clean, upright, with prices, supplier and total | the normal case |
| 2 | crumpled + a tea/oil stain over part of a line | the PS asks for this |
| 2 | sideways / upside down | phones are held anyhow |
| 1 | dim light or shadow across the page | real stalls |
| 1 | a line crossed out and rewritten | real handwriting |

### Answer key: `NNN_short-name.expected.json`
Write exactly what is on the paper, as a human reads it. Units as written (`g`, `kg`, `ml`, `l`,
`dozen`, `packet`, `plate`); the evaluator converts g->kg and ml->l itself. Unreadable value -> `null`.
```json
{
  "verified_by": "Bhavya",
  "notes": "stain covers the oil price",
  "supplier": "Gupta Traders",
  "total_rupees": 1115,
  "lines": [
    {"item": "tomato", "qty": 5, "unit": "kg", "amount_rupees": 300},
    {"item": "oil",    "qty": 1, "unit": "l",  "amount_rupees": null}
  ]
}
```
Item names in English if the lexicon knows the word (`tamatar` -> `tomato`, see
`backend/data/lexicon.json`), otherwise as written in lowercase (`bhindi`, `achaar`).

> Samples 001-003 are already here, with answer keys **drafted by Claude** (`verified_by: null`).
> Someone must check each line against the photo, fix mistakes and put their name in `verified_by`.
> They have no prices, so they only test names + quantities.

---

## 2. Voice clips  ->  `samples/audio/`

### File (exact)
| Property | Required |
|---|---|
| Format | **WAV, 16 kHz, mono, 16-bit PCM** |
| Length | **2-15 seconds**, one utterance (the live mic cuts at 0.8 s of silence, max 20 s) |
| Start / end | about half a second of silence before and after speaking |
| Distance | phone or laptop **30-60 cm** from the mouth, normal speaking volume |

Phone recordings are usually `.m4a`. Convert with ffmpeg (installed at `C:\ffmpeg\bin`):
```powershell
ffmpeg -i input.m4a -ar 16000 -ac 1 -c:a pcm_s16le eval\samples\audio\004_tamatar-purchase.wav
```
Or record directly on the laptop with Windows **Sound Recorder** and convert the same way.

### What to say (target 15 clips, at least 3 different speakers)
Natural Hinglish, the way a vendor talks. Say numbers in Hindi in some clips (`ek sau assi`), digits in
others (`180`). Record **each of these once quiet and once with background noise** (traffic video,
crowd, pressure cooker) - name the noisy one `_noisy`.

| # | Say (or close to it) | Tests |
|---|---|---|
| 1 | "Bhai teen kilo tamatar liya ek sau assi mein" | purchase, Hindi numbers |
| 2 | "Sharma ji ka chaalees jama kar" | repayment |
| 3 | "Saat plate poha de do" | sale priced from list |
| 4 | "Pandey ji ka saath rupaye udhaar likh do" | credit given |
| 5 | "Gas cylinder ka nau sau pachaas kharcha hua" | expense |
| 6 | "Shaam ko do kilo poha bacha hai" | stock count |
| 7 | "Aaj bahut garmi hai, grahak kam hain" | chatter: must create **nothing** |
| 8 | "Do kilo pyaz laya assi mein aur ek kilo aloo tees mein" | two trades in one sentence |
| 9 | the full PS sentence: "Bhai 3 kilo tamatar liya 180 mein, Sharma ji ka 40 jama kar, aur 7 plate poha de" | three trades |

### Answer key: `NNN_short-name.expected.json`
```json
{
  "verified_by": "Bhavya",
  "speaker": "Rahul",
  "noisy": false,
  "transcript": "bhai teen kilo tamatar liya ek sau assi mein",
  "events": [
    {"kind": "purchase", "item": "tomato", "qty": 3, "unit": "kg", "amount_rupees": 180}
  ]
}
```
`transcript` is exactly what was said, in Roman letters, lowercase. `events` is what the ledger should
get; `[]` for chatter. Kinds: `purchase`, `sale`, `credit_given`, `credit_paid`, `expense`, `stock_count`.
Leave out fields that weren't said (no `amount_rupees` if no price was said).

---

## 3. Typed text and SMS  ->  `samples/text/cases.jsonl`

One JSON object per line, same `events` format as audio. Add real SMS texts from a phone (change
names and account digits), shop-talk lines, and chatter.
```json
{"id": "t007", "text": "Rs.140 credited to a/c XX12 by UPI from CHHOTU on 25-10", "events": [{"kind": "credit_paid", "party": "chhotu", "amount_rupees": 140}]}
```

---

## Who does what (suggested)
| Person | Creates |
|---|---|
| A | 7 bill photos (the list in section 1) + answer keys; checks 001-003 |
| B, C | voice clips 1-9, quiet + noisy, two different voices |
| D | 10 text/SMS cases |

Commit samples with their answer keys in the same commit. Never commit a sample without its key.
