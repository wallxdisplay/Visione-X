# Visione-X by WallX — Architecture & Structure (v0.2)

> Companion docs: [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md) (visual system — product name there reads "WallX SignageOS"; the product name is **Visione-X by WallX**, tokens unchanged).
> Status: structure approved for build, pending the confirmations in §18.

## 1. Locked decisions
| Area | Decision |
|---|---|
| Product | **Visione-X by WallX**, Indian market first |
| Tenancy | Organization → Sites → Screen Groups → Screens (reseller-ready via `parentAccountId`) |
| Web | React + TypeScript (Vite SPA), one Firebase Hosting site, routes `/`, `/studio`, `/admin`, `/player` |
| Backend | Existing Firebase project **Visione-X** (real project ID to be confirmed): Auth, Firestore, Storage, Cloud Functions 2nd gen, Cloud Run, Scheduler, FCM |
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
Visione-X/
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
1. **Users** (Firebase Auth, email/password + Google; MFA mandatory for platform staff).
2. **Devices** (Android players): Firebase Auth custom token with claims `{deviceId, orgId, type:"device"}` issued after pairing + authorization. Can read only their own manifest/commands, write only heartbeat/logs via API.
3. **Sensor devices** (ESP32): no Firebase Auth; per-device API key (hashed) used only against `/api/v1/ingest`.

**Platform roles** (custom claim `platformRole`): `superadmin`, `support`, `billing`, `ops`, `auditor`, each a set of granular permissions (`org.approve`, `org.suspend`, `billing.override`, `support.access.grant`, `device.command`, …).

**Org roles** (`orgs/{orgId}/members/{uid}`): `owner`, `admin`, `editor`, `approver`, `viewer` + custom roles. Optional scope to sites/groups. Claims hold only `{orgIds}`; permissions are read from the member doc in Rules/Functions.

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
| Updates | v1: manual/sideload APK + in-app update check; later: MDM or managed update channel |

**Hardware risk:** boot-start, kiosk, decoding limits, HDMI modes and power-loss recovery vary by box. **We need the target Android box model early** and will build a hardware test checklist.

**Preview parity:** Studio preview is web (React), player is native. Both consume `packages/layout-spec`; a shared fixtures suite (rendered screenshots) keeps them consistent.

## 9. Sensors (ESP32)
- `POST /api/v1/ingest` with `Authorization: Bearer <device key>`; payload `{deviceId, ts, readings:[{channel, value}]}`.
- Validation: key hash → device → org (active) → channel exists → value type/range → timestamp skew window → rate limit (token bucket per device) → store.
- Writes: `channels/{id}.latest` + hourly bucket doc; alert rule evaluation; stale/offline computed from `staleAfterSec`.
- Player receives live values via a compact per-screen `liveData` feed (only bound channels), polled/pushed at plan-defined frequency; shows **No data / Stale / Device offline** states.
- ESP32 reference firmware (Arduino) with HTTPS + key provisioning provided later.
- MQTT bridge later reuses the same validation/ingestion core.

## 10. Billing (modular)
- `PaymentGateway` interface (createCustomer, createSubscription, changeQuantity, changePlan, cancel, createOrder, verifyWebhookSignature, parseEvent). Adapters: **razorpay**, **manual** (bank transfer / admin invoice); others later.
- Keys only in Secret Manager; client receives only `subscription_id`/`order_id` + public key id.
- **Payment state changes only from verified webhooks** (HMAC check, idempotent by event id). Client callback just shows "processing".
- Invoices: sequential per financial-year series via transaction counter, PDF to Storage, base price and GST shown separately (CGST/SGST vs IGST by place of supply — confirm with accountant), credit notes for downgrades/refunds.
- Flows: trial (14 d, no card) → subscribe → add screens / upgrade / downgrade (at period end) → grace period on failure → restricted (players keep last content, editing/publishing locked) → suspended.
- Super Admin: plans, prices, limits, features, trials, coupons, custom enterprise/dealer pricing, manual invoices, mark paid, activate/suspend — all audited with reason.
- Entitlements recomputed by Function on any change and enforced in Rules + Functions (e.g. device authorization blocked at screen limit).

## 11. Super Admin (`/admin`)
Platform overview · Organization approvals (approve/reject/request info) · Organizations · Users & roles · Screens & players · Features & limits · Plans & billing · Integrations & API · Support access (time-boxed, scoped, customer-visible, no secrets) · Tickets · Notifications · Security alerts · Backup & recovery (scheduled Firestore exports) · Platform analytics · Audit logs · Platform settings.

## 12. Security
- Rules unit-tested with the emulator in CI; App Check on web; rate limits on public endpoints.
- Device and API keys hashed (shown once), rotate/revoke flows.
- Audit logs: Functions-only append, hash chain, daily export to retention-locked bucket.
- Support access issues a short-lived scoped token; never reveals passwords or unmasked secrets.
- Input sanitization for RSS/HTML widgets; web widgets sandboxed on device.
- Data retention jobs per org policy (Cloud Scheduler).

## 13. Notifications
Firestore-triggered event bus → in-app (`notifications`) + email provider (adapter) + FCM web push later. Events: org approval status, screen offline, publish failed, sensor threshold/stale, limit approaching, payment failed, invoice issued, emergency triggered, security alert.

## 14. Internationalization
`i18next` with namespaced JSON resources; all UI strings externalized from the first commit; locale-aware dates/numbers (Intl, `en-IN`); fonts: Inter (UI) + Noto Sans Devanagari (content, bundled on player).

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
| Weather, RSS widgets | v1 | ✓ | – | ✓ | ✓ |
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
| 0 | Foundation | Monorepo, Firebase project wiring, emulators, CI, design tokens, i18n, shared schemas |
| 1 | Identity & tenancy | Auth, signup → approval flow, orgs, members/roles, Rules + tests, audit log core, admin approvals UI |
| 2 | Content | Media library + transcoding, layout studio, widgets (core), playlists, schedules, preview |
| 3 | Android player | Pairing/authorization, boot-start, kiosk, HDMI playback, offline cache, rendering |
| 4 | Publish & monitor | Manifest compiler, sync, bulk publish, emergency override, heartbeats, remote commands, diagnostics |
| 5 | Sensors | Ingest API, ESP32 firmware sample, channels, thresholds, data widgets, alerts |
| 6 | Billing & beyond | Razorpay, invoices/GST, admin billing tools, integrations, Hindi/Marathi, reseller groundwork |

## 18. Still to confirm
1. Real Firebase **project ID** and **Hosting site ID** (display name "Visione-X" is not the ID), and whether Firestore already exists (region).
2. Target **Android box model** (and Android version) for early hardware testing; whether boxes can be provisioned as Device Owner.
3. Android stack: native Kotlin (recommended above) — confirm.
4. Plan/feature matrix in §16.
5. Email provider for transactional mail (e.g. Resend, SendGrid, Amazon SES).
6. Billing plan on Firebase must be **Blaze** (Functions, Cloud Run, Secret Manager need it).
