import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CallableRequest } from 'firebase-functions/v2/https';
import { actorFrom } from '../../functions/src/callables';
import { staffMfa } from '../../functions/src/lib/authz';
import { updatePlatformSettings } from '../../functions/src/platform/settings';
import { revokeSupportAccess } from '../../functions/src/support/access';
import { deps, expectCode, resetEmulator, superadmin, user } from './helpers';

const support = { email: 'help@wallx.in', phone: '', whatsapp: '', hours: '' };
const settings = { support, banner: null, signupsOpen: true };
const withTotp = user('root', { platformRole: 'superadmin', secondFactor: 'totp' });

/** A callable request as the Functions runtime hands it over (decoded ID token claims). */
function request(token: Record<string, unknown>): CallableRequest {
  return { auth: { uid: 'u1', token: { email: 'u1@example.com', email_verified: true, firebase: {}, ...token } } } as unknown as CallableRequest;
}

const sync = (fn: () => unknown) =>
  new Promise((resolve, reject) => {
    try {
      resolve(fn());
    } catch (err) {
      reject(err);
    }
  });

beforeEach(resetEmulator);
afterEach(() => {
  staffMfa.required = false;
});

describe('staff two-step verification (production)', () => {
  beforeEach(() => {
    staffMfa.required = true;
  });

  it('refuses staff tokens signed in without a second factor', async () => {
    await expectCode(sync(() => actorFrom(request({ platformRole: 'superadmin' }))), 'permission-denied');
    await expectCode(sync(() => actorFrom(request({ platformRole: 'auditor', firebase: { sign_in_provider: 'password' } }))), 'permission-denied');
  });

  it('accepts staff tokens with a second factor and customers without one', () => {
    expect(actorFrom(request({ platformRole: 'superadmin', firebase: { sign_in_second_factor: 'totp' } }))).toMatchObject({
      platformRole: 'superadmin',
      secondFactor: 'totp',
    });
    expect(actorFrom(request({}))).toMatchObject({ platformRole: null, secondFactor: null });
    // An unknown role is not staff, so it needs nothing extra (and gets no staff powers).
    expect(actorFrom(request({ platformRole: 'owner' }))).toMatchObject({ platformRole: null });
  });

  it('platform services refuse staff without a second factor', async () => {
    await expectCode(updatePlatformSettings(deps, superadmin, settings), 'permission-denied');
    await updatePlatformSettings(deps, withTotp, settings);
    // Staff shortcuts that skip the membership check need it too.
    await expectCode(revokeSupportAccess(deps, superadmin, { orgId: 'org1', grantId: 'g1' }), 'permission-denied');
    await expectCode(revokeSupportAccess(deps, withTotp, { orgId: 'org1', grantId: 'g1' }), 'not-found');
  });
});

describe('staff two-step verification (emulators and tests)', () => {
  it('is not required while switched off', async () => {
    staffMfa.required = false;
    expect(actorFrom(request({ platformRole: 'superadmin' }))).toMatchObject({ platformRole: 'superadmin', secondFactor: null });
    await updatePlatformSettings(deps, superadmin, settings);
  });
});
