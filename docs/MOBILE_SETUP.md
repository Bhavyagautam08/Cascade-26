# Android app setup

The Android app is in `mobile/`. It is a React Native app (not Expo) and runs its ledger and models on-device.
No backend or internet connection is required for normal ledger use.

## Build and install

Install Android Studio/SDK, Node.js 22.11 or newer, and the project dependencies. From PowerShell:

```powershell
Set-Location C:\path\to\Cascade\mobile
npm install
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
Set-Location .\android
.\gradlew.bat assembleRelease
```

Install or update the app over USB without uninstalling it:

```powershell
$adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
& $adb install -r .\app\build\outputs\apk\release\app-release.apk
```

Run the install command from `mobile\android`. Use `install -r`, not uninstall/reinstall: Android removes this
app's external files (including the large models) when the app is uninstalled. The ledger database is private
app data and is also removed on uninstall.

## Copy the on-device models

Obtain the four model files from the project's approved model source; this guide intentionally does not provide
third-party download links or checksums. Copy the files with their exact names:

- `qwen3-vl-4b-instruct.gguf` — text parsing and inventory extraction
- `qwen3-vl-4b-instruct-mmproj.gguf` — Qwen image/slip reading
- `ggml-small.bin` — Whisper speech transcription
- `ggml-silero-v5.1.2.bin` — voice activity detection

With the phone connected over USB and USB debugging enabled, from PowerShell:

```powershell
$adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
$models = "/sdcard/Android/data/com.cascade.invisibleworker/files/models"
& $adb shell "mkdir -p $models && chmod 755 $models"
& $adb push C:\path\to\models\qwen3-vl-4b-instruct.gguf "$models/"
& $adb push C:\path\to\models\qwen3-vl-4b-instruct-mmproj.gguf "$models/"
& $adb push C:\path\to\models\ggml-small.bin "$models/"
& $adb push C:\path\to\models\ggml-silero-v5.1.2.bin "$models/"
& $adb shell "chmod 755 $models"
& $adb shell "ls -l $models"
```

The exact directory is Android's app-specific external-files directory. If Qwen or voice reports a model is
missing/inaccessible, check the spelling, file sizes, and directory traversal permissions. Do not copy a model
into `Android/data` for a different app package. A release update installed with `-r` preserves these files.

## First launch and local ledger

On first launch set this phone's unique name and a family sync key in the setup screen. Keep the key available
for the other family phones; each phone stores its own copy. The ledger is stored locally in SQLite and is
usable offline.

In **Aur → Parivaar**, the model card can load Qwen and report its measured load/inference timings. Model
initialization and especially handwritten slip reading can take a long time and use substantial memory on a
phone. Review model output before confirming it. Slip, inventory, and voice drafts must be explicitly reviewed
before ledger writes.

## Spoken stock and Bolo

The app asks Android for microphone permission when recording starts. If permission was denied, enable
Microphone for Cascade in Android Settings and try again. Whisper and Silero model files must be present.
Speak a short count, stop recording, correct the editable recognized text if needed, choose morning or evening,
then read, review, and explicitly save the resulting inventory draft. For ordinary Bolo, the transcript is also
editable and requires a separate user tap before it is parsed into ledger entries.

## Phone-to-phone sync (local network)

The current transport is newline-framed TCP on port `45871`; both phones must be on the same trusted Wi-Fi or
phone hotspot. Keep Cascade open on both phones during sync. In **Parivaar**:

1. Set the same family key on both phones.
2. On each phone, find its private/local IPv4 address in Android's Wi-Fi/hotspot details.
3. Add the other phone's address (for example `192.168.43.1`) to each phone's peer list.
4. Confirm the server says it is listening, then use **Abhi milao** or wait for automatic sync.
5. Verify each phone reports the other as connected and check the ledger on both phones.

Only private/local IPv4 peers are accepted. Some hotspot configurations prevent clients from connecting to one
another; if sync stays unreachable, verify both phones share the same LAN, client isolation is disabled, the
peer address is current, and the local network permits TCP port `45871`.

Important: this initial transport is plain TCP, not encrypted. The family key is sent with each request to
refuse unrelated peers, but it does not encrypt ledger data on the LAN. Use only a trusted network. The sync
server is intended for use while the app is open; background/closed-app sync and Bluetooth discovery are not
implemented.

## Current device-test limits

Automated core tests and Android release builds do not replace testing with two physical phones. Verify on real
devices: microphone permission and recognition; a photo transcription and its reviewed result; sync in both
directions on the intended hotspot; restart persistence; and ledger entry while in airplane mode. Do not treat
sync as confirmed until a second phone has actually exchanged entries.
