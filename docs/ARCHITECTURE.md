# WallX Play — Architecture & Structure (v0.2)

> Companion docs: [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md) (visual system — product name there reads "WallX SignageOS"; the product name is **WallX Play**, tokens unchanged).
> Status: structure approved for build, pending the confirmations in §18.

## 1. Locked decisions
| Area | Decision |
|---|---|
| Product | **WallX Play**, Indian market first |
| Tenancy | Organization → Sites → Screen Groups → Screens (reseller-ready via `parentAccountId`) |
| Web | React + TypeScript (Vite SPA), one Firebase Hosting site, routes `/`, `/studio`, `/admin`, `/player` |
| Backend | Existing Firebase project **WallX Play** (real project ID to be confirmed): Auth, Firestore, Storage, Cloud Functions 2nd gen, Cloud Run, Scheduler, FCM |
| Region | Firestore `asia-south1` if not yet created (check first); Functions, Cloud Run, Storage bucket in `asia-south1` |
| Player | **Native Android app** on Android box → HDMI → LED controller → LED wall. Boot-start, kiosk, offline-first. `/player` web page is only registration/fallback |
| Sensors | ESP32 → authenticated HTTPS ingest API. MQTT later via same ingestion core |
| Billing | Razorpay (test mode first), INR only in v1, currency-ready model, GST invoices, gateway-agnostic module |
| Pricing | Starter ₹299/screen/mo, Professional ₹599/screen/mo, Enterprise custom; annual −15%; 14-day trial, no card. All values are **data**, never hard-coded |
| Approval | Every new org is `pending` until a Super Admin approves / rejects / requests info. Devices must also be paired + authorized |
| i18n | English UI in v1; i18n framework from day one (Hindi, Marathi later). Content supports Unicode/Devanagari in v1 |
| Scale | Plan for 50 orgs / 500 screens in year 1; architecture target ≥ 5,000 screens |
| Integrations | Provider-adapter pattern (weather: Open-Meteo for dev, license check before prod; RSS: server-side fetch + sanitize + cache) |
| Enforcement | Every permission, limit and publish is enforced server-side (Rules + Functions), never only by hiding UI |

## 2. System overview
```
                      Firebase Hosting (one site)
        ┌──────────────────────────────────────────────────┐
        │  /  (customer app)   /studio   /admin   /player  │   React + TS SPA
        └───────────────┬──────────────────────────────────┘
                        │ Firebase Auth (users)      /api/** rewrite
                        ▼                                   ▼
┌───────────────────────────────────────────────────────────────────────┐
│ Firestore (asia-south1) + Security Rules                              │
│ Cloud Functions 2nd gen (callable + HTTPS API, asia-south1)           │
│ Cloud Run: media transcoding (ffmpeg), RSS/weather fetchers           │
│ Cloud Storage (media, invoices, exports) · Cloud Scheduler · FCM      │
│ Secret Manager (Razorpay keys, provider keys)                         │
└──────▲───────────────────────▲─────────────────────────▲──────────────┘
       │ device token          │ device API key           │ signed webhooks
┌──────┴────────┐      ┌───────┴───────┐           ┌──────┴──────┐
│ Android player│      │ ESP32 sensors │           │  Razorpay   │
│ (Android box) │      │               │           │             │
└──────┬────────┘      └───────────────┘           └─────────────┘
       │ HDMI OUT → LED controller HDMI IN → LED video wall
```

## 3. Repository layout (monorepo, npm workspaces)
```
WallX Play/
  apps/
    web/                 React+TS SPA; route modules: customer, studio, admin, player-registration
    android-player/      Kotlin Android app (Gradle), separate toolchain
  functions/             Cloud Functions (TS), one folder per domain:
    src/{auth,orgs,approvals,members,devices,media,publishing,sensors,integrations,
         billing,notifications,audit,admin,api,scheduler}/
  services/
    media-transcoder/    Cloud Run (ffmpeg)
  packages/
    shared/              TS types, zod schemas, permission keys, feature keys, manifest schema
    billing-core/        PaymentGateway interface + razorpay + manual adapters
    ui/                  design-system components (tokens from DESIGN_SYSTEM.md)
    layout-spec/         JSON schema of layouts/widgets + conformance fixtures (shared by web preview + Android)
  firestore.rules · storage.rules · firestore.indexes.json · firebase.json
  docs/
```
`/admin` code is lazy-loaded and every admin action is re-checked server-side; route hiding is not security.

## 4. Identity, roles, permissions

**Three principal types**
1. **Users** (Firebase Auth with Identity Platform, email/password + Google; two-step verification with an authenticator app (TOTP) mandatory for platform staff, optional for customers). Callables refuse staff tokens without `firebase.sign_in_second_factor` (production only; the Auth emulator has no TOTP), and the web app sends such staff to `/account/security` to set it up.
2. **Devices** (Android players): Firebase Auth custom token with claims `{deviceId, orgId, type:"device"}` issued after pairing + authorization. Can read only their own manifest/commands, write only heartbeat/logs via API.
3. **Sensor devices** (ESP32): no Firebase Auth; per-device API key (hashed) used only against `/api/v1/ingest`.

**Platform roles** (custom claim `platformRole`): `superadmin`, `support`, `billing`, `ops`, `auditor`, each a set of granular permissions (`org.approve`, `org.suspend`, `billing.override`, `support.access.grant`, `device.command`, …).

**Org roles** (`orgs/{orgId}/members/{uid}`): `owner`, `admin`, `editor`, `approver`, `viewer` + custom roles. Optional scope to sites/groups. Claims hold only `{orgIds}`; permissions are read from the member doc in Rules/Functions.
Custom roles (`orgs/{orgId}/roles/{roleId}`, up to 20, managed on the Team page by `member.manage`) are named permission sets: anything an admin has, never `billing.manage`. Members holding one carry a copy of its permissions, rewritten in the same transaction when the role changes; a role in use cannot be deleted.

**Effective access = entitlement (plan ∩ admin overrides ∩ org status) AND role permission AND scope.**

## 5. Organization & device lifecycle
```
Org:    signup → pending ─┬─ approve → active ─┬─ suspend → suspended → reactivate
                          ├─ request_info → info_requested → resubmitted → pending
                          └─ reject (reason) → rejected
Device: app first boot → shows pairing code + QR → org user claims it (assign site/screen)
        → pending_authorization → authorized (org admin; blocked if org not active or screen limit hit)
        → revoked / replaced
```
Only `active` orgs can authorize devices and publish. Users joining an active org need only that org's invitation/role. Admin-created orgs skip signup but follow the same provisioning and audit.

## 6. Firestore data model
```
platform/settings                      global config, maintenance flags
platform/featureCatalog                {key, releaseStatus: planned|beta|ga, category}
platformUsers/{uid}                    staff profile + platformRole
plans/{planId}                         name, currency, pricePerScreen{monthly,annual}, bundles,
                                       addOns, limits{screens,users,storageGB,sensors,retentionDays,apiCalls},
                                       featureKeys[], trialDays, active, version
taxRates/{id}                          configurable (GST 18% placeholder — accountant to confirm)
coupons/{id}
accounts/{accountId}                   (future reseller/dealer) dealer pricing, child orgs
orgs/{orgId}                           name, status, parentAccountId?, timezone, locale,
                                       branding, billingProfile{legalName,GSTIN,address,state},
                                       retentionPolicy, createdAt
  entitlements (doc)                   resolved features + limits (written by Functions only)
  usage (doc)                          counters (Functions only)
  members/{uid}  roles/{roleId}  invites/{id}
  sites/{siteId}                       address, timezone
  screenGroups/{groupId}
  screens/{screenId}                   name, siteId, groupIds, orientation, resolution, aspect,
                                       deviceId?, status, lastSeen, health{}, playerVersion,
                                       manifestVersion, lastPublish{status,at,error}
    commands/{cmdId}                   refresh|restart|screenshot|clearCache|diagnostics → status, result
  media/{mediaId}  folders/{id}        metadata only; binaries in Storage
  layouts/{id}  templates/{id}  widgets/{id}
  playlists/{id}  schedules/{id}       start/end, recurrence, timezone, priority, status
  approvals/{id}                       content approval requests (org setting)
  emergencies/{id}
  sensorDevices/{id}                   ESP32: site/screen mapping, keyHash, lastSeen, rate tier
    channels/{channelId}               type, unit, thresholds, latest{value,ts}, staleAfterSec
    readings/{bucketId}                hourly bucket, ≤ ~500 points/doc
  dataSources/{id}                     weather/RSS/API configs (provider adapter + params)
  alerts/{id}  notifications/{id}
  apiKeys/{id}  webhooks/{id}
  playbackDaily/{yyyymmdd_screenId}    aggregated proof-of-play
  billing/subscription (doc)           planId, interval, quantity, status, trialEnd, gateway ids,
                                       customPricing, discount, manualOverride
  billing/…/invoices/{id}              sequential number (per FY series), lines, taxes, pdfPath, status
  billing/…/creditNotes/{id}  payments/{id}
devices/{deviceId}                     global registry: pairingCodeHash, orgId?, screenId?, status,
                                       hardware{model, androidVersion, resolution}, appVersion
signupRequests/{id}                    approval queue + info-request thread
auditLogs/{id}                         append-only, hash-chained, Functions-write only
supportAccess/{id}                     time-boxed grants (scope, reason, expiresAt, approvedBy)
tickets/{id}/messages/{id}
securityAlerts/{id}  backups/{id}
webhookEvents/{gatewayEventId}         idempotency + raw payload ref
invoiceCounters/{series}               transactional sequential numbering
providerCache/{key}                    weather by rounded lat/lon, RSS by feed hash (TTL)
```
Rules: deny-by-default; anything money-, limit-, status- or audit-related is Functions-write only.

## 7. Publishing & sync
1. Draft → (optional content approval) → publish to screen / group / bulk.
2. Function validates entitlement + permissions + org status, then **compiles a manifest per screen**: layouts, playlists, schedule rules (with timezone and priority), media list (URL, size, SHA-256), widget configs, data bindings, fallback content, `version`.
3. Manifest saved to Storage (`manifests/{orgId}/{screenId}/{version}.json`) and `screens/{id}.manifestVersion` bumped; FCM data message nudges the device (Firestore listener as fallback).
4. Device downloads manifest → downloads/validates missing assets → atomically switches only when everything is ready → reports `lastPublish` result.
5. Priority on device (works offline): Emergency > high-priority schedule > normal schedule > default playlist > fallback.

**As built (phase 4):**
- **Manifest storage.** The manifest is stored at `orgs/{org}/screenManifests/{screenId}` in Firestore, not in Storage. The device polls `GET /api/v1/devices/me` every 30 s and fetches the manifest when `manifestVersion` changes. An FCM nudge is deferred, since many boxes have no Play Services.
- **Publish approval.** When an org turns on `settings.requirePublishApproval` (Professional plan and above), publishing by members without `content.approve` creates `approvals/{id}` and notifies approvers. `reviewPublish` then approves (publishes) or rejects (a note is required).
- **Emergency override.** An emergency lives in `emergencies/{id}`. It targets all screens, sites, groups or individual screens. Starting one requires typing `START EMERGENCY`. The content is a playlist or a full-screen message, with an optional duration. The emergency is compiled into every affected manifest and republished on start and end. Timed emergencies are expired by the monitor.
- **Remote commands.** Commands are stored in `screens/{id}/commands/{cmd}`: refresh, restart_app, reboot (falls back to restart without Device Owner), clear_cache, screenshot (JPEG in Storage at `orgs/{org}/screenshots/...`) and diagnostics. `/me` carries `commandsPending`. The player fetches pending commands from `GET /devices/commands` and reports the outcome to `POST /devices/commands/result`. Unanswered commands expire after 30 minutes.
- **Monitoring.** The scheduled function `monitorScreens` runs every 5 minutes (Asia/Kolkata). It raises one `screen_offline` notification per outage; the heartbeat clears it and sends `screen_online`. It also expires emergencies and stale commands.
- **Notifications.** Notifications are stored in-app at `notifications/{id}` with a per-user `readBy`. Important types are also emailed (Gmail SMTP) to the members who handle them; see §13.

## 8. Android player (core requirement)
**Recommended stack:** Kotlin, Jetpack Compose for layout zones, **Media3/ExoPlayer** (hardware decoding) for video/audio, Coil for images, WebView only for web-page/HTML widgets, WorkManager + OkHttp for resumable downloads, Room for local manifest/state, Firebase Auth + FCM SDKs.

| Requirement | Approach |
|---|---|
| Boot start | `RECEIVE_BOOT_COMPLETED` receiver + app set as HOME launcher; watchdog restarts after crash |
| Kiosk / full screen | Immersive mode; Device Owner + Lock Task Mode where provisioning allows; fallback "launcher mode" on boxes without DO |
| Pairing | Pairing code + QR on screen → claimed in web app → custom token issued → secure storage (EncryptedSharedPreferences/Keystore) |
| Offline | Last good manifest + assets on local storage; checksum-verified; LRU cleanup of unreferenced assets |
| Interrupted downloads | HTTP Range resume, temp files, atomic rename, retry with backoff |
| Rendering | Layout-spec JSON → Compose zones; widgets: image, video, text (Devanagari fonts bundled), table, clock, web, QR, chart, gauge, status, sensor value |
| Resolution / orientation | Reads HDMI mode; layout scaled to canvas with letterbox; rotation in software for portrait walls |
| Telemetry | Heartbeat every 5 min (configurable), playback counters batched, error logs with ring buffer upload |
| Remote | refresh, restart app, screenshot, diagnostics; reboot only where device permissions allow |
| Updates | Super Admin uploads a signed APK (server reads package, version, signer; signer must match the first release) and rolls it out: draft → pilot orgs → all → withdrawn. Players get the offer on `GET /devices/me`, download + verify in the background, install via PackageInstaller (silent on device owner / Android 12+, otherwise prompt shown only on a key press or the `install_update` command) and report progress in heartbeats. First install is by hand (sideload); MDM later |

**Hardware risk:** boot-start, kiosk, decoding limits, HDMI modes and power-loss recovery vary by box. **We need the target Android box model early** and will build a hardware test checklist.

**Preview parity:** Studio preview is web (React), player is native. Both consume `packages/layout-spec`; a shared fixtures suite (rendered screenshots) keeps them consistent.

## 9. Sensors (ESP32)
- `POST /api/v1/ingest` with `Authorization: Bearer <device key>`; payload `{deviceId, ts, readings:[{channel, value}]}`.
- Validation: key hash → device → org (active) → channel exists → value type/range → timestamp skew window → rate limit (token bucket per device) → store.
- Writes: `channels/{id}.latest` + hourly bucket doc; alert rule evaluation; stale/offline computed from `staleAfterSec`.
- Player receives live values via a compact per-screen `liveData` feed (only bound channels), polled/pushed at plan-defined frequency; shows **No data / Stale / Device offline** states.
- ESP32 reference firmware (Arduino) with HTTPS + key provisioning provided later.
- MQTT bridge later reuses the same validation/ingestion core.

**As built (phase 5):**
- **Devices and keys.** A sensor device lives in `orgs/{org}/sensorDevices/{id}`. Its API key (`wxp_…`, 192 bits) is shown once. Only the key's SHA-256 is stored, in the server-only `sensorKeys/{hash}` lookup. The key can be rotated, and the old key stops working at once. Creating a device needs `sensor.manage`, the `sensor.esp32` feature and room under the plan's `sensorDevices` limit.
- **Channels** live in `sensorDevices/{id}/channels/{key}`, with at most 16 per device. Each channel has a key the firmware sends (`temp`, `door`), a type (number, or on/off stored as 1/0), an optional valid range, `staleAfterSec` and up to 5 alert rules. A rule is an operator, a limit, a severity and an optional hysteresis.
- **Ingest** is at `POST /api/v1/ingest`. The body is `{ts?, fw?, deviceId?, readings[]}`, where `ts` is Unix seconds or ms and is optional. The checks are: key, device active, org active, plan entitlement, token bucket (burst 6, then 1 per 10 s), clock skew within ±10 min, and per-reading channel, type and range. Accepted readings update `channel.latest`. They are appended to the UTC hour bucket `channels/{key}/readings/{YYYYMMDDHH}`, whose `expiresAt` comes from the plan's `retentionDays`. Alert rules are evaluated in the same transaction. A late reading only goes into history.
- **Alerts** are stored at `orgs/{org}/alerts/{id}` with type `threshold`, `stale` or `offline`, and status `open` or `resolved`. They can be acknowledged. Opening one raises a notification (`sensor_alert`, `sensor_stale`, `sensor_offline`); recovery raises `sensor_recovered` or `sensor_online`. The 5-minute monitor raises offline alerts after `offlineAfterMin` and stale alerts when a channel stops while its device still reports. A dead device gets a single offline alert: its channels are parked rather than each raising a stale alert.
- **Widgets.** `sensorValue`, `gauge`, `chart` (up to 3 series, 5 min–24 h) and `status` bind `{source:"sensor", sourceId: device, field: channel}`. Saving checks the feature and that the channel exists. The manifest lists `liveChannels`. The player polls `GET /devices/live` at the plan’s `liveRefreshSec` (10–300 s, returned with each response; empty = 10 s, plans without it 15 s) and `GET /devices/live/history` every 5 min, and appends live values to chart series in between. A screen only receives channels its manifest binds. Display rules (No data / Stale / Sensor offline, colour bands, status matching) are in `packages/layout-spec/src/live.ts`, mirrored in the player's `core/Live.kt`.
- **Firmware.** The Arduino reference sketch is in `firmware/esp32-sensor` (DHT22 + door switch, NTP, TLS with a pinned root CA).
- **Retention.** Reading buckets carry `expiresAt`. A Firestore TTL policy on the `readings` collection group, declared in `firestore.indexes.json`, deletes them.

## 10. Billing (modular)
- `PaymentGateway` interface (createCustomer, createSubscription, changeQuantity, changePlan, cancel, createOrder, verifyWebhookSignature, parseEvent). Adapters: **razorpay**, **manual** (bank transfer / admin invoice); others later.
- Keys only in Secret Manager; client receives only `subscription_id`/`order_id` + public key id.
- **Payment state changes only from verified webhooks** (HMAC check, idempotent by event id). Client callback just shows "processing".
- Invoices: sequential per financial-year series via transaction counter, PDF to Storage, base price and GST shown separately (CGST/SGST vs IGST by place of supply — confirm with accountant), credit notes for downgrades/refunds.
- Flows: trial (14 d, no card) → subscribe → add screens / upgrade / downgrade (at period end) → grace period on failure → restricted (players keep last content, editing/publishing locked) → suspended.
- Super Admin: plans, prices, limits, features, trials, coupons, custom enterprise/dealer pricing, manual invoices, mark paid, activate/suspend — all audited with reason.
- Entitlements recomputed by Function on any change and enforced in Rules + Functions (e.g. device authorization blocked at screen limit).

**As built (phase 6, billing round, manual payments only):**
- **No invoicing here.** Tax invoices are issued by a separate invoicing app. This app records payments and can store the external invoice number. Razorpay and the gateway adapters are deferred, and the `PaymentGateway` interface stays unused for now.
- **Subscription** is stored at `orgs/{org}/billing/subscription`. It holds the plan, monthly or annual interval, screens purchased (`quantity`), an optional custom per-screen price, an extra discount, the computed price per period before GST, trial end, the paid period, `cancelAtPeriodEnd`, `nextTransitionAt` and the reminders already sent. Status is derived from dates by `billingState()` (`packages/shared/src/billing.ts`) and never set by hand. The statuses are `active` (paid period running), `trialing`, `past_due` (7-day grace after the period ends), `cancelled` (cancelled at period end, no grace) and `restricted` (trial over unpaid, or grace over).
- **Summary on the org doc.** `orgs/{org}.billing` carries `{status, restricted, planId, trialEndsAt, currentPeriodEnd}`, so every member sees banners. While restricted or cancelled, `requireActiveOrgPermission` refuses `BILLING_LOCKED_PERMISSIONS` (content edits, publishing, screen/device management, sensor management). Players keep playing, and emergency, commands, members, settings and deletes still work.
- **Billing staff** are platform roles with `billing.override`. They change plan, interval, screens and pricing, record payments (`orgs/{org}/payments`, amount incl. GST, method, reference, external invoice no.), void payments, adjust trial and paid-through dates, and cancel or undo at period end. Each change carries an audited reason. A payment extends the period from the current end while it is running or in grace, so a late payment keeps the billing date. Otherwise the period starts today. Paid plans without a fixed screen limit get `limits.screens = quantity`.
- **Monitor.** The 5-minute monitor re-derives subscriptions whose `nextTransitionAt` has passed. It sends reminders (trial ends in 3 days, renewal due in 7) and status notifications (`billing_past_due`, `billing_restricted`), and audits status changes as `billing-monitor`.
- **Customers** (`billing.manage`, i.e. owners) see `/billing`: plan, usage, price, paid period and payments. They can send requests (`orgs/{org}/billingRequests`: add screens, change plan, renew, cancel). Billing staff resolve requests from `/admin/billing`, and the customer is notified.
- **Plans and release status.** Super Admin (`plan.manage`) edits plans and feature release status at `/admin/features`. `org.limits.edit` sets per-org entitlement overrides. Each of these recomputes the affected organizations' entitlements.

**As built (phase 6, integrations: weather and RSS):**
- **Data sources** live at `orgs/{org}/dataSources/{id}`, of type `weather` (place name + coordinates, found with Open-Meteo geocoding) or `rss` (feed URL + number of headlines). Creating one needs `integration.manage` and the `widget.weather` / `widget.rss` plan feature. A source cannot be deleted while a layout or playlist uses it.
- **Fetching** happens only on the server. Results are cached centrally in `providerCache/{key}` (server-only, with a TTL policy): weather per place rounded to about 1 km for 15 minutes, RSS per feed URL for 10 minutes. On a provider error the last good result is served (marked not up to date) for up to 24 hours, and retries back off for 2 minutes.
- **RSS safety.** Feeds are reduced to plain-text headlines (tags stripped, entities decoded, length-capped). They are never rendered as HTML. Every request hop, including redirects, is resolved and refused if it points at private, loopback, link-local or metadata addresses. Requests use standard ports only, a 1 MB cap and an 8 s timeout.
- **Weather licence.** Open-Meteo's free API is non-commercial, so it is used only in the emulator and local development. In production the provider requires a commercial API key (`OPEN_METEO_API_KEY`). Without it, weather requests fail with "not configured" rather than calling the free API. Attribution "Weather data by Open-Meteo.com" is shown in the app.
- **Widgets.** `weather` (current conditions, or with a 3-day forecast) and `rss` (headline carousel, seconds per headline, optional feed name). Saving checks the feature and that the source exists with the right type. The manifest lists `dataSources`, and the player fetches `GET /devices/data` every 5 minutes, keeping the last values offline. Web previews use the `previewDataSource` callable through the same cache.
- **Air quality.** Data source type `air_quality` (a place, like weather) and widget `aqi` (compact: score and category in the band colour; detailed: also the dominant pollutant and index name). Values come from the Google Air Quality API (`currentConditions:lookup` with `LOCAL_AQI`: India's NAQI by CPCB, else Universal AQI) with the weather key, cached per place for 30 minutes; there is no free fallback. It comes with the `widget.weather` plan feature and shows the "Google Maps" credit like weather (player 0.12.0).

## 11. Super Admin (`/admin`)
Platform overview · Organization approvals (approve/reject/request info) · Organizations · Users & roles · Screens & players · Features & limits · Plans & billing · Integrations & API · Support access (time-boxed, scoped, customer-visible, no secrets) · Tickets · Notifications · Security alerts · Backup & recovery (scheduled Firestore exports) · Platform analytics · Audit logs · Platform settings.

## 12. Security
- Rules unit-tested with the emulator in CI; App Check on web; rate limits on public endpoints.
- Platform staff sign in with a second factor (TOTP); every callable refuses a staff session without one. Firestore/Storage rules do not check it yet (staff reads rely on the `platformRole` claim alone).
- Device and API keys hashed (shown once), rotate/revoke flows.
- Audit logs: Functions-only append, hash chain, daily export to retention-locked bucket.
- Support access issues a short-lived scoped token; never reveals passwords or unmasked secrets.
- Input sanitization for RSS/HTML widgets; web widgets sandboxed on device.
- Data retention: a daily job removes expired pairing codes and invitations, old remote commands, screenshots and notifications, and abandoned uploads (releasing their reserved storage); customer history and the audit log are kept (docs/DEVELOPMENT.md).

## 13. Notifications
In-app (`notifications`) + email: the `emailNotification` trigger on `orgs/{orgId}/notifications/{id}` emails action-needed types to active members holding the matching permission (not support staff or site-scoped members), once per notification (`mailLog`, 30-day TTL), unless the org turns it off (`settings.emailNotifications`). Invitations and signup decisions are emailed directly by their callables. Sender: Gmail / Workspace SMTP (`SMTP_USER` + secret `SMTP_PASSWORD`). FCM web push later. Events: org approval status, screen offline, publish failed, sensor threshold/stale, limit approaching, payment failed, invoice issued, emergency triggered, security alert.

## 13a. Proof-of-play (v1.1)
Players count what they show — each media item and layout, also inside layout zones — as plays and seconds per UTC hour (`core/PlayLog.kt`), keep the counts in a file through restarts and offline days, and upload finished hours to `POST /api/v1/devices/plays` with a batch id (a retry after a lost response counts once: `devices/{id}/playBatches`, 7-day TTL). The server folds them into one summary per screen per local day in the org's time zone, `orgs/{orgId}/playStats/{date}_{screenId}` (items, hours, totals), about 24 writes per screen per day; nothing is stored unless the plan has `report.proofOfPlay`. Summaries expire after the plan's `retentionDays` (TTL). Clients never read playStats directly: the `playbackReport` callable checks `report.view`, the plan feature and the member's sites, and returns totals by content, screen, day and hour plus CSV rows (≤ 92 days, ≤ 20,000 summaries per report).

## 14. Internationalization
`i18next` with JSON resources in `apps/web/src/locales/{en,hi,mr}`; all UI strings externalized. The language is chosen per browser (top bar) and Hindi/Marathi load on demand; missing keys fall back to English, and a unit test keeps every translation's keys and `{{placeholders}}` identical to English. Dates follow the language (`en-IN`, `hi-IN`, `mr-IN` with Latin digits). Screen content (clock, weather, charts) follows the player and stays English. Hindi and Marathi are machine-drafted and need review by native speakers. Fonts: Inter (UI) + Noto Sans Devanagari (content, bundled on player).

## 15. Scale & cost guardrails (target 5,000 screens)
- Heartbeat 5 min ≈ 1.44 M writes/day at 5k screens — acceptable; online state derived from `lastSeen`, detail only on change.
- Sensor readings bucketed; never one hot doc for many writers.
- Manifest/asset delivery from Storage (CDN-cached signed URLs), not Firestore reads.
- Provider results cached centrally (weather by location, RSS by feed).
- Load test ingest + publish before onboarding large deployments; budget alerts on the GCP project.

## 16. Plan features vs release status
Feature catalogue stores `releaseStatus` (what WallX has built) separately from `plans.featureKeys` (what a plan includes). Planned features show "Coming soon" and cannot be enabled until `ga`.

| Feature | Release | Trial | Starter | Professional | Enterprise |
|---|---|---|---|---|---|
| Media, playlists, schedules, offline playback | v1 | ✓ | ✓ | ✓ | ✓ |
| Multi-zone layouts, templates | v1 | ✓ | ✓ | ✓ | ✓ |
| Text, clock, QR, table, web widgets | v1 | ✓ | ✓ | ✓ | ✓ |
| Weather, air quality, RSS widgets | v1 | ✓ | – | ✓ | ✓ |
| Content approval workflow | v1 | – | – | ✓ | ✓ |
| ESP32 sensors & data widgets | v1 | limited | – | ✓ | ✓ |
| Emergency override | v1 | ✓ | ✓ | ✓ | ✓ |
| Screen monitoring, remote refresh/restart | v1 | ✓ | ✓ | ✓ | ✓ |
| Proof-of-play reports, diagnostics | v1.1 | – | – | ✓ | ✓ |
| API keys & webhooks | v1.1 | – | – | – | ✓ |
| Hindi / Marathi UI | later | — all plans — |
| Multi-screen sync, interactive/touch, MQTT | later | – | – | – | ✓ |
| Self-service reseller portal, white-label | later | – | – | – | ✓ |
*Plan columns are a proposal — confirm or edit.*

## 17. Delivery order (your priority)
| # | Milestone | Contents |
|---|---|---|
| 0 ✅ | Foundation | Monorepo, Firebase project wiring, emulators, CI, design tokens, i18n, shared schemas |
| 1 ✅ | Identity & tenancy | Auth, signup → approval flow, orgs, members/roles, Rules + tests, audit log core, admin approvals UI |
| 2 ✅ | Content | Media library + transcoding, layout studio, widgets (core), playlists, schedules, preview |
| 3 ✅ (real-box test pending) | Android player | Pairing/authorization, boot-start, kiosk, HDMI playback, offline cache, rendering |
| 4 ✅ | Publish & monitor | Manifest compiler, sync, bulk publish, emergency override, heartbeats, remote commands, diagnostics |
| 5 ✅ (real ESP32 test pending) | Sensors | Ingest API, ESP32 firmware sample, channels, thresholds, data widgets, alerts |
| 6 ✅ | Billing & beyond | Manual billing ✅; weather + RSS integrations ✅; player auto-updates ✅; Help & Support, support access, platform settings ✅; Hindi/Marathi (draft, review pending) ✅; reseller groundwork ✅; retention + audit export ✅. Google Weather (needs the API key secret) and Gmail emails (need the App Password secret) ✅. Air quality (AQI) widget with India NAQI, Google Air Quality API on the weather key ✅. Later: Razorpay. Invoices: external app |
| v1.1 🚧 | Reports, analytics, API | Proof-of-play: player counting (0.13.0), upload API, daily summaries, Playback Reports page with CSV ✅. Next: analytics & diagnostics, API keys & webhooks |

## 18. Still to confirm
1. Real Firebase **project ID** and **Hosting site ID** (display name "WallX Play" is not the ID), and whether Firestore already exists (region).
2. Target **Android box model** (and Android version) for early hardware testing; whether boxes can be provisioned as Device Owner.
3. Android stack: native Kotlin (recommended above) — confirm.
4. Plan/feature matrix in §16.
5. Email provider for transactional mail (e.g. Resend, SendGrid, Amazon SES).
6. Billing plan on Firebase must be **Blaze** (Functions, Cloud Run, Secret Manager need it).
