import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import type { Actor, Deps } from '../../functions/src/lib/context';
import { seedPlatformData } from '../../functions/src/seed/seed';

export const PROJECT_ID = 'demo-visione-x';

const app = getApps()[0] ?? initializeApp({ projectId: PROJECT_ID });
export const db = getFirestore(app);
export const auth = getAuth(app);

let clock = Date.UTC(2026, 9, 1, 9, 0, 0);
export const deps: Deps = { db, auth, now: () => clock };
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
