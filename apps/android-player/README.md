# Visione-X Player (Android)

Native Kotlin app for the Android box connected over HDMI to the LED video wall controller.
Scaffolded in **phase 3** (see `docs/ARCHITECTURE.md` §8).

Planned stack: Kotlin, Jetpack Compose, Media3/ExoPlayer, Coil, WorkManager + OkHttp, Room,
Firebase Auth (custom device token) and FCM.

It consumes the manifest/layout contract defined in `packages/layout-spec` (`SPEC_VERSION`).

## Prerequisites
- Android Studio (latest stable) with JDK 17+
- The target Android box for early hardware tests (boot start, kiosk, HDMI modes, decoding)
