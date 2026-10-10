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

## Connecting the real Firebase project (when confirmed)
1. `npx firebase login`
2. `npx firebase projects:list` → note the real **project ID** of "Visione-X".
3. `npx firebase use --add <project-id>` with alias `prod` (keep `demo-visione-x` as default).
4. Firebase console → Firestore: if a database exists, note its region; if not, create it in
   **asia-south1**. Region cannot be changed later.
5. Confirm the project is on the **Blaze** plan.
6. Deploy rules, indexes and functions, sign up in the web app, then grant yourself superadmin:
   `npx tsx functions/scripts/bootstrap.ts --project <project-id> --email <you>`
   (requires `gcloud auth application-default login`). It also creates plans and the feature
   catalog if they do not exist.
7. Enable MFA for platform staff (Identity Platform) before onboarding real customers.

Secrets (Razorpay key secret, webhook secret, provider keys) go into Secret Manager via
`npx firebase functions:secrets:set NAME` — never into `.env` files that the web app reads.

## OneDrive note
This repo lives in a OneDrive-synced folder. `node_modules` contains tens of thousands of files;
consider excluding it from sync or moving the repo outside OneDrive.
