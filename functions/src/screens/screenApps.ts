/**
 * App store, phase 3: apps per screen. In app pricing each screen app (weather, news, touch,
 * sync, proof-of-play, diagnostics) runs on as many screens as were bought. Every screen keeps
 * the apps it holds and the features it may not use (`apps`, `blockedFeatures`); manifests,
 * report uploads, diagnostics, sync groups and touch settings read those. `syncScreenApps`
 * recomputes them after anything that changes seats or the trial, and screens whose blocked
 * features changed are republished so their content follows at once.
 */
import { HttpsError } from 'firebase-functions/v2/https';
import type { z } from 'zod';
import {
  normalizeSubscription,
  paths,
  planScreenApps,
  type AppDoc,
  type EntitlementOverridesDoc,
  type ScreenDoc,
  type SetAppScreensInput,
  type SubscriptionDoc,
} from '@wallx-play/shared';
import { auditedTransaction } from '../lib/audit';
import { requireActiveOrgPermission } from '../lib/authz';
import type { Actor, Deps } from '../lib/context';
import { publishToScreens } from './screens';

const userAudit = (actor: Actor) => ({ actorType: 'user' as const, actorId: actor.uid, ...(actor.email ? { actorEmail: actor.email } : {}) });
const same = (a: readonly string[] = [], b: readonly string[] = []) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Recomputes seats and blocked features for every screen; returns the screens whose blocked features changed. */
export async function syncScreenApps({ db }: Deps, orgId: string): Promise<string[]> {
  return db.runTransaction(async (tx) => {
    const [subSnap, overridesSnap, appsSnap, screensSnap] = await Promise.all([
      tx.get(db.doc(paths.orgSubscription(orgId))),
      tx.get(db.doc(paths.orgEntitlementOverrides(orgId))),
      tx.get(db.collection(paths.apps())),
      tx.get(db.collection(paths.screens(orgId))),
    ]);
    if (!subSnap.exists) return [];
    const sub = normalizeSubscription(subSnap.data() as SubscriptionDoc);
    const catalog = appsSnap.docs.map((d) => d.data() as AppDoc);
    const screens = screensSnap.docs.map((d) => d.data() as ScreenDoc);
    const plan = planScreenApps({
      appPricing: sub.pricing === 'apps' && catalog.some((a) => a.base),
      trialing: sub.status === 'trialing',
      catalog,
      lines: sub.apps ?? [],
      screens: screens.map((s) => ({ id: s.id, name: s.name, authorized: s.status === 'authorized', apps: s.apps ?? [] })),
      grants: (overridesSnap.data() as EntitlementOverridesDoc | undefined)?.grant ?? [],
    });
    const changed: string[] = [];
    for (const s of screens) {
      const next = plan.get(s.id)!;
      const appsChanged = !same([...(s.apps ?? [])].sort(), next.apps);
      const blockedChanged = !same(s.blockedFeatures ?? [], next.blocked);
      if (!appsChanged && !blockedChanged) continue;
      tx.update(db.doc(paths.screen(orgId, s.id)), { apps: next.apps, blockedFeatures: next.blocked });
      // Only screens that already play published content need it again.
      if (blockedChanged && s.status === 'authorized' && s.manifestVersion > 0) changed.push(s.id);
    }
    return changed;
  });
}

/** Seats and blocked features, then fresh manifests for the screens whose apps changed. */
export async function syncAndRepublish(deps: Deps, orgId: string): Promise<number> {
  const ids = await syncScreenApps(deps, orgId);
  if (!ids.length) return 0;
  const snaps = await deps.db.getAll(...ids.map((id) => deps.db.doc(paths.screen(orgId, id))));
  return publishToScreens(deps, orgId, snaps.map((s) => s.data() as ScreenDoc).filter(Boolean));
}

/** Puts a screen app on exactly these screens; remaining seats are filled automatically. */
export async function setAppScreens(deps: Deps, actor: Actor, input: z.infer<typeof SetAppScreensInput>): Promise<{ republished: number }> {
  const { db, now } = deps;
  await auditedTransaction(db, [input.orgId], async (tx, audit) => {
    const { member } = await requireActiveOrgPermission(tx, db, actor, input.orgId, 'screen.manage');
    if (member.siteScope?.length) throw new HttpsError('permission-denied', 'Only members with access to all sites can move apps between screens.');
    const sub = normalizeSubscription((await tx.get(db.doc(paths.orgSubscription(input.orgId)))).data() as SubscriptionDoc);
    if (sub.pricing !== 'apps') throw new HttpsError('failed-precondition', 'This organization is billed by plan; its features apply to every screen.');
    const app = (await tx.get(db.doc(paths.app(input.appId)))).data() as AppDoc | undefined;
    if (!app || app.unit !== 'screen' || app.base) throw new HttpsError('invalid-argument', 'Only screen apps are placed on screens.');
    const line = (sub.apps ?? []).find((l) => l.appId === input.appId && l.quantity > 0);
    if (!line) throw new HttpsError('failed-precondition', `${app.name} is not bought.`);
    const wanted = new Set(input.screenIds);
    if (wanted.size > line.quantity) throw new HttpsError('failed-precondition', `${app.name} is bought for ${line.quantity} screens.`);
    const screens = (await tx.get(db.collection(paths.screens(input.orgId)))).docs.map((d) => d.data() as ScreenDoc);
    for (const id of wanted) {
      const s = screens.find((x) => x.id === id);
      if (!s) throw new HttpsError('not-found', 'Screen not found.');
      if (s.status !== 'authorized') throw new HttpsError('failed-precondition', `Authorize “${s.name}” first.`);
    }
    for (const s of screens) {
      const has = (s.apps ?? []).includes(input.appId);
      if (has === wanted.has(s.id)) continue;
      const apps = wanted.has(s.id) ? [...(s.apps ?? []), input.appId] : (s.apps ?? []).filter((a) => a !== input.appId);
      tx.update(db.doc(paths.screen(input.orgId, s.id)), { apps: apps.sort() });
    }
    audit(input.orgId, {
      at: now(),
      ...userAudit(actor),
      orgId: input.orgId,
      action: 'screen.apps.assigned',
      target: { type: 'app', id: input.appId },
      data: { screens: [...wanted] },
    });
  });
  return { republished: await syncAndRepublish(deps, input.orgId) };
}
