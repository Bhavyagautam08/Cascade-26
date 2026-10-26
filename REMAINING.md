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

## In progress / verification notes

- **On-device Qwen:** integrated using llama.rn and installed model files. The prompt/schema match the Python
  exports and Qwen image inference reached an editable Parchi review on the connected phone. It is slow on this
  device; the extracted prices disagreed with the slip total, so review remains mandatory. Ordinary typed
  extraction still needs a focused phone check with the exact sample below.

## Remaining, in order

1. **Voice (Bolo) and spoken stock counts:** implemented with Whisper/Silero. Stock transcript is editable and
   uses the existing model review and explicit save flow; Bolo transcript likewise requires a tap before ledger
   parsing. Focused microphone/recognition test is blocked until microphone permission is allowed on the phone.
2. **Phone-to-phone sync:** TCP transport, peer address list, server status, and family-key checks are wired to
   the existing sync engine. Core protocol/address tests pass; a live handset probe confirmed port `45871`
   listens and rejects an incorrect key. Still needs a second physical phone on the intended hotspot to
   confirm bidirectional sync; plain TCP is limited to trusted LANs.
3. **Full physical-phone validation:** prior ledger entries remained visible after release update/relaunch.
   Still exercise all screens, exact Qwen text sample, Parchi, morning/evening typed and spoken counts, Bolo,
   and airplane-mode operation. Real speech and two-phone sync remain unverified; do not mark complete until
   performed on the devices.
4. **Merge parser fix to `main`:** done as parser-only commit `61bdba3` (rules, lexicon, regression test).
   It is local and one commit ahead of `origin/main`; it has not been pushed.
5. **App setup docs:** added [docs/MOBILE_SETUP.md](docs/MOBILE_SETUP.md) for Android build/install, model USB
   copying, permissions, stock/voice, and LAN sync. Review the instructions against a clean setup before treating
   setup documentation as final.

## Known issues to watch

- Network here stalls big downloads (NDK 27.1 never finished → app uses NDK 28.2; Gradle has 60 s timeouts).
- Git's `tar` breaks llama.rn's install script on Windows: run `npm install` from PowerShell (Windows tar).
- `@dr.pogodin/react-native-fs` fails RN 0.87 codegen → replaced by our own `AppFilesModule.kt`.
- `RECORD_AUDIO` is declared, but the connected phone currently has microphone permission denied.
- Phone sync uses TCP port `45871` on a local network; a second phone is required to validate exchange.
