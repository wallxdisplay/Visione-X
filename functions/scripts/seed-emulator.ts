/**
 * Seeds the LOCAL EMULATORS with plans, the feature catalog, two test accounts and an approved
 * demo organization owned by the test owner.
 * Run while `npm run emulators` is up:  npm run seed
 * Test credentials below are for the emulator only; they never exist in a real project.
 */
process.env.FIRESTORE_EMULATOR_HOST ??= '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST ??= '127.0.0.1:9099';
process.env.FIREBASE_STORAGE_EMULATOR_HOST ??= '127.0.0.1:9199';

import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { paths, type UserProfileDoc } from '@visione-x/shared';
import { applyPlatformRole } from '../src/admin/platformUsers';
import type { Actor, Deps } from '../src/lib/context';
import { reviewOrgSignup } from '../src/orgs/review';
import { submitOrgSignup } from '../src/orgs/signup';
import { seedPlatformData } from '../src/seed/seed';

const PROJECT_ID = 'demo-visione-x';

const TEST_USERS = [
  { email: 'superadmin@visione-x.test', password: 'Test-Admin-2026!', role: 'superadmin' as const },
  { email: 'owner@visione-x.test', password: 'Test-Owner-2026!', role: null },
];

/** Not created by the seed: used to exercise the sign-up flow by hand in the emulator. */
export const MANUAL_SIGNUP_TEST_USER = { email: 'newcustomer@visione-x.test', password: 'Test-Signup-2026!' };

const app = initializeApp({ projectId: PROJECT_ID, storageBucket: `${PROJECT_ID}.appspot.com` });
const deps: Deps = {
  db: getFirestore(app),
  auth: getAuth(app),
  bucket: getStorage(app).bucket(),
  now: () => Date.now(),
};
const { db, auth } = deps;

const written = await seedPlatformData(db, { overwrite: true });
console.log(`Seeded ${written.length} platform documents.`);

const uids: Record<string, string> = {};
for (const u of TEST_USERS) {
  const user = await auth
    .getUserByEmail(u.email)
    .catch(() => auth.createUser({ email: u.email, password: u.password, emailVerified: true }));
  uids[u.email] = user.uid;
  if (u.role) {
    await applyPlatformRole(deps, { uid: user.uid, email: u.email, role: u.role }, { actorType: 'system', actorId: 'seed-script' });
  }
  console.log(`User ready: ${u.email}${u.role ? ` (${u.role})` : ''}`);
}

// Demo organization for the test owner (skipped if they already belong to one).
const ownerUid = uids['owner@visione-x.test']!;
const profile = (await db.doc(paths.userProfile(ownerUid)).get()).data() as UserProfileDoc | undefined;
if (!profile || Object.keys(profile.memberships ?? {}).length === 0) {
  const owner: Actor = { uid: ownerUid, email: 'owner@visione-x.test', emailVerified: true, platformRole: null };
  const admin: Actor = { uid: uids['superadmin@visione-x.test']!, email: 'superadmin@visione-x.test', emailVerified: true, platformRole: 'superadmin' };
  const { requestId } = await submitOrgSignup(deps, owner, {
    orgName: 'Demo Retail (sample)',
    contactName: 'Demo Owner',
    phone: '+91 90000 00000',
    city: 'Pune',
    stateCode: '27',
    expectedScreens: 6,
    timezone: 'Asia/Kolkata',
  });
  await reviewOrgSignup(deps, admin, { requestId, decision: 'approve' });
  console.log('Demo organization ready: Demo Retail (sample)');
}
console.log('Done. Test passwords are in functions/scripts/seed-emulator.ts.');
