import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import type { Deps } from './context';

let deps: Deps | undefined;

/** Lazily initialised production dependencies (tests build their own Deps). */
export function getDeps(): Deps {
  if (!deps) {
    const app = getApps()[0] ?? initializeApp();
    deps = {
      db: getFirestore(app),
      auth: getAuth(app),
      bucket: getStorage(app).bucket(),
      now: () => Date.now(),
    };
  }
  return deps;
}
