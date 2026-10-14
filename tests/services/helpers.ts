import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import type { Actor, Deps } from '../../functions/src/lib/context';
import type { Mail } from '../../functions/src/lib/email';
import { authzClock } from '../../functions/src/lib/authz';
import { seedPlatformData } from '../../functions/src/seed/seed';

export const PROJECT_ID = 'demo-wallx-play';
export const BUCKET = 'demo-wallx-play.appspot.com';

const app = getApps()[0] ?? initializeApp({ projectId: PROJECT_ID, storageBucket: BUCKET });
export const db = getFirestore(app);
export const auth = getAuth(app);
export const bucket = getStorage(app).bucket(BUCKET);

let clock = Date.UTC(2026, 9, 1, 9, 0, 0);
/** Emails "sent" during a test (cleared by resetEmulator). */
export const outbox: Mail[] = [];
export const deps: Deps = { db, auth, bucket, now: () => clock, mailer: async (mail) => (outbox.push(mail), true) };
// Membership expiry (support access) follows the same fake clock.
authzClock.now = () => clock;
export const advance = (ms: number) => {
  clock += ms;
};

export async function resetEmulator() {
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  if (!host) throw new Error('Run via `npm run test:emulator` so the Firestore emulator is up.');
  await fetch(`http://${host}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`, {
    method: 'DELETE',
  });
  await seedPlatformData(db, { overwrite: true });
  outbox.length = 0;
}

export function user(uid: string, overrides: Partial<Actor> = {}): Actor {
  return {
    uid,
    email: `${uid}@example.com`,
    emailVerified: true,
    platformRole: null,
    ...overrides,
  };
}

export const superadmin = user('root', { platformRole: 'superadmin' });

export async function expectCode(promise: Promise<unknown>, code: string) {
  try {
    await promise;
  } catch (err) {
    const actual = (err as { code?: string }).code;
    if (actual !== code) throw new Error(`Expected error code ${code}, got ${actual}: ${String(err)}`);
    return;
  }
  throw new Error(`Expected error code ${code}, but the call succeeded`);
}
