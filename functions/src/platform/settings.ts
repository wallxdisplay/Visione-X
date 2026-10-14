/** Super Admin → Platform settings (support contacts, notice banner, signups switch). */
import type { z } from 'zod';
import { PLATFORM_AUDIT_CHAIN, paths, type PlatformSettingsDoc, type UpdatePlatformSettingsInput } from '@wallx-play/shared';
import { auditedTransaction, platformAudit } from '../lib/audit';
import { requirePlatform } from '../lib/authz';
import type { Actor, Deps } from '../lib/context';

export async function updatePlatformSettings({ db, now }: Deps, actor: Actor, input: z.infer<typeof UpdatePlatformSettingsInput>): Promise<void> {
  requirePlatform(actor, 'settings.edit');
  const ref = db.doc(paths.platformSettings());
  await auditedTransaction(db, [PLATFORM_AUDIT_CHAIN], async (tx, audit) => {
    const before = ((await tx.get(ref)).data() ?? {}) as PlatformSettingsDoc;
    const at = now();
    const next: Partial<PlatformSettingsDoc> = { support: input.support, banner: input.banner, signupsOpen: input.signupsOpen, updatedAt: at, updatedBy: actor.uid };
    tx.set(ref, next, { merge: true });
    audit(PLATFORM_AUDIT_CHAIN, {
      at,
      ...platformAudit(actor),
      orgId: null,
      action: 'platform.settings.updated',
      target: { type: 'platformSettings', id: 'settings' },
      data: {
        from: { support: before.support ?? null, banner: before.banner ?? null, signupsOpen: before.signupsOpen ?? true },
        to: { support: input.support, banner: input.banner, signupsOpen: input.signupsOpen },
      },
    });
  });
}
