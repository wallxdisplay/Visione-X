import type { Firestore } from 'firebase-admin/firestore';
import { paths } from '@wallx-play/shared';
import { SEED_FEATURE_CATALOG, SEED_PLANS } from './data';

/** Writes plans and the feature catalog. With `overwrite: false`, existing docs are kept. */
export async function seedPlatformData(db: Firestore, { overwrite }: { overwrite: boolean }) {
  const written: string[] = [];
  for (const plan of SEED_PLANS) {
    const ref = db.doc(paths.plan(plan.id));
    if (overwrite || !(await ref.get()).exists) {
      await ref.set(plan);
      written.push(ref.path);
    }
  }
  const catalogRef = db.doc(paths.featureCatalog());
  if (overwrite || !(await catalogRef.get()).exists) {
    await catalogRef.set({ features: SEED_FEATURE_CATALOG });
    written.push(catalogRef.path);
  }
  return written;
}
