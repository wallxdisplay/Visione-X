import type { Auth } from 'firebase-admin/auth';
import type { Firestore } from 'firebase-admin/firestore';
import type { Bucket } from '@google-cloud/storage';
import type { PlatformRole } from '@visione-x/shared';

/** Injected into every service so tests can pass emulator-backed clients and a fixed clock. */
export interface Deps {
  db: Firestore;
  auth: Auth;
  /** Default Storage bucket (media binaries). */
  bucket: Bucket;
  now: () => number;
}

export interface Actor {
  uid: string;
  email: string | null;
  emailVerified: boolean;
  platformRole: PlatformRole | null;
}
