# What's remaining (Android app, branch `app`)

Updated 2026-10-26. Work folder: `C:\dev\Cascade\Cascade-app` (git worktree on branch `app`); app in `mobile/`.

## Done (on the phone)

- React Native 0.87.1 app, Android only (arm64), no Expo; built locally, installed over USB.
  Build: `$env:ANDROID_HOME="$env:LOCALAPPDATA\Android\Sdk"; cd mobile\android; .\gradlew.bat assembleRelease`
  Install: `%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe install -r mobile\android\app\build\outputs\apk\release\app-release.apk`
- Ledger core in TypeScript (`mobile/src/core`), golden-tested against the Python code.
  `cd mobile; npx jest` → 172 tests (core + screen flows driven like a vendor: tap, type, check the ledger).
- **Always-on listening** (`src/app/mic.ts`, `core/segmenter.ts`, `ListenService.kt`): start/stop on Aaj and Bolo,
  status dot, live level meter with the speech threshold, "heard" feed with what was booked. Cutting at pauses is
  ported from the laptop's `mic.py`; Silero + Whisper read each utterance; audio is never stored. A microphone
  foreground service + wake lock keep it going with the screen off; the choice survives an app restart.
  Verified on the 12R: listening started, the notification showed, real speech was transcribed into the feed.
- **Record one trade** (Bolo) and **stock by voice** share the same mic (one owner), with a level meter and cancel.
- **Start the day:** a big "Naya din shuru karo" card on Aaj (hero card before the first day), then "Subah ka stock bolo".
- **Jaanch karein** (was "Aapke liye / Check karo"): every doubtful or price-less entry has ✓ Sahi hai, ✎ Badlo,
  🗑 Hatao inline; disputes and "ek ya do" decisions inline too. Entry detail has the same actions + an edit form
  (kind, item, qty, unit, amount, customer). Withdraw/correct act on the whole trade (all fused copies).
- **"Sudhaar"** was the label for the `adjustment` kind (the desktop's "Correction"): removed. Such entries now say
  what they did: Hataya / Ek hi maana / Alag maana / Bank: paisa aaya/gaya; the filter is "Badle / hataye".
- **Item spelling** (`core/spelling.ts`): "tamattar"/"tamattax" → "tamatar", "chini" → "cheeni", common words left
  alone; used for typed/heard text, slips and stock; every fix is shown ("“tamattar” ko “tamatar” samjha") and a
  slip line can be put back. Items show in the vendor's word (tomato → tamatar).
- **Sentences without a trade word** ("tomato 200 gram 40 rupee"): not guessed; one tap says Becha/Kharida/…
- **Udhaar:** new udhaar / paisa mila form; per-customer page with balance, "Pura ₹X mila", part payment, give more,
  and full history (tap an entry to fix or remove). All are ledger entries, so they sync.
- **Stock:** big mic button + level meter; read by word rules at once when the model isn't running (CPU model takes
  minutes); questions instead of guesses; saved counts can be edited or removed.
- **Phone pairing without IP addresses:** "Phone dhoondo" asks every address on this phone's Wi-Fi/hotspot (/24) for
  hello on port 45871 and joins the ones with the same chaabi; repeats every minute while no phone is reachable;
  a phone at a new address replaces its old one. Manual address entry is under "technical". Verified on the 12R:
  the server answers a probe and refuses a wrong key.
- **Chaabi** boxes have a 👁️ Dikhao / 🙈 Chhupao button. Slip reading shows elapsed seconds and can be stopped.
- Models on the phone (checksums verified): `qwen3-vl-4b-instruct.gguf` (Q4_K_M), `Qwen3-VL-4B-Instruct-Q4_0.gguf`
  (for the Adreno GPU path), `qwen3-vl-4b-instruct-mmproj.gguf`, `ggml-small.bin`, `ggml-silero-v5.1.2.bin`.
  **Uninstalling the app deletes them** (install with `-r` keeps them).

## Parchi crash (fixed 2026-10-26)

- **Cause** (phone tombstones): SIGSEGV null pointer in `lm_ggml_gallocr_alloc_graph` ← `clip_image_batch_encode`:
  with the Q4_0 file present the model ran on the Adreno GPU (OpenCL) and the vision encoder defaulted to the GPU
  too; OpenCL could not allocate the image encoder's graph and llama.cpp dereferenced null. Every slip crashed.
- **Fix:** vision encoder on the CPU (`use_gpu: false`). Also measured that the GPU path is unusably slow for text
  here (no answer in 5 min; slip answer 0.84 tok/s), so the model now runs on the CPU only (`devices: ['CPU']`;
  llama.rn's `n_gpu_layers` is iOS-only), Q4_0, read into RAM (`use_mmap: false`; mmap through /sdcard FUSE was
  the old >6 min/sentence). Measured: typed sentence 98 s cold / 27 s warm; the grocery slip (eval sample 004)
  108 s, all 10 lines and the ₹565 total right, no crash. Jaanch can switch setups to re-measure.
- **Crash guard:** each native model call is recorded; if Android reports the last run ended in a native crash
  inside one, the GPU is turned off and the vendor is told (swiping the app away does not count).

## Remaining, in order

1. **Two-phone sync on real hardware:** needs a second phone with the app, both on one Wi-Fi/hotspot (the 12R's
   Wi-Fi was off during this test). Then: same chaabi → Phone dhoondo → entries on both.
2. **Slip speed (108 s):** most of it is the CPU image encoder + prompt (82 s). Options to try: a smaller image
   (fewer image tokens), more threads, or a smaller vision model; measure each in Jaanch.
3. **Whisper with Hindi numbers:** English-mode Whisper writes "teen" as "tin", "sau" as "so". The vendor can teach
   such words under Dukaan ke shabd → Ginti; a Hindi-script Whisper + transliteration would be the real fix.
4. **How clearly speech was heard** isn't measured on the phone (whisper.rn gives no word probabilities), so the
   mic's entries carry the parser's confidence only.
5. Full airplane-mode pass over every screen; push to GitHub when asked; parser commit `61bdba3` on `main` is local.

## Known issues to watch

- Network here stalls big downloads (NDK 27.1 never finished → app uses NDK 28.2; Gradle has 60 s timeouts).
- Git's `tar` breaks llama.rn's install script on Windows: run `npm install` from PowerShell (Windows tar).
- PowerShell `Set-Content`/inline Python mangle source files (BOM, quoting): edit with the editor tools.
- `adb exec-out screencap > file` in PowerShell corrupts the PNG: `screencap` to /sdcard, then `adb pull`.
