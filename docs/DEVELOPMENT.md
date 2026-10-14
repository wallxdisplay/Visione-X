# Local development

## Prerequisites
- Node.js 22+ (`.nvmrc`)
- Java 21 (Temurin) — required by the Firestore/Auth emulators. The Firebase CLI runs the `java`
  on PATH (it ignores JAVA_HOME), so put Java 21 first on PATH if an older Java is installed.
- Firebase CLI is a dev dependency; use `npx firebase …`.
- Android SDK for the player (`apps/android-player`, Gradle wrapper; Java 21 works). Build output
  goes to `%LOCALAPPDATA%\wallx-play-player-build` because OneDrive locks build files. Tests run on
  Robolectric (`gradlew testDebugUnitTest`), so no emulator or hypervisor is needed.

## Run locally
```bash
npm install
npm run emulators      # terminal 1: builds functions, starts Auth/Firestore/Functions/Storage/Hosting, UI at :4000
npm run seed           # once per emulator start: plans, feature catalog, test accounts
npm run dev            # terminal 2: web app at http://localhost:5173 (talks to the emulators)
npm run dev:functions  # optional terminal 3: rebuild functions on change
```
The default project is `demo-wallx-play`, which the emulators accept offline; nothing touches the
real Firebase project. Test accounts and their passwords are in
`functions/scripts/seed-emulator.ts` (emulator only).

Emails are not sent by the emulator. Verification and password-reset links appear in the
Emulator UI (Authentication tab) and at
`http://127.0.0.1:9099/emulator/v1/projects/demo-wallx-play/oobCodes`.

## Checks
```bash
npm run lint
npm run typecheck
npm test               # unit tests (no emulator)
npm run test:emulator  # security-rules + Cloud Functions service tests on the emulators
```

## How writes work (phase 1+)
Clients only READ Firestore (rules in `firestore.rules`). Every change goes through a callable
Cloud Function (`functions/src/callables.ts`) that validates input with the shared zod schemas,
checks platform/org permissions and org status, and writes an audit entry in the same
transaction (`functions/src/lib/audit.ts`, hash-chained per org).

## Real Firebase project
| Item | Value |
|---|---|
| Project ID | `wallx-play`, number 150108324626 (alias `prod` in `.firebaserc`; default stays `demo-wallx-play`) |
| Firestore | `(default)` database in **asia-south1**, rules + indexes deployed |
| Web app | "WallX Play Web", public config in `apps/web/.env.production` |
| Hosting | site `wallx-play` → https://wallx-play.web.app |
| GitHub | https://github.com/wallxdisplay/Visione-X (CI on every push) |

Every deploy names the project explicitly, e.g.
`npx firebase deploy --only firestore:rules,firestore:indexes --project prod`.

Moved on 2026-10-13 from the earlier `visione-x` project (product renamed Visione-X → WallX Play;
the new project started empty). The old project's hosting is disabled.

### Organization setup notes (avinyabharat.com Google Cloud organization)
The project sits in an organization with Google's secure-by-default policies. Three one-time
fixes were needed on the first project and are applied again on this one:
- **Build service account** — `iam.automaticIamGrantsForDefaultServiceAccounts` is enforced, so
  `150108324626-compute@developer.gserviceaccount.com` was granted
  *Cloud Build Service Account* (`roles/cloudbuild.builds.builder`) manually.
- **Public endpoints** — *Domain restricted sharing* (`iam.allowedPolicyMemberDomains`) blocked
  `allUsers`. It is overridden to **Allow all on the wallx-play project only**. Firebase grants
  public invoker to callable functions only when they are **created**; if a callable ever
  returns a 403 HTML page, delete and redeploy it (`npx firebase functions:delete <name>
  --region asia-south1 --project prod`, then deploy).
- **Functions runtime identity** — functions run as `150108324626-compute@developer.gserviceaccount.com`,
  which (because automatic grants are off) had no data access. Granted: *Cloud Datastore User*,
  *Storage Object Admin*, *Firebase Authentication Admin* (plus the Cloud Build / Run Invoker /
  Eventarc Event Receiver roles above). Symptom when missing: `7 PERMISSION_DENIED` in function logs.
  (Media is served with Firebase Storage download-token URLs, so *Service Account Token Creator*
  is not needed.)
- **Scheduled functions** — the first deploy of `monitorScreens` enabled the Cloud Scheduler API
  automatically. Its job is `firebase-schedule-monitorScreens-asia-south1` (every 5 minutes).
  Since phase 5 it also raises sensor offline/stale alerts.
- **Sensor reading retention (phase 5)** — reading buckets and rate-limit windows carry
  `expiresAt`; TTL policies for both are declared in `firestore.indexes.json` (`fieldOverrides`)
  and deployed with `npx firebase deploy --only firestore:indexes --project prod`. Deploy indexes
  before functions so the monitor's new collection-group queries have their indexes.
- **Storage rules → Firestore** — `storage.rules` reads membership from Firestore, which needs
  `service-150108324626@gcp-sa-firebasestorage.iam.gserviceaccount.com` to hold
  *Firebase Rules Firestore Service Agent* (`roles/firebaserules.firestoreServiceAgent`).
  A non-interactive deploy does not grant it; without it every upload/read is denied.
- **Media processing trigger** — the first Eventarc deploy can fail with "Permission denied while
  using the Eventarc Service Agent"; it is propagation delay, redeploy `functions:processMedia`.
- **Cloud Run CPU quota** — new projects have a small regional CPU quota, so functions use
  `cpu: 'gcf_gen1'` and `maxInstances: 10` (`functions/src/options.ts`). Request a quota
  increase before raising these.

Remaining one-time steps (console):
1. Upgrade to the **Blaze** plan (needed for Cloud Functions, Cloud Run, Secret Manager).
2. Authentication → enable **Email/Password** and **Google** providers.
3. Storage → get started, bucket location **asia-south1**.
4. Deploy functions + hosting, sign up on https://wallx-play.web.app, then grant yourself
   superadmin: `npx tsx functions/scripts/bootstrap.ts --project wallx-play --email <you>`
   (needs Google Cloud SDK and `gcloud auth application-default login`). It also creates plans
   and the feature catalog if they do not exist.
5. Enable MFA for platform staff (Identity Platform) before onboarding real customers.
6. In Google Cloud console → APIs & Services → Credentials, restrict the browser API key to the
   `wallx-play.web.app` / `wallx-play.firebaseapp.com` referrers.
7. **App Check** (web app, reCAPTCHA Enterprise), rolled out in three steps:
   1. Firebase console → App Check → Apps → the web app → **reCAPTCHA Enterprise** → create a
      key for `wallx-play.web.app` and `wallx-play.firebaseapp.com` and save. Put its **site key**
      (public, not a secret) in `apps/web/.env.production` as `VITE_APPCHECK_SITE_KEY=…`, then
      build and deploy hosting. Without the key, or with the emulators, App Check is off.
   2. Monitor for a few days: App Check → APIs shows verified vs unverified requests for
      Firestore and Storage, and callables log `appCheck.missing` in Cloud Logging for calls
      without a valid token. Old browser tabs keep the previous build until reloaded.
   3. Enforce once unverified traffic is gone: App Check → APIs → **Enforce** for Cloud Firestore
      and Cloud Storage, and for callables add `APP_CHECK_ENFORCE=true` to
      `functions/.env.wallx-play` and redeploy functions. Players are not affected: they use the
      device API (`api` function), which authenticates devices with their own credentials.

**Audit-log archive.** `auditExportDaily` (06:00 IST) writes each finished UTC day of the audit
log to a separate bucket as `audit/YYYY/MM/YYYY-MM-DD.ndjson` plus a `.summary.json` (entry
count, SHA-256, last hash per chain). Until the bucket exists it only logs "skipped". One-time
setup (PowerShell, with `CLOUDSDK_PYTHON` set as above):
```powershell
gcloud storage buckets create gs://wallx-play-audit-archive --project wallx-play --location asia-south1 --uniform-bucket-level-access --public-access-prevention
gcloud storage buckets update gs://wallx-play-audit-archive --retention-period 400d
```
Then add `AUDIT_ARCHIVE_BUCKET=wallx-play-audit-archive` to `functions/.env.wallx-play` and
deploy functions. The retention period stops anyone (including admins) from deleting or
changing an exported day for 400 days. Once a few exports look right, you can **lock** it
(`gcloud storage buckets update gs://wallx-play-audit-archive --lock-retention-period`); locking
is permanent and the period can then only be extended.

**Data retention.** `retentionDaily` (03:30 IST) deletes pairing codes a day after they expire,
invitations 30 days after they expire, remote commands and their screenshots after 30 days,
notifications after 90 days, rejected or unfinished player uploads after 7 days, and media
uploads that never finished after a day (giving back the storage they reserved). Periods are in
`functions/src/ops/retention.ts`. Alerts, approvals, emergencies, payments and the audit log are
kept. Sensor readings expire through the TTL policy (plan `retentionDays`).

**Weather provider (Google Weather API).** Production uses Google's Weather API and Geocoding API
(about 10,000 free calls per API each month, then about US$0.15 per 1,000; results are cached per
place). One-time setup in the `wallx-play` Google Cloud project:

1. APIs & Services → Library: enable **Weather API** and **Geocoding API** (billing must be on).
2. APIs & Services → Credentials → Create credentials → API key. Edit it: Application restrictions
   *None* (it is used only by Cloud Functions), API restrictions *Restrict key* → Weather API and
   Geocoding API. Copy the key.
3. `npx firebase functions:secrets:set GOOGLE_MAPS_API_KEY --project wallx-play` and paste it.
4. Add `WEATHER_PROVIDER=google` to `functions/.env.wallx-play` and redeploy functions. That line
   binds the secret to `api`, `previewDataSource` and `geocodePlace` (`WEATHER_SECRETS` in
   `functions/src/options.ts`); binding a secret that does not exist yet would fail the deploy.

Google's terms require the text "Google Maps" next to the weather (exactly that, never
translated): the web renderer, the player and the Integrations page show it automatically. Without
the key, weather falls back to a commercial Open-Meteo key (`OPEN_METEO_API_KEY`) if one is set,
and otherwise shows "not configured" in production. RSS works without any key.

**Air quality (Google Air Quality API).** Air quality widgets use the same key and secret as weather
(`GOOGLE_MAPS_API_KEY`, bound by `WEATHER_PROVIDER=google`); there is no free fallback, so without
the key air quality shows "not configured", also in the emulator. They ask for India's NAQI (CPCB)
and fall back to Google's Universal AQI elsewhere. Results are cached 30 minutes per place (Google
updates hourly); see the Air Quality API pricing page for the per-call price. One-time setup:

1. APIs & Services → Library: enable **Air Quality API** in the `wallx-play` project.
2. APIs & Services → Credentials → the existing weather key ("WallX Play weather") → API
   restrictions: tick **Air Quality API** next to Weather API and Geocoding API, and save. No new
   secret and no redeploy are needed for the key itself; deploy functions with this release.

The "Google Maps" credit rule above applies to air quality too and is shown the same way.

**Email (Gmail / Google Workspace).** Invitations, signup decisions and alert emails are sent
from a Gmail mailbox over SMTP (`functions/src/lib/email.ts`; about 500 recipients a day on @gmail.com, about 2,000 on Workspace):

1. Turn on 2-Step Verification for the sender account (wallxdisplay@gmail.com; a Workspace address works the same way) at
   myaccount.google.com → Security. (A Workspace admin may need to allow it for the domain.)
2. myaccount.google.com → Security → App passwords: create one named "WallX Play". Copy the
   16-character password.
3. `npx firebase functions:secrets:set SMTP_PASSWORD --project wallx-play` and paste it.
4. Add `SMTP_USER=wallxdisplay@gmail.com` to `functions/.env.wallx-play` and redeploy functions.
   That line binds the secret to `inviteMember`, `reviewOrgSignup` and `emailNotification`
   (`MAIL_SECRETS` in `functions/src/options.ts`).

Until then nothing is emailed (a log line says so) and everything else works: invitation links can
be copied from Team. Alert emails go to the members whose permission handles the alert (screen
offline → screen.manage, sensor alerts → sensor.manage, billing → billing.manage, …); support staff
and site-scoped members are skipped. Organizations can turn alert emails off in Settings. A
`mailLog` doc per notification (30-day TTL) makes sure a retried trigger never sends twice.

Secrets (Razorpay key secret, webhook secret, provider keys) go into Secret Manager via
`npx firebase functions:secrets:set NAME` — never into `.env` files that the web app reads.

## OneDrive note
This repo lives in a OneDrive-synced folder. `node_modules` contains tens of thousands of files;
consider excluding it from sync or moving the repo outside OneDrive.
