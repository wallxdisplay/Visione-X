# Local development

## Prerequisites
- Node.js 22+ (`.nvmrc`)
- **Java 11+ (21 recommended)** — required by the Firestore/Storage emulators. Java 8 will not work.
- Firebase CLI is installed as a dev dependency; use `npx firebase …` (or install globally).
- Android Studio + JDK 17 for the player (phase 3).

## First run
```bash
npm install
cp apps/web/.env.example apps/web/.env.local
npm run build -w @visione-x/functions
npm run emulators      # terminal 1: Auth, Firestore, Functions, Storage, Hosting, UI at :4000
npm run dev            # terminal 2: web app at http://localhost:5173
```
The default project is `demo-visione-x`, a demo ID the emulators accept offline; nothing touches
the real Firebase project.

## Checks
```bash
npm run lint
npm run typecheck
npm test               # unit tests
npm run test:rules     # Firestore rules tests (starts the emulator)
```

## Connecting the real Firebase project (when confirmed)
1. `npx firebase login`
2. `npx firebase projects:list` → note the real **project ID** of "Visione-X".
3. `npx firebase use --add <project-id>` with alias `prod` (keep `demo-visione-x` as default).
4. Firebase console → Firestore: if a database exists, note its region; if not, create it in
   **asia-south1**. Region cannot be changed later.
5. Confirm the project is on the **Blaze** plan.
6. Fill `apps/web/.env.local` with the web app config and set `VITE_USE_EMULATORS=false` only for
   deliberate testing against the real project.

Secrets (Razorpay key secret, webhook secret, provider keys) go into Secret Manager via
`npx firebase functions:secrets:set NAME` — never into `.env` files that the web app reads.

## OneDrive note
This repo lives in a OneDrive-synced folder. `node_modules` contains tens of thousands of files;
consider excluding it from sync or moving the repo outside OneDrive to avoid slow installs and
file-lock errors.
