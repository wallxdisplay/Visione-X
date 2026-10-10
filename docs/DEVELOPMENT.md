# Local development

## Prerequisites
- Node.js 22+ (`.nvmrc`)
- Java 21 (Temurin) — required by the Firestore/Auth emulators.
- Firebase CLI is a dev dependency; use `npx firebase …`.
- Android Studio + JDK 17 for the player (phase 3).

## Run locally
```bash
npm install
npm run emulators      # terminal 1: builds functions, starts Auth/Firestore/Functions/Storage/Hosting, UI at :4000
npm run seed           # once per emulator start: plans, feature catalog, test accounts
npm run dev            # terminal 2: web app at http://localhost:5173 (talks to the emulators)
npm run dev:functions  # optional terminal 3: rebuild functions on change
```
The default project is `demo-visione-x`, which the emulators accept offline; nothing touches the
real Firebase project. Test accounts and their passwords are in
`functions/scripts/seed-emulator.ts` (emulator only).

Emails are not sent by the emulator. Verification and password-reset links appear in the
Emulator UI (Authentication tab) and at
`http://127.0.0.1:9099/emulator/v1/projects/demo-visione-x/oobCodes`.

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
| Project ID | `visione-x` (alias `prod` in `.firebaserc`; default stays `demo-visione-x`) |
| Firestore | `(default)` database in **asia-south1**, rules + indexes deployed |
| Web app | "Visione-X Web", public config in `apps/web/.env.production` |
| Hosting | site `visione-x` → https://visione-x.web.app |
| GitHub | https://github.com/wallxdisplay/Visione-X (CI on every push) |

Every deploy names the project explicitly, e.g.
`npx firebase deploy --only firestore:rules,firestore:indexes --project prod`.

Remaining one-time steps (console):
1. Upgrade to the **Blaze** plan (needed for Cloud Functions, Cloud Run, Secret Manager).
2. Authentication → enable **Email/Password** and **Google** providers.
3. Storage → get started, bucket location **asia-south1**.
4. Deploy functions + hosting, sign up on https://visione-x.web.app, then grant yourself
   superadmin: `npx tsx functions/scripts/bootstrap.ts --project visione-x --email <you>`
   (needs Google Cloud SDK and `gcloud auth application-default login`). It also creates plans
   and the feature catalog if they do not exist.
5. Enable MFA for platform staff (Identity Platform) before onboarding real customers.
6. In Google Cloud console → APIs & Services → Credentials, restrict the browser API key to the
   `visione-x.web.app` / `visione-x.firebaseapp.com` referrers.

Secrets (Razorpay key secret, webhook secret, provider keys) go into Secret Manager via
`npx firebase functions:secrets:set NAME` — never into `.env` files that the web app reads.

## OneDrive note
This repo lives in a OneDrive-synced folder. `node_modules` contains tens of thousands of files;
consider excluding it from sync or moving the repo outside OneDrive.
