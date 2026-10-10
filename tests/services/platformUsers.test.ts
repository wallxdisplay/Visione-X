import { beforeEach, describe, expect, it } from 'vitest';
import { PLATFORM_AUDIT_CHAIN } from '@visione-x/shared';
import { setPlatformRole } from '../../functions/src/admin/platformUsers';
import { verifyAuditChain } from '../../functions/src/lib/audit';
import { auth, db, deps, expectCode, resetEmulator, superadmin, user } from './helpers';

async function resetAuth() {
  const host = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  await fetch(`http://${host}/emulator/v1/projects/demo-visione-x/accounts`, { method: 'DELETE' });
}

beforeEach(async () => {
  await resetEmulator();
  await resetAuth();
});

describe('platform roles', () => {
  it('superadmin grants and revokes a role (claims + doc + audit)', async () => {
    const created = await auth.createUser({ email: 'staff@wallx.test', password: 'irrelevant-123' });

    await setPlatformRole(deps, superadmin, { email: 'staff@wallx.test', role: 'support' });
    expect((await auth.getUser(created.uid)).customClaims?.platformRole).toBe('support');
    expect((await db.doc(`platformUsers/${created.uid}`).get()).get('active')).toBe(true);

    await setPlatformRole(deps, superadmin, { email: 'staff@wallx.test', role: null });
    expect((await auth.getUser(created.uid)).customClaims?.platformRole).toBeUndefined();
    expect((await db.doc(`platformUsers/${created.uid}`).get()).get('active')).toBe(false);

    expect(await verifyAuditChain(db, PLATFORM_AUDIT_CHAIN)).toEqual({ ok: true, count: 2 });
  });

  it('non-superadmins cannot grant roles, and nobody can change their own', async () => {
    await auth.createUser({ uid: 'root', email: 'root@wallx.test' });
    await expectCode(
      setPlatformRole(deps, user('x', { platformRole: 'support' }), { email: 'root@wallx.test', role: null }),
      'permission-denied',
    );
    await expectCode(
      setPlatformRole(deps, superadmin, { email: 'root@wallx.test', role: null }),
      'failed-precondition',
    );
  });

  it('unknown emails are reported clearly', async () => {
    await expectCode(setPlatformRole(deps, superadmin, { email: 'nobody@wallx.test', role: 'ops' }), 'not-found');
  });
});
