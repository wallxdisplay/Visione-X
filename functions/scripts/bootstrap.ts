/**
 * One-time setup of a REAL Firebase project:
 *   1. writes plans + feature catalog if they do not exist yet (never overwrites), and
 *   2. grants the first WallX superadmin (the account must already exist — sign up first).
 *
 * Usage (after `gcloud auth application-default login` with an account that has access):
 *   npx tsx functions/scripts/bootstrap.ts --project <project-id> --email <you@company.com>
 *
 * Every later role change is made from the Super Admin panel and is audited there.
 */
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { applyPlatformRole } from '../src/admin/platformUsers';
import { seedPlatformData } from '../src/seed/seed';

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const value = i >= 0 ? process.argv[i + 1] : undefined;
  if (!value) {
    console.error('Usage: npx tsx functions/scripts/bootstrap.ts --project <id> --email <email>');
    process.exit(1);
  }
  return value;
}

const projectId = arg('project');
const email = arg('email').toLowerCase();
if (projectId.startsWith('demo-')) {
  console.error('Use `npm run seed` for the emulator; this script is for real projects.');
  process.exit(1);
}

const app = initializeApp({ projectId });
const db = getFirestore(app);
const auth = getAuth(app);

const written = await seedPlatformData(db, { overwrite: false });
console.log(written.length ? `Created: ${written.join(', ')}` : 'Plans and catalog already exist.');

const user = await auth.getUserByEmail(email).catch((err: { code?: string; message?: string }) => {
  if (err.code === 'auth/user-not-found') console.error(`No account for ${email}. Sign up in the web app first, then rerun.`);
  else console.error(`Could not look up ${email}: ${err.code ?? ''} ${err.message ?? err}`);
  process.exit(1);
});
await applyPlatformRole(
  { db, auth, now: () => Date.now() },
  { uid: user.uid, email, role: 'superadmin' },
  { actorType: 'system', actorId: 'bootstrap-script' },
);
console.log(`${email} is now a superadmin. Sign out and back in to pick up the role.`);
