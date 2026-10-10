import { HttpsError } from 'firebase-functions/v2/https';
import type { z } from 'zod';
import {
  paths,
  type DeleteSiteInput,
  type SiteDoc,
  type UpdateOrgSettingsInput,
  type UpsertSiteInput,
} from '@visione-x/shared';
import { auditedTransaction } from '../lib/audit';
import { getOrg, requireOrgActive, requireOrgPermission } from '../lib/authz';
import type { Actor, Deps } from '../lib/context';
import { fanOutOrgToProfiles, readMembers } from '../lib/profiles';

function userAudit(actor: Actor) {
  return {
    actorType: 'user' as const,
    actorId: actor.uid,
    ...(actor.email ? { actorEmail: actor.email } : {}),
  };
}

export async function updateOrgSettings(
  { db, now }: Deps,
  actor: Actor,
  input: z.infer<typeof UpdateOrgSettingsInput>,
): Promise<void> {
  const at = now();
  await auditedTransaction(db, [input.orgId], async (tx, audit) => {
    await requireOrgPermission(tx, db, actor, input.orgId, 'org.settings.edit');
    const org = await getOrg(tx, db, input.orgId);
    requireOrgActive(org);
    const members = org.name !== input.name ? await readMembers(tx, db, input.orgId) : [];

    tx.update(db.doc(paths.org(input.orgId)), {
      name: input.name,
      timezone: input.timezone,
      updatedAt: at,
    });
    fanOutOrgToProfiles(tx, db, members, { id: org.id, name: input.name, status: org.status }, at);
    audit(input.orgId, {
      at,
      ...userAudit(actor),
      orgId: input.orgId,
      action: 'org.settings.updated',
      target: { type: 'org', id: input.orgId },
      data: {
        name: { before: org.name, after: input.name },
        timezone: { before: org.timezone, after: input.timezone },
      },
    });
  });
}

export async function upsertSite(
  { db, now }: Deps,
  actor: Actor,
  input: z.infer<typeof UpsertSiteInput>,
): Promise<{ siteId: string }> {
  const at = now();
  return auditedTransaction(db, [input.orgId], async (tx, audit) => {
    await requireOrgPermission(tx, db, actor, input.orgId, 'site.manage');
    requireOrgActive(await getOrg(tx, db, input.orgId));

    const ref = input.siteId
      ? db.doc(paths.site(input.orgId, input.siteId))
      : db.collection(paths.sites(input.orgId)).doc();
    const existing = input.siteId ? await tx.get(ref) : null;
    if (existing && !existing.exists) throw new HttpsError('not-found', 'Site not found.');

    const site: SiteDoc = {
      id: ref.id,
      name: input.name,
      ...(input.address ? { address: input.address } : {}),
      timezone: input.timezone,
      createdAt: existing ? (existing.data() as SiteDoc).createdAt : at,
      updatedAt: at,
    };
    tx.set(ref, site);
    audit(input.orgId, {
      at,
      ...userAudit(actor),
      orgId: input.orgId,
      action: existing ? 'site.updated' : 'site.created',
      target: { type: 'site', id: ref.id },
      data: { name: input.name, timezone: input.timezone },
    });
    return { siteId: ref.id };
  });
}

export async function deleteSite(
  { db, now }: Deps,
  actor: Actor,
  input: z.infer<typeof DeleteSiteInput>,
): Promise<void> {
  const at = now();
  await auditedTransaction(db, [input.orgId], async (tx, audit) => {
    await requireOrgPermission(tx, db, actor, input.orgId, 'site.manage');
    requireOrgActive(await getOrg(tx, db, input.orgId));
    const ref = db.doc(paths.site(input.orgId, input.siteId));
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Site not found.');
    const screens = await tx.get(
      db.collection(`orgs/${input.orgId}/screens`).where('siteId', '==', input.siteId).limit(1),
    );
    if (!screens.empty) {
      throw new HttpsError('failed-precondition', 'Move or remove the screens at this site first.');
    }

    tx.delete(ref);
    audit(input.orgId, {
      at,
      ...userAudit(actor),
      orgId: input.orgId,
      action: 'site.deleted',
      target: { type: 'site', id: input.siteId },
      data: { name: (snap.data() as SiteDoc).name },
    });
  });
}
