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

**Weather provider (phase 6).** Open-Meteo's free API is non-commercial, so production needs a
commercial key. Once purchased: `npx firebase functions:secrets:set OPEN_METEO_API_KEY --project prod`,
then bind the secret to the `api`, `previewDataSource` and `geocodePlace` functions (add
`secrets: ['OPEN_METEO_API_KEY']` to their options) and redeploy. Until then weather sources show
"not configured" in production; RSS works without any key.

Secrets (Razorpay key secret, webhook secret, provider keys) go into Secret Manager via
`npx firebase functions:secrets:set NAME` — never into `.env` files that the web app reads.

## OneDrive note
This repo lives in a OneDrive-synced folder. `node_modules` contains tens of thousands of files;
consider excluding it from sync or moving the repo outside OneDrive.
