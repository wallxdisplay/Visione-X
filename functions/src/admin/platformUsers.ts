import { HttpsError } from 'firebase-functions/v2/https';
import type { z } from 'zod';
import {
  paths,
  PLATFORM_AUDIT_CHAIN,
  type PlatformRole,
  type PlatformUserDoc,
  type SetPlatformRoleInput,
} from '@visione-x/shared';
import { auditedTransaction } from '../lib/audit';
import { requirePlatform } from '../lib/authz';
import type { Actor, Deps } from '../lib/context';

/**
 * Grants, changes or removes a WallX staff role. The role lives in a custom claim (read by
 * Security Rules) and is mirrored in platformUsers/{uid} for listing.
 */
export async function setPlatformRole(
  deps: Deps,
  actor: Actor,
  input: z.infer<typeof SetPlatformRoleInput>,
): Promise<{ uid: string }> {
  requirePlatform(actor, 'platformUser.manage');
  const { auth } = deps;
  const user = await auth.getUserByEmail(input.email).catch(() => {
    throw new HttpsError('not-found', 'No account exists for this email. Ask them to sign up first.');
  });
  if (user.uid === actor.uid) {
    throw new HttpsError('failed-precondition', 'You cannot change your own platform role.');
  }
  await applyPlatformRole(deps, { uid: user.uid, email: input.email, role: input.role }, {
    actorType: 'platform_user',
    actorId: actor.uid,
    ...(actor.email ? { actorEmail: actor.email } : {}),
  });
  return { uid: user.uid };
}

/** Shared with the bootstrap script, which runs as "system". */
export async function applyPlatformRole(
  { db, auth, now }: Deps,
  target: { uid: string; email: string; role: PlatformRole | null },
  by: { actorType: 'platform_user' | 'system'; actorId: string; actorEmail?: string },
): Promise<void> {
  const at = now();
  await auditedTransaction(db, [PLATFORM_AUDIT_CHAIN], async (tx, audit) => {
    const ref = db.doc(paths.platformUser(target.uid));
    const before = (await tx.get(ref)).data() as PlatformUserDoc | undefined;
    if (target.role) {
      const doc: PlatformUserDoc = {
        uid: target.uid,
        email: target.email,
        platformRole: target.role,
        active: true,
        updatedAt: at,
        updatedBy: by.actorId,
      };
      tx.set(ref, doc);
    } else if (before) {
      tx.update(ref, { active: false, updatedAt: at, updatedBy: by.actorId });
    }
    audit(PLATFORM_AUDIT_CHAIN, {
      at,
      ...by,
      orgId: null,
      action: target.role ? 'platform.role.granted' : 'platform.role.revoked',
      target: { type: 'user', id: target.uid },
      data: { email: target.email, before: before?.active ? before.platformRole : null, after: target.role },
    });
  });

  const existing = (await auth.getUser(target.uid)).customClaims ?? {};
  const { platformRole: _old, ...rest } = existing;
  await auth.setCustomUserClaims(target.uid, target.role ? { ...rest, platformRole: target.role } : rest);
  // Force sign-in again so a removed or changed role takes effect immediately.
  await auth.revokeRefreshTokens(target.uid);
}
