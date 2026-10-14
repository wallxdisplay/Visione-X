import { beforeEach, describe, expect, it } from 'vitest';
import { paths, type PlatformSettingsDoc } from '@wallx-play/shared';
import { submitOrgSignup } from '../../functions/src/orgs/signup';
import { updatePlatformSettings } from '../../functions/src/platform/settings';
import { db, deps, expectCode, resetEmulator, superadmin, user } from './helpers';

const support = { email: 'help@wallx.in', phone: '+91 20 1234 5678', whatsapp: '', hours: 'Mon–Sat, 9:30–18:30 IST' };
const signup = () =>
  submitOrgSignup(deps, user('alice'), {
    orgName: 'Chai Point', contactName: 'Asha', phone: '+91 98200 12345', city: 'Pune', stateCode: '27', expectedScreens: 2, timezone: 'Asia/Kolkata',
  });

beforeEach(resetEmulator);

describe('platform settings', () => {
  it('superadmins set support contacts, the notice banner and the signups switch', async () => {
    await expectCode(updatePlatformSettings(deps, user('ops', { platformRole: 'ops' }), { support, banner: null, signupsOpen: true }), 'permission-denied');
    const banner = { message: 'Maintenance on Sunday 2–3 am', tone: 'warning' as const, until: null };
    await updatePlatformSettings(deps, superadmin, { support, banner, signupsOpen: false });
    expect((await db.doc(paths.platformSettings()).get()).data()).toMatchObject({ support, banner, signupsOpen: false } satisfies PlatformSettingsDoc);

    await expectCode(signup(), 'failed-precondition'); // signups paused
    await updatePlatformSettings(deps, superadmin, { support, banner: null, signupsOpen: true });
    await signup();
  });
});
