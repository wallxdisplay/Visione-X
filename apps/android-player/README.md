# WallX Play Player (Android)

Native Kotlin player for Android boxes connected over HDMI to an LED video wall controller.

```
Android box HDMI OUT → LED controller HDMI IN → LED video wall
```

## What it does
- **Pairing:** first start registers the box and shows a 6-character code + QR code. In WallX Play:
  *Screens → Add screen* (or scan the QR with a phone, which opens that form pre-filled).
- **Playback:** plays what is published to the screen — schedules (time-zone aware, priorities),
  layouts with zones, playlists, images, videos (hardware decoding via Media3/ExoPlayer), text,
  clock, QR, table and web widgets. Rendering follows `packages/layout-spec`, like the web preview.
- **Offline:** media is cached by SHA-256 and verified; interrupted downloads resume. A new
  publish is switched in only after every file is downloaded; without internet the last good
  content keeps playing, including after a reboot.
- **Health:** heartbeats every 5 minutes (app version, output resolution, free storage, what is
  playing, recent errors) → visible on the Screens page.
- **Unattended:** full screen, screen stays on, Back is ignored, a crash restarts the app in 3 s.

## Build
Requires the Android SDK (platform 35) and JDK 17+ (`JAVA_HOME`). From this folder:
```bash
./gradlew testDebugUnitTest assembleDebug
```
The APK is written to `app/build/outputs/apk/debug/app-debug.apk` — or, when the project sits in
a OneDrive folder on Windows, to `%LOCALAPPDATA%\wallx-play-player-build\app\outputs\apk\debug\`
(OneDrive locks files mid-build, so the build directory is moved outside it).

Tests: `ScheduleTest` (same cases as the TypeScript resolver), `ManifestFixtureTest` (shared
fixture), and `PlayerEngineTest` (Robolectric + mock server: pairing → authorization → verified
download → corrupted update refused → reset on removal; renders the pairing screen).
Release build: `./gradlew assembleRelease` → `app/build/outputs/apk/release/app-release.apk`,
signed with the WallX Play release key. The build stops if the key is not set up.

### Release signing key (one time)
1. Create the key outside the repo (keytool asks for a password — use the same one for both prompts):
   ```powershell
   New-Item -ItemType Directory -Force D:\wallx-keys
   & "C:\Program Files\Eclipse Adoptium\jdk-21.0.12.101-hotspot\bin\keytool.exe" -genkeypair -v -keystore D:\wallx-keys\wallx-play-release.jks -alias wallx-play -keyalg RSA -keysize 4096 -validity 10000 -dname "CN=WallX Play, O=WallX, C=IN"
   ```
2. Copy `keystore.properties.example` to `keystore.properties` (git-ignored) and fill in the passwords.
3. Back up the `.jks` file and its password somewhere safe (password manager + offline copy). Every
   future player update must be signed with this same key; without it, boxes can only get updates
   by uninstalling (which clears the pairing) and installing again.

Boxes running a debug-signed build (0.7.0 or earlier) cannot be upgraded in place to a release-signed
one: uninstall the old app, install the new one, then remove the old screen in Screens and pair again.

The player talks to `https://wallx-play.web.app/api/v1` by default. To test against the local
emulators from the Android emulator:
`./gradlew assembleDebug -PapiBase=http://10.0.2.2:5001/demo-wallx-play/asia-south1/api/v1`

## Install on a box
1. On the box: *Settings → About → Build number* (tap 7×) → *Developer options* → enable
   **USB debugging** (or **ADB over network**).
2. From the PC: `adb connect <box-ip>:5555` (network) or plug in USB, then
   `adb install -r app-debug.apk`. A USB stick + file manager also works.
3. Open **WallX Play Player** once. It shows the pairing code.

## Start automatically after power-on (choose one)
- **Recommended — set as Home app:** press the remote's Home button, choose *WallX Play Player*,
  *Always*. The box then boots straight into the player and returns to it after any crash.
  (Some boxes: *Settings → Apps → Default apps → Home app*.)
- **Boot receiver:** the app also starts itself on `BOOT_COMPLETED`. This works on most Android
  7–9 boxes; Android 10+ often blocks it unless the app is the Home app or device owner.
- **Kiosk (device owner):** on a freshly reset box with no accounts added, run
  `adb shell dpm set-device-owner com.wallx.play/.KioskAdminReceiver`.
  The player then pins itself (lock task mode) so the remote cannot leave it. To undo, factory-reset
  the box.

## Hardware checklist (test on the real box early)
| Check | How |
|---|---|
| Boots into the player after power cut | Pull the power, plug back in |
| HDMI output resolution matches the LED controller | Box display settings; Screens page shows reported output |
| 1080p H.264 video plays smoothly (hardware decoder) | Publish a video playlist |
| Recovers after network loss | Unplug network for 10 min; content keeps playing; sync resumes |
| Portrait walls | Set the screen's orientation to portrait and use a portrait layout |
| Long-run stability | Leave running 24 h; check Screens page for errors |

## Code map
| Path | What |
|---|---|
| `core/PlayerEngine.kt` | Register → poll → sync → heartbeat loop; offline-safe activation |
| `core/Schedule.kt` | Schedule resolver (port of `layout-spec/src/schedule.ts`, same tests) |
| `data/AssetCache.kt` | Verified, resumable, content-addressed media cache |
| `ui/Render.kt` | Layouts, zones, playlists, media and widgets (Compose) |
| `ui/PlayerRoot.kt` | Pairing / waiting / playback screens |
