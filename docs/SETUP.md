# Setup: make a Windows laptop one device of the family

Each laptop plays one family phone (`phone-1`, `phone-2`, `phone-3`). Follow this top to bottom on
each laptop. Nothing depends on another computer's folders, and nothing heavy goes into the project
folder. Design: [`ARCHITECTURE.md`](ARCHITECTURE.md). What's done / left: [`PLAN.md`](PLAN.md).

**In short:** install 4 programs → get the code → run `setup_device.ps1` once → run `start.ps1`.

---

## 1. Install these programs (once)

| Program | Why | Download |
|---|---|---|
| Git | get the code | https://git-scm.com/downloads |
| Node.js **20 or newer** (LTS) | runs the dashboard | https://nodejs.org/en/download |
| uv | installs the Python backend (it fetches Python 3.12 itself) | https://docs.astral.sh/uv/getting-started/installation/ |
| Ollama | runs the language model locally | https://ollama.com/download |
| NVIDIA driver | only on laptops with an NVIDIA GPU | https://www.nvidia.com/en-us/drivers/ |

- After installing, **open a new terminal** (so Windows finds the new programs).
- No separate Python or CUDA toolkit is needed: uv brings Python, and the CUDA libraries come as packages.
- **Ollama is optional.** Without it, typed text, SMS and voice still become entries through the rule
  parser; only slip photos can't be read. Don't set `OLLAMA_MODELS`: Ollama keeps models in its own place.

## 2. Download the language model (once, ~3.3 GB)

Open the **Ollama app**, pick `qwen3-vl:4b-instruct` in its model selector and send any message: it
downloads the model. (Or let step 4 do it: add `-PullModel`.) It must be the `-instruct` tag: the plain
`qwen3-vl:4b` is a "thinking" model that returns empty answers here.

## 3. Get the code

```powershell
git clone https://github.com/Bhavyagautam08/Cascade-26.git
cd Cascade-26
```

Already have it? `git pull` inside the folder.

## 4. Set up this device (one command)

Decide first, as a family:

| What | Rule |
|---|---|
| Device names | every laptop its own: `phone-1` (the vendor's main device, with the mic), `phone-2`, `phone-3` |
| Family key | one secret for all laptops. The **first** laptop makes it with `-NewSyncKey` and prints it; the others pass it with `-SyncKey` |
| Network | all laptops on **one phone hotspot** (recommended) or one home Wi-Fi. Venue/college Wi-Fi often blocks laptops from seeing each other |

**First laptop** (the vendor's main device):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup_device.ps1 -DeviceId phone-1 -Mic -NewSyncKey
```

**Every other laptop** (key from the first one; the addresses each setup printed in step [6]):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup_device.ps1 -DeviceId phone-2 -SyncKey <family key> `
    -Peers http://192.168.1.10:8000,http://192.168.1.12:8000
```

Then re-run it on the first laptop with `-Mic`, its `-Peers` and the same `-SyncKey` (instead of
`-NewSyncKey`), so it knows the others too. Re-running is safe; the settings you pass win, so always
pass `-Mic` on the mic laptop.

What the script does, step by step (it says what it found at each step and lists anything to fix at the end):

| Step | Does | Notes |
|---|---|---|
| [1] | checks Git, Node ≥ 20, uv, Ollama | stops if a must-have is missing |
| [2] | Python + UI packages, Whisper `small` | into your user profile: env `%LOCALAPPDATA%\cascade\backend-venv`, packages `%LOCALAPPDATA%\uv`, Whisper `%USERPROFILE%\.cache\huggingface`; only `frontend\node_modules` is in the project. Log: `%LOCALAPPDATA%\cascade\setup.log` |
| [3] | writes `backend\.env` | name, ledger file `data/ledger-<name>.db`, mic, peers, key; other lines kept. **Refuses** to rename a laptop that already has a ledger under another name |
| [4] | GPU or CPU | NVIDIA found → Whisper on the GPU; else CPU (`int8`, slower, works) |
| [5] | Windows Firewall rule for port 8000 | needs a terminal opened with **Run as administrator**; otherwise it prints the one command to run there. Also warns if the Wi-Fi is set to **Public** |
| [6] | prints this laptop's address | give it to the other laptops for their `-Peers` |
| [7] | checks each peer | reachable? same family key? not the same name? |
| [8] | runs the backend tests | `-SkipTests` to skip |

Options: `-DryRun` (show, change nothing) · `-SkipInstall` (settings only) · `-PullModel` ·
`-ModelMode demo` (no models: labelled stand-ins, the ledger and sync are real).

## 5. Start the device

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start.ps1
```

Opens two windows (backend, dashboard). Open **http://localhost:5173**. Close the windows to stop; the
ledger is a file and survives. The first transcription after start takes ~20 s (GPU warm-up).

## 6. Check it works

| Where | Good | If not |
|---|---|---|
| http://localhost:8000/health → `llm_ready` | `true` | `llm_problem` says why: Ollama not running, or model not downloaded |
| `/health` → `asr.fallback` | `false` | `true` = the GPU failed, Whisper runs on the CPU; see `asr.error` |
| `/health` → `mic_listening` | `true` on phone-1 | `mic.last_error` says why |
| Dashboard → **Family devices** | every other laptop "in sync, N s ago" | the row shows the exact error (see below) |

Quick family test: type a sale on phone-2 (Record a trade); within ~5 s it shows on phone-1's Today.

---

## Known problems and fixes

| Symptom | Cause | Fix |
|---|---|---|
| Family devices: "out of reach", `ConnectTimeout` | firewall, Public network, or different networks | step [5] as Administrator; set the Wi-Fi to **Private** (Settings › Network › this Wi-Fi › Network profile); all on one hotspot. Venue Wi-Fi may isolate clients: use a phone hotspot |
| Family devices: "it refused this phone", `401` | different `SYNC_KEY` | re-run setup with the same `-SyncKey` everywhere |
| Warning "is also called phone-1" | two laptops share a name | the books stay correct, but re-run setup on one with another `-DeviceId` **before** it has a ledger |
| Backend won't start: "… is the ledger of 'phone-1', but DEVICE_ID is 'phone-2'" | `DEVICE_ID` changed on an existing ledger | put the old name back, or point `DB_PATH` at a new file |
| Family devices: "This phone now writes as … instead of …" | a copied / restored ledger file met its original | nothing to do: it switched to a fresh id on purpose. Don't copy ledger files between laptops |
| Family devices: "… is this device itself: remove it from PEERS" | own address in `PEERS` | re-run setup without it |
| `llm_problem`: Ollama is not running | Ollama closed | start Ollama from the Start menu |
| LLM returns empty output, each call takes a minute | a "thinking" model | use `qwen3-vl:4b-instruct` |
| `An Application Control policy has blocked this file` | Smart App Control | handled in code (uploads must then be WAV). Don't switch Smart App Control off |
| `Library cublas64_12.dll is not found` | CUDA libraries not on the path | handled in code; else re-run setup |
| very slow, `ollama ps` shows CPU/GPU split | not enough graphics memory | close other GPU apps |
| `start.ps1`: port already in use | the device is already running | close its windows first |

## Moving or resetting a device

- **Never copy a ledger file to another laptop.** Each laptop syncs its own; a copy is detected and
  forced onto a new id, but entries both copies wrote before meeting can't be merged.
- **Start a laptop's ledger again:** stop it, move `backend\data\ledger-<name>.db` away, start it. It gets a
  new id; the family's entries come back by sync. (The family's books are the union of all devices: an
  entry that reached another device can't be deleted, only voided in the app.)

## All three phones on one laptop (sync demo)

```powershell
powershell -File scripts\family.ps1                      # phone-1..3: backends 8000-8002, UIs 5173-5175
powershell -File scripts\family.ps1 -BrokenClock 3:1970  # phone-3's clock says 1970
powershell -File scripts\family.ps1 -DryRun              # print the commands only
```

Ledgers in `backend\data\family\` (never the real one). Close a phone's backend window to "take it to
the mandi"; run its printed line to bring it back: it catches up by itself. One phone by hand:
`scripts\run_device.ps1` (see its header).

## Demo data

`cd backend; uv run python ..\scripts\seed_demo.py --db data\ledger-demo.db` writes a simulated 5-day
history (flagged `demo_seed`) into a new, empty ledger. Run the backend on it with
`$env:DB_PATH="data/ledger-demo.db"` before starting.
