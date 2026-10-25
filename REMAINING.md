# What's remaining (Android app, branch `app`)

Updated 2026-10-26. Work folder: `C:\dev\Cascade\Cascade-app` (git worktree on branch `app`); app in `mobile/`.

## Done (on the phone and on GitHub)

- React Native 0.87.1 app, Android only (arm64), no Expo; built locally, installed over USB.
  Build: `$env:ANDROID_HOME="$env:LOCALAPPDATA\Android\Sdk"; cd mobile\android; .\gradlew.bat assembleRelease`
  Install: `%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe install -r mobile\android\app\build\outputs\apk\release\app-release.apk`
- Ledger core ported to TypeScript (`mobile/src/core`): events, double entry, identity, store (SQLite on the phone),
  business days, fusion, inference, rule + bank-SMS parsers, pipeline, sync protocol + engine.
  `cd mobile; npx jest src/core` → 80 tests, golden files from the Python code (`scripts/make_golden.py`).
- Hinglish UI: Aaj, Likho (typed), Udhaar, Stock & waste, Saare hisaab + detail + withdraw, Pura khaata,
  Dukaan ke shabd, Parivaar; Android back button; keyboard no longer hides Jodo.
- Parser fix: typed "or" = "aur", "udhar"/"udhari" known (also in the laptop backend).
- Models already on the phone (checksums verified) in `Android/data/com.cascade.invisibleworker/files/models/`:
  `qwen3-vl-4b-instruct.gguf`, `qwen3-vl-4b-instruct-mmproj.gguf`, `ggml-small.bin`, `ggml-silero-v5.1.2.bin`.
  **Uninstalling the app deletes them** (install with `-r` keeps them).

## In progress (code written, last build installed, NOT yet verified on the phone)

1. **Language model on the phone** (llama.rn 0.12.9 + the same Qwen3-VL weights).
   Prompt and schema are generated from the Python (`scripts/export_prompts.py`) and tested byte-identical.
   To check: Aur → Parivaar → "Model abhi chalu karo" → does it load? Then Likho with
   "3 kilo tamatar liya 180 mein or sharma ji ka 60 udhar" → engine shows the model, 2 entries.
   Record the load time and speed shown on the Model card. If it's too slow, try fewer threads / GPU (OpenCL, Q4_0).
   Files: `mobile/src/app/llm.ts`, `mobile/src/core/extract.ts`, native `AppFilesModule.kt` (gives the model folder).

## Remaining, in order

2. **Slip photos (Parchi)**: port `backend/app/perception/vision.py` (rotation by token log-probs, transcription
   with per-line confidence) + `slip_lines.py` + confirm screen (Record.tsx SlipTab). Needs llama.rn
   `initMultimodal` with the mmproj file, `n_probs`, and a camera / image picker library.
3. **Morning & evening stock counts**: port `backend/app/inventory.py` (questions instead of guesses, recording
   hash dedup, 409 replace guard) + `frontend/src/views/StartDay.tsx` screen. Needs the model (step 1).
4. **Voice (Bolo)**: whisper.rn + `@fugood/react-native-audio-pcm-stream`, Whisper small (`language: 'en'`,
   `prompt` = lexicon hotwords, same as faster-whisper's hotwords), Silero VAD. "Heard" feed with
   "book it anyway". whisper.rn gives no token probabilities → clarity gate needs a small native patch, or every
   voice entry is read back and confirmed with a tap. Microphone permission + foreground service for always-on.
5. **Phone-to-phone sync**: a transport for the existing protocol (`core/protocol.ts`): TCP over one phone's
   hotspot (e.g. react-native-tcp-socket) with peer addresses in Parivaar; later Bluetooth (Nearby Connections).
   Family key check on every message.
6. **Test on the phone end to end**: every screen, a restart (ledger kept), offline (airplane mode).
7. **Merge back**: the parser fix (`rules.py`, `lexicon.json`, test) must also reach `main`.
8. Docs for the app (setup, models over USB) once steps 1–5 work.

## Known issues to watch

- Network here stalls big downloads (NDK 27.1 never finished → app uses NDK 28.2; Gradle has 60 s timeouts).
- Git's `tar` breaks llama.rn's install script on Windows: run `npm install` from PowerShell (Windows tar).
- `@dr.pogodin/react-native-fs` fails RN 0.87 codegen → replaced by our own `AppFilesModule.kt`.
