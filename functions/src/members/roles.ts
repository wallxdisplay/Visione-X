import type { Transaction } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import type { z } from 'zod';
import {
  CUSTOM_ROLE_PERMISSIONS,
  MAX_CUSTOM_ROLES,
  ORG_PERMISSIONS,
  paths,
  SYSTEM_ORG_ROLE_PERMISSIONS,
  SYSTEM_ORG_ROLES,
  type DeleteRoleInput,
  type InviteDoc,
  type OrgPermission,
  type RoleDoc,
  type SaveRoleInput,
  type SystemOrgRole,
} from '@wallx-play/shared';
import { auditedTransaction } from '../lib/audit';
import { getOrg, requireOrgActive, requireOrgPermission } from '../lib/authz';
import type { Actor, Deps } from '../lib/context';

/** Keeps permissions in the canonical order, so stored lists compare and diff cleanly. */
const ordered = (ps: readonly OrgPermission[]) => ORG_PERMISSIONS.filter((p) => ps.includes(p));

/**
 * What a member gets for a role choice: the system role's permissions, or a copy of the custom
 * role's (reads only).
 */
export async function resolveRole(
  tx: Transaction,
  db: Deps['db'],
  orgId: string,
  role: SystemOrgRole | 'custom',
  customRoleId: string | undefined,
): Promise<{ role: SystemOrgRole | 'custom'; customRoleId?: string; roleName: string; permissions: OrgPermission[] }> {
  if (role !== 'custom') return { role, roleName: role, permissions: [...SYSTEM_ORG_ROLE_PERMISSIONS[role]] };
  if (!customRoleId) throw new HttpsError('invalid-argument', 'Choose a custom role.');
  const snap = await tx.get(db.doc(paths.role(orgId, customRoleId)));
  if (!snap.exists) throw new HttpsError('not-found', 'That role no longer exists.');
  const r = snap.data() as RoleDoc;
  return { role, customRoleId, roleName: r.name, permissions: ordered(r.permissions) };
}

function userAudit(actor: Actor) {
  return { actorType: 'user' as const, actorId: actor.uid, ...(actor.email ? { actorEmail: actor.email } : {}) };
}

/** Creates or edits a custom role; members holding it get the new permissions at once. */
export async function saveRole(
  { db, now }: Deps,
  actor: Actor,
  input: z.infer<typeof SaveRoleInput>,
): Promise<{ roleId: string }> {
  const at = now();
  const ref = input.roleId ? db.doc(paths.role(input.orgId, input.roleId)) : db.collection(paths.roles(input.orgId)).doc();
  const permissions = ordered(input.permissions);
  if (permissions.some((p) => !CUSTOM_ROLE_PERMISSIONS.includes(p))) {
    throw new HttpsError('invalid-argument', 'Billing management stays with owners and cannot be part of a custom role.');
  }
  const name = input.name.trim();
  if ((SYSTEM_ORG_ROLES as readonly string[]).includes(name.toLowerCase())) {
    throw new HttpsError('already-exists', `“${name}” is a built-in role name. Choose another name.`);
  }

  await auditedTransaction(db, [input.orgId], async (tx, audit) => {
    await requireOrgPermission(tx, db, actor, input.orgId, 'member.manage');
    requireOrgActive(await getOrg(tx, db, input.orgId));
    const [existing, roles, holders] = await Promise.all([
      input.roleId ? tx.get(ref) : Promise.resolve(null),
      tx.get(db.collection(paths.roles(input.orgId))),
      input.roleId ? tx.get(db.collection(paths.members(input.orgId)).where('customRoleId', '==', input.roleId)) : Promise.resolve(null),
    ]);
    if (input.roleId && !existing?.exists) throw new HttpsError('not-found', 'Role not found.');
    const others = roles.docs.filter((d) => d.id !== ref.id).map((d) => d.data() as RoleDoc);
    if (others.some((r) => r.name.toLowerCase() === name.toLowerCase())) {
      throw new HttpsError('already-exists', `A role called “${name}” already exists.`);
    }
    if (!input.roleId && roles.size >= MAX_CUSTOM_ROLES) {
      throw new HttpsError('resource-exhausted', `An organization can have up to ${MAX_CUSTOM_ROLES} custom roles.`);
    }

    const before = existing?.data() as RoleDoc | undefined;
    const role: RoleDoc = {
      id: ref.id,
      name,
      description: input.description ?? '',
      permissions,
      createdAt: before?.createdAt ?? at,
      createdBy: before?.createdBy ?? actor.uid,
      updatedAt: at,
      updatedBy: actor.uid,
    };
    tx.set(ref, role);
    for (const d of holders?.docs ?? []) tx.update(d.ref, { permissions });
    audit(input.orgId, {
      at,
      ...userAudit(actor),
      orgId: input.orgId,
      action: before ? 'role.updated' : 'role.created',
      target: { type: 'role', id: ref.id },
      data: {
        name,
        permissions,
        ...(before ? { before: { name: before.name, permissions: before.permissions }, membersUpdated: holders?.size ?? 0 } : {}),
      },
    });
  });
  return { roleId: ref.id };
}

/** Deletes a custom role nobody holds (members or pending invitations). */
export async function deleteRole({ db, now }: Deps, actor: Actor, input: z.infer<typeof DeleteRoleInput>): Promise<void> {
  const at = now();
  await auditedTransaction(db, [input.orgId], async (tx, audit) => {
    await requireOrgPermission(tx, db, actor, input.orgId, 'member.manage');
    const ref = db.doc(paths.role(input.orgId, input.roleId));
    const [snap, members, invites] = await Promise.all([
      tx.get(ref),
      tx.get(db.collection(paths.members(input.orgId)).where('customRoleId', '==', input.roleId).limit(1)),
      tx.get(db.collection(paths.invites(input.orgId)).where('customRoleId', '==', input.roleId).where('status', '==', 'pending')),
    ]);
    if (!snap.exists) throw new HttpsError('not-found', 'Role not found.');
    if (!members.empty) throw new HttpsError('failed-precondition', 'Members still have this role. Give them another role first.');
    if (invites.docs.some((d) => (d.data() as InviteDoc).expiresAt > at)) {
      throw new HttpsError('failed-precondition', 'A pending invitation uses this role. Revoke it first.');
    }
    const role = snap.data() as RoleDoc;
    tx.delete(ref);
    audit(input.orgId, {
      at,
      ...userAudit(actor),
      orgId: input.orgId,
      action: 'role.deleted',
      target: { type: 'role', id: input.roleId },
      data: { name: role.name, permissions: role.permissions },
    });
  });
}

