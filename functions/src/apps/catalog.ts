/**
 * App catalog (App store, phase 1): the apps WallX sells and their prices (Super Admin,
 * plan.manage). Costs are kept apart in the staff-only appCosts collection. Subscriptions start
 * using the catalog in phase 2; until then nothing here changes what customers get or pay.
 */
import { FieldValue, type Firestore, type Transaction } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import type { z } from 'zod';
import { PLATFORM_AUDIT_CHAIN, catalogProblems, paths, type AppCostDoc, type AppDoc, type SaveAppInput } from '@wallx-play/shared';
import { auditedTransaction, platformAudit } from '../lib/audit';
import { requirePlatform } from '../lib/authz';
import type { Actor, Deps } from '../lib/context';
import { SEED_APPS } from '../seed/data';
import { recomputeEntitlements } from '../billing/plans';

async function readApps(tx: Transaction, db: Firestore): Promise<AppDoc[]> {
  return (await tx.get(db.collection(paths.apps()))).docs.map((d) => d.data() as AppDoc);
}

/** Refuses a catalog that would sell a feature twice, depend on unknown apps, loop, or have several base apps. */
function checkCatalog(apps: AppDoc[]) {
  const p = catalogProblems(apps);
  if (p.duplicated.length) {
    const d = p.duplicated[0]!;
    throw new HttpsError('failed-precondition', `“${d.feature}” would be sold by more than one app (${d.apps.join(', ')}).`);
  }
  if (p.missingRequires.length) throw new HttpsError('invalid-argument', `App “${p.missingRequires[0]!.requires}” does not exist.`);
  if (p.cycles.length) throw new HttpsError('invalid-argument', 'Apps cannot require each other in a circle.');
  if (p.baseCount > 1) throw new HttpsError('failed-precondition', 'Only one app can be the base screen app.');
}

/** Create or edit an app (prices, features, dependencies, cost). Audited with a reason. */
export async function saveApp(deps: Deps, actor: Actor, input: z.infer<typeof SaveAppInput>): Promise<{ orgsUpdated: number }> {
  const { db, now } = deps;
  requirePlatform(actor, 'plan.manage');
  let featuresChanged = false;
  await auditedTransaction(db, [PLATFORM_AUDIT_CHAIN], async (tx, audit) => {
    const apps = await readApps(tx, db);
    const before = apps.find((a) => a.id === input.id);
    if (input.isNew && before) throw new HttpsError('already-exists', `An app with id “${input.id}” already exists.`);
    if (!input.isNew && !before) throw new HttpsError('not-found', 'App not found.');
    const costBefore = (await tx.get(db.doc(paths.appCost(input.id)))).data() as AppCostDoc | undefined;
    const at = now();
    const app: AppDoc = {
      id: input.id,
      name: input.name,
      description: input.description,
      unit: input.unit,
      featureKeys: [...new Set(input.featureKeys)].sort(),
      requires: [...new Set(input.requires)],
      base: input.base,
      limitBoosts: input.storageGBPerUnit ? { storageGB: input.storageGBPerUnit } : {},
      priceMinor: input.priceMinor,
      active: input.active,
      sortOrder: input.sortOrder,
      updatedAt: at,
      updatedBy: actor.uid,
    };
    checkCatalog([...apps.filter((a) => a.id !== input.id), app]);
    featuresChanged = !before || before.featureKeys.join() !== app.featureKeys.join() || before.active !== app.active || before.base !== app.base || JSON.stringify(before.limitBoosts) !== JSON.stringify(app.limitBoosts);
    tx.set(db.doc(paths.app(input.id)), app);
    tx.set(db.doc(paths.appCost(input.id)), { id: input.id, costMinor: input.costMinor, dealerPriceMinor: input.dealerPriceMinor, note: input.costNote ?? '', updatedAt: at } satisfies AppCostDoc);
    audit(PLATFORM_AUDIT_CHAIN, {
      at,
      ...platformAudit(actor),
      orgId: null,
      action: before ? 'app.updated' : 'app.created',
      target: { type: 'app', id: input.id },
      reason: input.reason,
      data: {
        to: { priceMinor: app.priceMinor, dealerPriceMinor: input.dealerPriceMinor, unit: app.unit, featureKeys: app.featureKeys, active: app.active, costMinor: input.costMinor },
        ...(before ? { from: { priceMinor: before.priceMinor, dealerPriceMinor: costBefore?.dealerPriceMinor ?? before.dealerPriceMinor ?? null, unit: before.unit, featureKeys: before.featureKeys, active: before.active, costMinor: costBefore?.costMinor ?? null } } : {}),
      },
    });
  });
  // What an app turns on decides what app-priced organizations may use. Prices do not change
  // existing lines (they are locked), so a price-only change needs no recompute.
  return { orgsUpdated: featuresChanged ? await recomputeEntitlements(deps) : 0 };
}

/** Adds the starting catalog (from the price sheet) for apps that do not exist yet. */
export async function seedAppCatalog({ db, now }: Deps, actor: Actor): Promise<{ added: number }> {
  requirePlatform(actor, 'plan.manage');
  return auditedTransaction(db, [PLATFORM_AUDIT_CHAIN], async (tx, audit) => {
    const apps = await readApps(tx, db);
    const have = new Set(apps.map((a) => a.id));
    const at = now();
    const added = SEED_APPS.filter((a) => !have.has(a.id)).map(({ costMinor, dealerPriceMinor, ...a }) => ({ app: { ...a, updatedAt: at, updatedBy: actor.uid } as AppDoc, costMinor, dealerPriceMinor }));
    // Apps saved before dealer prices moved to appCosts: move them (not readable by customers there).
    const legacy = apps.filter((a) => a.dealerPriceMinor !== undefined);
    const legacyCosts = await Promise.all(legacy.map(async (a) => ({ app: a, cost: (await tx.get(db.doc(paths.appCost(a.id)))).data() as AppCostDoc | undefined })));
    if (!added.length && !legacy.length) return { added: 0 };
    checkCatalog([...apps, ...added.map((a) => a.app)]);
    for (const { app, costMinor, dealerPriceMinor } of added) {
      tx.set(db.doc(paths.app(app.id)), app);
      tx.set(db.doc(paths.appCost(app.id)), { id: app.id, costMinor, dealerPriceMinor, note: 'Phase 0 price sheet', updatedAt: at } satisfies AppCostDoc);
    }
    for (const { app, cost } of legacyCosts) {
      tx.set(db.doc(paths.appCost(app.id)), { id: app.id, costMinor: cost?.costMinor ?? 0, note: cost?.note ?? '', ...cost, dealerPriceMinor: cost?.dealerPriceMinor ?? app.dealerPriceMinor ?? null, updatedAt: at });
      tx.update(db.doc(paths.app(app.id)), { dealerPriceMinor: FieldValue.delete() });
    }
    audit(PLATFORM_AUDIT_CHAIN, { at, ...platformAudit(actor), orgId: null, action: 'app.catalogSeeded', target: { type: 'app', id: 'catalog' }, data: { apps: added.map((a) => a.app.id) } });
    return { added: added.length };
  });
}
