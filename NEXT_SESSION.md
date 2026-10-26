# Next session: fix the model download (top priority)

Branch `app`, last commit `dd1b809`. Shared APK: `Desktop\Hisaab-release\Hisaab-1.1.apk` (release key `~/.cascade/hisaab-release.keystore`, passwords in `~/.gradle/gradle.properties`).

## Bug (reported by user)
On a phone with no models: install the APK → Aaj shows "Models download karo" → tap → download starts → **the app exits**.
Only the 0.9 MB Silero file was ever tested in-app (worked); the big files (2.4 GB Qwen, 0.84 GB vision, 0.49 GB Whisper) were never downloaded in-app.

## First step: read the real cause, don't guess
1. Phone on USB, reproduce, then: `adb logcat -d -b crash` and `adb logcat -d | Select-String "invisibleworker|AndroidRuntime|FATAL"`.
2. In-app, Android's last exit reason: `device.lastExit()` (`DeviceModule.lastExit` in `AppFilesModule.kt`).

## Suspects (code: `mobile/android/.../AppFilesModule.kt` → `DeviceModule.download`; JS `src/app/models.ts` `Downloads`, `src/ui/screens/Models.tsx`)
- The download thread catches only `Exception`. An `Error` thrown there, or anything thrown outside the try (inside `Thread {}`), kills the whole process. Catch `Throwable` and reject the promise with it.
- `emit()` is called from the background thread every 500 ms. `getJSModule` can throw if the React context is gone. Guard it with `reactApplicationContext.hasActiveReactInstance()` and a try/catch.
- Hugging Face redirects (302) to a CDN host (cas-bridge / xethub). Check that `HttpURLConnection` follows it and that the `Range` header survives the redirect (resume).
- The process gets killed in the background (the user leaves the app): run the download in a foreground service (like `ListenService`) with a wake lock, or use Android's `DownloadManager` (simplest and most robust: it handles resume, notifications and background). Then verify SHA-256 in-app afterwards.
- After the download: the 2.4 GB SHA-256 check runs on the same thread. That's fine, but report it as "verifying".

## Recommended fix
Use **Android `DownloadManager`** to download into `getExternalFilesDir(null)/models/<file>.part`. Poll progress from JS, verify SHA-256 natively on a thread (catch Throwable), then rename. That removes our own HTTP and threading code.

## Also unverified
- Slip reading with the Hugging Face vision file `mmproj-BF16.gguf` (we switched from the Ollama blob; never tested). Use Jaanch → Parchi test (sample file; push `eval/samples/slips/004_grocery-bill-prices_dim.jpg` to `files/diag/slip.jpg`, chmod 666).
- Two-phone sync on real hardware; airplane-mode pass.

## Known good (measured on the OnePlus 12R)
- The model on CPU only, Q4_0, in RAM (`DEFAULT_SETUP` in `llm.ts`). The slip took 108 s and was correct; the GPU path crashes or is too slow.
- Tests: `cd mobile; npx jest`, 192 pass. Build: `cd mobile\android; .\gradlew.bat assembleRelease`.
- Install over USB: `adb install -r` keeps the models. A signing-key change needs an uninstall, which deletes the models.
