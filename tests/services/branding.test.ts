import { beforeEach, describe, expect, it } from 'vitest';
import { paths, type BrandDomainDoc, type BrandPublic, type DeviceStateResponse, type OrgDoc } from '@wallx-play/shared';
import { handle } from '../../functions/src/api/router';
import * as accounts from '../../functions/src/accounts/accounts';
import * as partners from '../../functions/src/accounts/partners';
import * as branding from '../../functions/src/branding/branding';
import * as members from '../../functions/src/members/members';
import * as screens from '../../functions/src/screens/screens';
import { db, deps, expectCode, outbox, resetEmulator, superadmin, user } from './helpers';

const ravi = user('ravi');
const meera = user('meera');
let accountId: string;
let orgId: string;

// A 1×1 PNG.
const LOGO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const brand = (name: string, primaryColor = '#0E7490') => ({ name, logo: LOGO, primaryColor, supportEmail: 'help@example.com', supportPhone: '', website: '' });
const org = async () => (await db.doc(paths.org(orgId)).get()).data() as OrgDoc;
const setFeatures = async (features: string[]) => {
  const ent = (await db.doc(paths.orgEntitlements(orgId)).get()).data()!;
  await db.doc(paths.orgEntitlements(orgId)).update({ features: [...new Set([...(ent.features as string[]), ...features])], 'limits.screens': 10 });
};

async function pair() {
  const reg = await handle(deps, {
    method: 'POST',
    path: '/api/v1/devices/register',
    headers: {},
    ip: '10.0.0.9',
    body: { hardware: { manufacturer: 'X', model: 'Box', androidVersion: '12', sdkInt: 31, appVersion: '0.19.0', display: { width: 1920, height: 1080 } } },
  });
  const b = reg.body as { deviceId: string; deviceSecret: string; pairingCode: string };
  await screens.claimDevice(deps, ravi, { orgId, pairingCode: b.pairingCode, name: 'Lobby', siteId: null, groupIds: [], orientation: 'landscape', resolution: { width: 1920, height: 1080 } });
  const auth = `Device ${b.deviceId}:${b.deviceSecret}`;
  return {
    me: async () => (await handle(deps, { method: 'GET', path: '/api/v1/devices/me', headers: { authorization: auth }, body: {}, ip: '1' })).body as DeviceStateResponse,
    brand: async () => ((await handle(deps, { method: 'GET', path: '/api/v1/devices/brand', headers: { authorization: auth }, body: {}, ip: '1' })).body as { brand: BrandPublic | null }).brand,
  };
}

beforeEach(async () => {
  await resetEmulator();
  ({ accountId } = await accounts.saveAccount(deps, superadmin, { name: 'Deccan Displays', contactName: '', email: '', phone: '', city: '', gstin: null, status: 'active', notes: '' }));
  const { token } = await partners.inviteAccountMember(deps, superadmin, { accountId, email: 'ravi@example.com', role: 'owner' });
  await members.acceptInvite(deps, ravi, { token });
  ({ orgId } = await partners.createPartnerOrg(deps, ravi, {
    accountId,
    orgName: 'Kothari Sweets',
    contactName: 'Meera Kothari',
    phone: '+91 98200 11111',
    city: 'Nashik',
    stateCode: '27',
    timezone: 'Asia/Kolkata',
    ownerEmail: '',
    planId: 'professional',
    quantity: 3,
    trial: true,
  }));
});

describe('white label', () => {
  it('a reseller’s brand reaches its customers and their screens', async () => {
    const screen = await pair();
    expect((await screen.me()).brandAt).toBeNull();

    // WallX switches white label on for the reseller first.
    await expectCode(branding.saveBrand(deps, ravi, { target: { kind: 'account', accountId }, brand: brand('Deccan Signage') }), 'failed-precondition');
    await accounts.saveAccount(deps, superadmin, { accountId, name: 'Deccan Displays', contactName: '', email: '', phone: '', city: '', gstin: null, status: 'active', notes: '', whiteLabel: true });
    await branding.saveBrand(deps, ravi, { target: { kind: 'account', accountId }, brand: brand('Deccan Signage') });

    expect((await org()).partnerBrand).toMatchObject({ name: 'Deccan Signage', primaryColor: '#0E7490', logo: LOGO, appUrl: null });
    // Customers created later get it at once.
    const later = await partners.createPartnerOrg(deps, ravi, { accountId, orgName: 'Later Ltd', contactName: 'Lata', phone: '+91 98200 22222', city: 'Pune', stateCode: '27', timezone: 'Asia/Kolkata', ownerEmail: '', planId: 'starter', quantity: 1, trial: true });
    expect(((await db.doc(paths.org(later.orgId)).get()).data() as OrgDoc).partnerBrand).toMatchObject({ name: 'Deccan Signage' });
    const me = await screen.me();
    expect(me.brandAt).toEqual(expect.any(Number));
    expect(await screen.brand()).toMatchObject({ name: 'Deccan Signage' });

    // Emails about the customer go out in the brand's name.
    outbox.length = 0;
    await members.inviteMember(deps, ravi, { orgId, email: 'priya@example.com', role: 'viewer' });
    expect(outbox[0]).toMatchObject({ brand: { name: 'Deccan Signage', color: '#0E7490' }, subject: expect.stringContaining('Deccan Signage') });

    // Switched off again: back to WallX Play.
    await accounts.saveAccount(deps, superadmin, { accountId, name: 'Deccan Displays', contactName: '', email: '', phone: '', city: '', gstin: null, status: 'active', notes: '', whiteLabel: false });
    expect((await org()).partnerBrand).toBeNull();
    expect(await screen.brand()).toBeNull();
  });

  it('an organization with the feature uses its own brand over its reseller’s', async () => {
    await accounts.saveAccount(deps, superadmin, { accountId, name: 'Deccan Displays', contactName: '', email: '', phone: '', city: '', gstin: null, status: 'active', notes: '', whiteLabel: true });
    await branding.saveBrand(deps, ravi, { target: { kind: 'account', accountId }, brand: brand('Deccan Signage') });
    const screen = await pair();

    // The org's owner (here the reseller's admin) needs the plan feature.
    await expectCode(branding.saveBrand(deps, ravi, { target: { kind: 'org', orgId }, brand: brand('Kothari TV', '#B91C1C') }), 'permission-denied');
    await setFeatures(['branding.whiteLabel']);
    await branding.saveBrand(deps, ravi, { target: { kind: 'org', orgId }, brand: brand('Kothari TV', '#B91C1C') });
    expect(await screen.brand()).toMatchObject({ name: 'Kothari TV', primaryColor: '#B91C1C' });

    // Without the feature (plan change), the reseller's brand applies again.
    const ent = (await db.doc(paths.orgEntitlements(orgId)).get()).data()!;
    await db.doc(paths.orgEntitlements(orgId)).update({ features: (ent.features as string[]).filter((f) => f !== 'branding.whiteLabel') });
    expect(await screen.brand()).toMatchObject({ name: 'Deccan Signage' });

    // Members without settings rights cannot brand.
    await expectCode(branding.saveBrand(deps, meera, { target: { kind: 'org', orgId }, brand: null }), 'permission-denied');
  });

  it('custom web addresses are public lookups managed by WallX staff', async () => {
    await accounts.saveAccount(deps, superadmin, { accountId, name: 'Deccan Displays', contactName: '', email: '', phone: '', city: '', gstin: null, status: 'active', notes: '', whiteLabel: true });
    await expectCode(branding.setBrandDomains(deps, superadmin, { target: { kind: 'account', accountId }, domains: ['signage.deccan.in'] }), 'failed-precondition'); // no brand yet
    await branding.saveBrand(deps, ravi, { target: { kind: 'account', accountId }, brand: brand('Deccan Signage') });
    await expectCode(branding.setBrandDomains(deps, ravi, { target: { kind: 'account', accountId }, domains: ['signage.deccan.in'] }), 'permission-denied');
    await branding.setBrandDomains(deps, superadmin, { target: { kind: 'account', accountId }, domains: ['signage.deccan.in'] });

    const lookup = (await db.doc(paths.brandDomain('signage.deccan.in')).get()).data() as BrandDomainDoc;
    expect(lookup).toMatchObject({ owner: { kind: 'account', id: accountId }, brand: { name: 'Deccan Signage', appUrl: 'https://signage.deccan.in' } });
    // Customers' links use the address too.
    expect((await org()).partnerBrand?.appUrl).toBe('https://signage.deccan.in');

    // A brand change updates the lookup; another brand cannot take the address.
    await branding.saveBrand(deps, ravi, { target: { kind: 'account', accountId }, brand: brand('Deccan Screens') });
    expect(((await db.doc(paths.brandDomain('signage.deccan.in')).get()).data() as BrandDomainDoc).brand.name).toBe('Deccan Screens');
    await setFeatures(['branding.whiteLabel']);
    await branding.saveBrand(deps, ravi, { target: { kind: 'org', orgId }, brand: brand('Kothari TV') });
    await expectCode(branding.setBrandDomains(deps, superadmin, { target: { kind: 'org', orgId }, domains: ['signage.deccan.in'] }), 'already-exists');

    // Removing the address deletes the lookup.
    await branding.setBrandDomains(deps, superadmin, { target: { kind: 'account', accountId }, domains: [] });
    expect((await db.doc(paths.brandDomain('signage.deccan.in')).get()).exists).toBe(false);
  });
});
