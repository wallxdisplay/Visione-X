import type { Firestore } from 'firebase-admin/firestore';
import { paths } from '@wallx-play/shared';
import { SEED_APPS, SEED_FEATURE_CATALOG, SEED_PLANS } from './data';

/** Writes plans, the feature catalog and the app catalog. With `overwrite: false`, existing docs are kept. */
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
  for (const { costMinor, ...app } of SEED_APPS) {
    const ref = db.doc(paths.app(app.id));
    if (overwrite || !(await ref.get()).exists) {
      await ref.set({ ...app, updatedAt: 0, updatedBy: 'seed' });
      await db.doc(paths.appCost(app.id)).set({ id: app.id, costMinor, note: 'Phase 0 price sheet', updatedAt: 0 });
      written.push(ref.path);
    }
  }
  return written;
}
