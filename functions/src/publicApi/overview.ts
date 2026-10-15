/**
 * Super Admin → Integrations & API: which organizations use the API and webhooks, with counts
 * only (active keys, calls today, webhooks and how many WallX switched off). Never key names,
 * key hints or webhook addresses: those are customer data.
 */
import type { z } from 'zod';
import { paths, type ApiKeyDoc, type ApiOverviewInput, type ApiOverviewRow, type EntitlementsDoc, type OrgDoc, type WebhookDoc } from '@wallx-play/shared';
import { requirePlatform } from '../lib/authz';
import type { Actor, Deps } from '../lib/context';

export async function apiOverview(deps: Deps, actor: Actor, _input: z.infer<typeof ApiOverviewInput>): Promise<{ day: string; orgs: ApiOverviewRow[] }> {
  requirePlatform(actor, 'org.view');
  const { db, now } = deps;
  const day = new Date(now()).toISOString().slice(0, 10);
  const orgOf = (path: string) => path.split('/')[1]!;
  const [keys, hooks, usage] = await Promise.all([
    db.collectionGroup('apiKeys').get(),
    db.collectionGroup('webhooks').get(),
    db.collection('apiUsage').where('day', '==', day).get(),
  ]);
  const rows = new Map<string, Omit<ApiOverviewRow, 'name' | 'apiInPlan' | 'webhooksInPlan' | 'limitPerDay'>>();
  const row = (orgId: string) => {
    let r = rows.get(orgId);
    if (!r) rows.set(orgId, (r = { orgId, activeKeys: 0, callsToday: 0, webhooks: 0, webhooksOff: 0 }));
    return r;
  };
  for (const k of keys.docs) if (!(k.data() as ApiKeyDoc).revokedAt) row(orgOf(k.ref.path)).activeKeys++;
  for (const h of hooks.docs) {
    const r = row(orgOf(h.ref.path));
    r.webhooks++;
    if (!(h.data() as WebhookDoc).active) r.webhooksOff++;
  }
  for (const u of usage.docs) row(u.get('orgId') as string).callsToday += Number(u.get('calls') ?? 0);

  const ids = [...rows.keys()];
  const meta = new Map<string, { name: string; ent?: EntitlementsDoc }>();
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const snaps = await db.getAll(...chunk.flatMap((id) => [db.doc(paths.org(id)), db.doc(paths.orgEntitlements(id))]));
    chunk.forEach((id, j) => meta.set(id, { name: (snaps[2 * j]!.data() as OrgDoc | undefined)?.name ?? id, ent: snaps[2 * j + 1]!.data() as EntitlementsDoc | undefined }));
  }
  return {
    day,
    orgs: ids
      .map((id) => {
        const m = meta.get(id)!;
        return {
          ...rows.get(id)!,
          name: m.name,
          apiInPlan: !!m.ent?.features.includes('api.keys'),
          webhooksInPlan: !!m.ent?.features.includes('api.webhooks'),
          limitPerDay: m.ent?.limits.apiCallsPerDay ?? null,
        };
      })
      .sort((a, b) => b.callsToday - a.callsToday || a.name.localeCompare(b.name)),
  };
}
