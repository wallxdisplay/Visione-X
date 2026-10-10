/**
 * Seeds the LOCAL EMULATORS with plans, the feature catalog and two test accounts.
 * Run while `npm run emulators` is up:  npm run seed
 * Test credentials below are for the emulator only; they never exist in a real project.
 */
process.env.FIRESTORE_EMULATOR_HOST ??= '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST ??= '127.0.0.1:9099';

import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { applyPlatformRole } from '../src/admin/platformUsers';
import { seedPlatformData } from '../src/seed/seed';

const PROJECT_ID = 'demo-visione-x';

const TEST_USERS = [
  { email: 'superadmin@visione-x.test', password: 'Test-Admin-2026!', role: 'superadmin' as const },
  { email: 'owner@visione-x.test', password: 'Test-Owner-2026!', role: null },
];

/** Not created by the seed: used to exercise the sign-up flow by hand in the emulator. */
export const MANUAL_SIGNUP_TEST_USER = { email: 'newcustomer@visione-x.test', password: 'Test-Signup-2026!' };

const app = initializeApp({ projectId: PROJECT_ID });
const db = getFirestore(app);
const auth = getAuth(app);

const written = await seedPlatformData(db, { overwrite: true });
console.log(`Seeded ${written.length} platform documents.`);

for (const u of TEST_USERS) {
  const user = await auth
    .getUserByEmail(u.email)
    .catch(() => auth.createUser({ email: u.email, password: u.password, emailVerified: true }));
  if (u.role) {
    await applyPlatformRole(
      { db, auth, now: () => Date.now() },
      { uid: user.uid, email: u.email, role: u.role },
      { actorType: 'system', actorId: 'seed-script' },
    );
  }
  console.log(`User ready: ${u.email}${u.role ? ` (${u.role})` : ''}`);
}
console.log('Done. Test passwords are in functions/scripts/seed-emulator.ts.');
