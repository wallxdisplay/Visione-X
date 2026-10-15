import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { collection, collectionGroup, doc, getDoc, getDocs, query, setDoc, where } from 'firebase/firestore';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';

let env: RulesTestEnvironment;

/** A staff ID token from a sign-in with two-step verification (TOTP), as staff must use. */
const staffToken = (platformRole: string, secondFactor: string | null = 'totp') => ({
  platformRole,
  firebase: { sign_in_provider: 'password', ...(secondFactor ? { sign_in_second_factor: secondFactor } : {}) },
});

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-wallx-play',
    firestore: { rules: readFileSync('firestore.rules', 'utf8') },
  });
});

afterAll(async () => {
  await env.cleanup();
});

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'orgs/org1'), { name: 'Acme', status: 'active' });
    await setDoc(doc(db, 'orgs/org1/members/alice'), { role: 'owner', status: 'active' });
    await setDoc(doc(db, 'orgs/org1/members/dave'), { role: 'editor', status: 'disabled' });
    await setDoc(doc(db, 'orgs/org1/screens/s1'), { name: 'Lobby' });
    await setDoc(doc(db, 'plans/starter'), { active: true });
    await setDoc(doc(db, 'plans/legacy'), { active: false });
    await setDoc(doc(db, 'auditLogs/a1'), { action: 'org.approve' });
  });
});

describe('deny by default', () => {
  it('unauthenticated users cannot read orgs', async () => {
    await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), 'orgs/org1')));
  });

  it('unknown collections are closed', async () => {
    const db = env.authenticatedContext('alice').firestore();
    await assertFails(getDoc(doc(db, 'anything/x')));
    await assertFails(setDoc(doc(db, 'anything/x'), { a: 1 }));
  });
});

describe('organizations', () => {
  it('active members can read their org', async () => {
    await assertSucceeds(getDoc(doc(env.authenticatedContext('alice').firestore(), 'orgs/org1')));
  });

  it('disabled members and outsiders cannot read the org', async () => {
    await assertFails(getDoc(doc(env.authenticatedContext('dave').firestore(), 'orgs/org1')));
    await assertFails(getDoc(doc(env.authenticatedContext('mallory').firestore(), 'orgs/org1')));
  });

  it('even owners cannot write org status directly', async () => {
    const db = env.authenticatedContext('alice').firestore();
    await assertFails(setDoc(doc(db, 'orgs/org1'), { status: 'active' }, { merge: true }));
  });

  it('members cannot change their own role', async () => {
    const db = env.authenticatedContext('alice').firestore();
    await assertFails(setDoc(doc(db, 'orgs/org1/members/alice'), { role: 'owner' }, { merge: true }));
  });

  it('server-only sub-collections stay closed; screens are readable by members', async () => {
    const db = env.authenticatedContext('alice').firestore();
    await assertSucceeds(getDoc(doc(db, 'orgs/org1/screens/s1')));
    await assertFails(getDoc(doc(db, 'orgs/org1/screenManifests/s1')));
    await assertFails(setDoc(doc(db, 'orgs/org1/screens/s1'), { status: 'authorized' }, { merge: true }));
  });

  it('device records, pairing codes and rate limits are never client-readable', async () => {
    const root = env.authenticatedContext('root', staffToken('superadmin')).firestore();
    await assertFails(getDoc(doc(root, 'devices/d1')));
    await assertFails(getDoc(doc(root, 'pairingCodes/ABC234')));
    await assertFails(getDoc(doc(root, 'rateLimits/x')));
  });

  it('devices cannot read org documents as users', async () => {
    const db = env.authenticatedContext('device-1', { type: 'device', orgId: 'org1' }).firestore();
    await assertFails(getDoc(doc(db, 'orgs/org1')));
  });
});

describe('phase 1 collections', () => {
  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, 'orgs/org1/members/ed'), {
        role: 'editor',
        status: 'active',
        permissions: ['member.view', 'screen.view'],
      });
      await setDoc(doc(db, 'orgs/org1/members/own'), {
        role: 'owner',
        status: 'active',
        permissions: ['member.view', 'member.manage', 'billing.view'],
      });
      await setDoc(doc(db, 'orgs/org1/invites/i1'), { email: 'x@example.com', status: 'pending' });
      await setDoc(doc(db, 'orgs/org1/sites/hq'), { name: 'HQ' });
      await setDoc(doc(db, 'orgs/org1/roles/r1'), { name: 'Store manager', permissions: ['screen.view'] });
      await setDoc(doc(db, 'orgs/org1/billing/subscription'), { planId: 'trial' });
      await setDoc(doc(db, 'users/alice'), { memberships: {} });
      await setDoc(doc(db, 'signupRequests/r1'), { requestedBy: 'alice', status: 'pending' });
      await setDoc(doc(db, 'inviteTokens/abc'), { orgId: 'org1', inviteId: 'i1' });
      await setDoc(doc(db, 'auditHeads/org1'), { seq: 1, hash: 'h' });
    });
  });

  it('users read only their own profile', async () => {
    await assertSucceeds(getDoc(doc(env.authenticatedContext('alice').firestore(), 'users/alice')));
    await assertFails(getDoc(doc(env.authenticatedContext('bob').firestore(), 'users/alice')));
    await assertFails(setDoc(doc(env.authenticatedContext('alice').firestore(), 'users/alice'), { memberships: { x: {} } }));
  });

  it('signup requests are visible to the requester and staff only', async () => {
    await assertSucceeds(getDoc(doc(env.authenticatedContext('alice').firestore(), 'signupRequests/r1')));
    await assertFails(getDoc(doc(env.authenticatedContext('bob').firestore(), 'signupRequests/r1')));
    await assertSucceeds(
      getDoc(doc(env.authenticatedContext('s', staffToken('support')).firestore(), 'signupRequests/r1')),
    );
  });

  it('invites need member.manage; members list needs member.view', async () => {
    await assertSucceeds(getDoc(doc(env.authenticatedContext('own').firestore(), 'orgs/org1/invites/i1')));
    await assertFails(getDoc(doc(env.authenticatedContext('ed').firestore(), 'orgs/org1/invites/i1')));
    await assertSucceeds(getDoc(doc(env.authenticatedContext('ed').firestore(), 'orgs/org1/members/own')));
  });

  it('billing needs billing.view', async () => {
    await assertSucceeds(getDoc(doc(env.authenticatedContext('own').firestore(), 'orgs/org1/billing/subscription')));
    await assertFails(getDoc(doc(env.authenticatedContext('ed').firestore(), 'orgs/org1/billing/subscription')));
  });

  it('sites are readable by members but never writable from clients', async () => {
    const db = env.authenticatedContext('own').firestore();
    await assertSucceeds(getDoc(doc(db, 'orgs/org1/sites/hq')));
    await assertFails(setDoc(doc(db, 'orgs/org1/sites/new'), { name: 'X' }));
  });

  it('custom roles are readable by members, not outsiders, and never client-writable', async () => {
    await assertSucceeds(getDoc(doc(env.authenticatedContext('ed').firestore(), 'orgs/org1/roles/r1')));
    await assertFails(getDoc(doc(env.authenticatedContext('bob').firestore(), 'orgs/org1/roles/r1')));
    await assertFails(setDoc(doc(env.authenticatedContext('own').firestore(), 'orgs/org1/roles/r2'), { name: 'X', permissions: [] }));
  });

  it('invite tokens and audit heads are never client-readable', async () => {
    const root = env.authenticatedContext('root', staffToken('superadmin')).firestore();
    await assertFails(getDoc(doc(root, 'inviteTokens/abc')));
    await assertFails(getDoc(doc(root, 'auditHeads/org1')));
  });
});

describe('sensors (phase 5)', () => {
  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, 'orgs/org1/members/viewer'), { role: 'viewer', status: 'active', permissions: ['sensor.view'] });
      await setDoc(doc(db, 'orgs/org1/members/nosensor'), { role: 'custom', status: 'active', permissions: ['screen.view'] });
      await setDoc(doc(db, 'orgs/org1/sensorDevices/d1'), { name: 'Cold room' });
      await setDoc(doc(db, 'orgs/org1/sensorDevices/d1/channels/temp'), { name: 'Temperature' });
      await setDoc(doc(db, 'orgs/org1/sensorDevices/d1/channels/temp/readings/2026100109'), { points: [] });
      await setDoc(doc(db, 'orgs/org1/alerts/a1'), { status: 'open' });
      await setDoc(doc(db, 'sensorKeys/hash'), { orgId: 'org1', sensorDeviceId: 'd1' });
    });
  });

  it('members with sensor.view read devices, channels, readings and alerts', async () => {
    const db = env.authenticatedContext('viewer').firestore();
    for (const path of [
      'orgs/org1/sensorDevices/d1',
      'orgs/org1/sensorDevices/d1/channels/temp',
      'orgs/org1/sensorDevices/d1/channels/temp/readings/2026100109',
      'orgs/org1/alerts/a1',
    ]) {
      await assertSucceeds(getDoc(doc(db, path)));
    }
  });

  it('members without sensor.view and outsiders cannot', async () => {
    await assertFails(getDoc(doc(env.authenticatedContext('nosensor').firestore(), 'orgs/org1/sensorDevices/d1')));
    await assertFails(getDoc(doc(env.authenticatedContext('mallory').firestore(), 'orgs/org1/alerts/a1')));
  });

  it('nothing is client-writable and API key hashes are never readable', async () => {
    const db = env.authenticatedContext('viewer').firestore();
    await assertFails(setDoc(doc(db, 'orgs/org1/sensorDevices/d1/channels/temp'), { latest: { value: 1, ts: 1 } }, { merge: true }));
    await assertFails(setDoc(doc(db, 'orgs/org1/alerts/a1'), { status: 'resolved' }, { merge: true }));
    const root = env.authenticatedContext('root', staffToken('superadmin')).firestore();
    await assertFails(getDoc(doc(root, 'sensorKeys/hash')));
  });
});

describe('billing (phase 6)', () => {
  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, 'orgs/org1/members/own'), { role: 'owner', status: 'active', permissions: ['billing.view', 'billing.manage'] });
      await setDoc(doc(db, 'orgs/org1/members/ed'), { role: 'editor', status: 'active', permissions: ['screen.view'] });
      await setDoc(doc(db, 'orgs/org1/billing/subscription'), { planId: 'trial' });
      await setDoc(doc(db, 'orgs/org1/payments/p1'), { amountMinor: 100 });
      await setDoc(doc(db, 'orgs/org1/billingRequests/r1'), { status: 'open' });
    });
  });

  it('owners with billing.view read payments and requests; editors do not', async () => {
    const own = env.authenticatedContext('own').firestore();
    await assertSucceeds(getDoc(doc(own, 'orgs/org1/payments/p1')));
    await assertSucceeds(getDoc(doc(own, 'orgs/org1/billingRequests/r1')));
    await assertFails(getDoc(doc(env.authenticatedContext('ed').firestore(), 'orgs/org1/payments/p1')));
    await assertFails(setDoc(doc(own, 'orgs/org1/payments/p2'), { amountMinor: 1 }));
  });

  it('billing staff list across orgs; support staff cannot see billing', async () => {
    const bill = env.authenticatedContext('b', staffToken('billing')).firestore();
    await assertSucceeds(getDocs(query(collectionGroup(bill, 'billing'))));
    await assertSucceeds(getDocs(query(collectionGroup(bill, 'billingRequests'), where('status', '==', 'open'))));
    const sup = env.authenticatedContext('s', staffToken('support')).firestore();
    await assertFails(getDoc(doc(sup, 'orgs/org1/billing/subscription')));
    await assertFails(getDocs(query(collectionGroup(sup, 'billing'))));
  });
});

describe('integrations (phase 6)', () => {
  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, 'orgs/org1/dataSources/ds1'), { name: 'Pune', type: 'weather' });
      await setDoc(doc(db, 'providerCache/w_18.52_73.86'), { weather: {} });
    });
  });

  it('members read data sources; nobody writes them or reads the provider cache', async () => {
    const alice = env.authenticatedContext('alice').firestore();
    await assertSucceeds(getDoc(doc(alice, 'orgs/org1/dataSources/ds1')));
    await assertFails(setDoc(doc(alice, 'orgs/org1/dataSources/ds2'), { name: 'X' }));
    await assertFails(getDoc(doc(env.authenticatedContext('mallory').firestore(), 'orgs/org1/dataSources/ds1')));
    await assertFails(getDoc(doc(env.authenticatedContext('root', staffToken('superadmin')).firestore(), 'providerCache/w_18.52_73.86')));
  });
});

describe('site scope', () => {
  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, 'orgs/org1/members/pune'), { role: 'editor', status: 'active', permissions: ['screen.view', 'sensor.view'], siteScope: ['pune'] });
      await setDoc(doc(db, 'orgs/org1/screens/sPune'), { name: 'Pune lobby', siteId: 'pune' });
      await setDoc(doc(db, 'orgs/org1/screens/sMumbai'), { name: 'Mumbai lobby', siteId: 'mumbai' });
      await setDoc(doc(db, 'orgs/org1/screens/sMumbai/commands/c1'), { type: 'refresh' });
      await setDoc(doc(db, 'orgs/org1/sensorDevices/dMumbai'), { name: 'Mumbai fridge', siteId: 'mumbai' });
      await setDoc(doc(db, 'orgs/org1/sensorDevices/dMumbai/channels/temp'), { name: 'Temp' });
      await setDoc(doc(db, 'orgs/org1/alerts/aMumbai'), { status: 'open', siteId: 'mumbai' });
      await setDoc(doc(db, 'orgs/org1/alerts/aPune'), { status: 'open', siteId: 'pune' });
    });
  });

  it('scoped members read only their sites; queries must be limited to their sites', async () => {
    const db = env.authenticatedContext('pune').firestore();
    await assertSucceeds(getDoc(doc(db, 'orgs/org1/screens/sPune')));
    await assertFails(getDoc(doc(db, 'orgs/org1/screens/sMumbai')));
    await assertFails(getDoc(doc(db, 'orgs/org1/screens/sMumbai/commands/c1')));
    await assertFails(getDoc(doc(db, 'orgs/org1/sensorDevices/dMumbai')));
    await assertFails(getDoc(doc(db, 'orgs/org1/sensorDevices/dMumbai/channels/temp')));
    await assertFails(getDoc(doc(db, 'orgs/org1/alerts/aMumbai')));
    await assertSucceeds(getDoc(doc(db, 'orgs/org1/alerts/aPune')));
    await assertSucceeds(getDocs(query(collection(db, 'orgs/org1/screens'), where('siteId', 'in', ['pune']))));
    await assertFails(getDocs(query(collection(db, 'orgs/org1/screens'))));
  });

  it('unscoped members see every site; device staff list screens across orgs', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'orgs/org1/members/all'), { role: 'viewer', status: 'active', permissions: ['screen.view'] });
    });
    await assertSucceeds(getDocs(query(collection(env.authenticatedContext('all').firestore(), 'orgs/org1/screens'))));
    await assertSucceeds(getDocs(query(collectionGroup(env.authenticatedContext('ops', staffToken('ops')).firestore(), 'screens'))));
    await assertFails(getDocs(query(collectionGroup(env.authenticatedContext('bill', staffToken('billing')).firestore(), 'screens'))));
  });
});

describe('support access', () => {
  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, 'orgs/org1'), { name: 'Org', status: 'active' });
      await setDoc(doc(db, 'orgs/org1/members/own'), { role: 'owner', status: 'active', permissions: ['member.view', 'member.manage'] });
      await setDoc(doc(db, 'orgs/org1/members/sam'), { role: 'editor', status: 'active', permissions: ['media.view'], support: { grantId: 'g1', expiresAt: Date.now() + 3_600_000 } });
      await setDoc(doc(db, 'orgs/org1/members/old'), { role: 'editor', status: 'active', permissions: ['media.view'], support: { grantId: 'g0', expiresAt: Date.now() - 1000 } });
      await setDoc(doc(db, 'orgs/org1/media/m1'), { name: 'Menu' });
      await setDoc(doc(db, 'orgs/org1/screens/s1'), { name: 'Lobby', siteId: null });
      await setDoc(doc(db, 'orgs/org1/supportGrants/g1'), { orgId: 'org1', status: 'active' });
    });
  });

  it('a support member reads content only until the grant expires', async () => {
    await assertSucceeds(getDoc(doc(env.authenticatedContext('sam').firestore(), 'orgs/org1/media/m1')));
    await assertFails(getDoc(doc(env.authenticatedContext('old').firestore(), 'orgs/org1/media/m1')));
  });

  it('staff without a grant cannot read customer content; device staff still see screens', async () => {
    const supportStaff = env.authenticatedContext('sup', staffToken('support')).firestore();
    await assertFails(getDoc(doc(supportStaff, 'orgs/org1/media/m1')));
    await assertSucceeds(getDoc(doc(supportStaff, 'orgs/org1/screens/s1')));
    await assertFails(getDoc(doc(env.authenticatedContext('bill', staffToken('billing')).firestore(), 'orgs/org1/screens/s1')));
    await assertSucceeds(getDoc(doc(supportStaff, 'orgs/org1'))); // organization details stay visible
  });

  it('grants are visible to the organization and support staff, never client-writable', async () => {
    await assertSucceeds(getDoc(doc(env.authenticatedContext('own').firestore(), 'orgs/org1/supportGrants/g1')));
    await assertSucceeds(getDocs(query(collectionGroup(env.authenticatedContext('sup', staffToken('support')).firestore(), 'supportGrants'))));
    await assertFails(getDoc(doc(env.authenticatedContext('ops', staffToken('ops')).firestore(), 'orgs/org1/supportGrants/g1')));
    await assertFails(setDoc(doc(env.authenticatedContext('own').firestore(), 'orgs/org1/supportGrants/g2'), { status: 'active' }));
  });
});

describe('platform data', () => {
  it('active plans are public, inactive ones are not', async () => {
    const db = env.unauthenticatedContext().firestore();
    await assertSucceeds(getDoc(doc(db, 'plans/starter')));
    await assertFails(getDoc(doc(db, 'plans/legacy')));
  });

  it('platform staff can read org data', async () => {
    const db = env.authenticatedContext('staff', staffToken('support')).firestore();
    await assertSucceeds(getDoc(doc(db, 'orgs/org1')));
  });

  it('audit logs are readable by auditors only and never writable', async () => {
    const auditor = env.authenticatedContext('aud', staffToken('auditor')).firestore();
    const support = env.authenticatedContext('sup', staffToken('support')).firestore();
    const admin = env.authenticatedContext('root', staffToken('superadmin')).firestore();
    await assertSucceeds(getDoc(doc(auditor, 'auditLogs/a1')));
    await assertFails(getDoc(doc(support, 'auditLogs/a1')));
    await assertFails(setDoc(doc(admin, 'auditLogs/a1'), { action: 'tampered' }));
    await assertFails(setDoc(doc(admin, 'auditLogs/a2'), { action: 'forged' }));
  });

  it('player releases are visible to device staff only and never client-writable', async () => {
    const ops = env.authenticatedContext('ops', staffToken('ops')).firestore();
    await assertSucceeds(getDoc(doc(ops, 'playerReleases/r1')));
    await assertFails(getDoc(doc(env.authenticatedContext('bill', staffToken('billing')).firestore(), 'playerReleases/r1')));
    await assertFails(getDoc(doc(env.authenticatedContext('alice').firestore(), 'playerReleases/r1')));
    await assertFails(setDoc(doc(ops, 'playerReleases/r2'), { status: 'ready', rollout: 'all' }));
  });
});

describe('staff two-step verification', () => {
  it('a staff password-only sign-in has no staff access, only its own profile', async () => {
    const noCode = env.authenticatedContext('root', staffToken('superadmin', null)).firestore();
    await assertFails(getDoc(doc(noCode, 'auditLogs/a1')));
    await assertFails(getDocs(query(collectionGroup(noCode, 'screens'))));
    await assertFails(getDoc(doc(noCode, 'orgs/org1')));
    await assertSucceeds(getDoc(doc(noCode, 'users/root')));
    // The same account signed in with its authenticator code is staff again.
    await assertSucceeds(getDoc(doc(env.authenticatedContext('root', staffToken('superadmin')).firestore(), 'orgs/org1')));
  });
});

describe('screen diagnostics history', () => {
  it('members who see the screen and device staff read events; others cannot, nobody writes', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'orgs/org1/screens/s1/events/e1'), { type: 'error', at: 1, message: 'x' });
      await setDoc(doc(ctx.firestore(), 'orgs/org1/members/alice'), { role: 'owner', status: 'active', permissions: ['screen.view'], siteScope: [] });
    });
    await assertSucceeds(getDoc(doc(env.authenticatedContext('alice').firestore(), 'orgs/org1/screens/s1/events/e1')));
    await assertSucceeds(getDoc(doc(env.authenticatedContext('ops', staffToken('ops')).firestore(), 'orgs/org1/screens/s1/events/e1')));
    await assertFails(getDoc(doc(env.authenticatedContext('eve').firestore(), 'orgs/org1/screens/s1/events/e1')));
    await assertFails(getDoc(doc(env.authenticatedContext('ops', staffToken('ops', null)).firestore(), 'orgs/org1/screens/s1/events/e1')));
    await assertFails(setDoc(doc(env.authenticatedContext('alice').firestore(), 'orgs/org1/screens/s1/events/e2'), { type: 'error' }));
  });
});

describe('public API keys and webhooks', () => {
  it('members with apikey.manage read them; others cannot; nobody writes or reads secrets', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, 'orgs/org1/members/alice'), { role: 'owner', status: 'active', permissions: ['apikey.manage'], siteScope: [] });
      await setDoc(doc(db, 'orgs/org1/members/vic'), { role: 'viewer', status: 'active', permissions: ['screen.view'], siteScope: [] });
      await setDoc(doc(db, 'orgs/org1/apiKeys/k1'), { name: 'BMS' });
      await setDoc(doc(db, 'orgs/org1/webhooks/w1'), { url: 'https://x' });
      await setDoc(doc(db, 'orgs/org1/webhooks/w1/deliveries/d1'), { ok: true });
      await setDoc(doc(db, 'apiKeyHashes/h1'), { orgId: 'org1' });
      await setDoc(doc(db, 'webhookSecrets/org1_w1'), { secret: 's' });
    });
    const alice = env.authenticatedContext('alice').firestore();
    const vic = env.authenticatedContext('vic').firestore();
    await assertSucceeds(getDoc(doc(alice, 'orgs/org1/apiKeys/k1')));
    await assertSucceeds(getDoc(doc(alice, 'orgs/org1/webhooks/w1')));
    await assertSucceeds(getDoc(doc(alice, 'orgs/org1/webhooks/w1/deliveries/d1')));
    await assertFails(getDoc(doc(vic, 'orgs/org1/apiKeys/k1')));
    await assertFails(getDoc(doc(vic, 'orgs/org1/webhooks/w1')));
    await assertFails(getDoc(doc(alice, 'apiKeyHashes/h1')));
    await assertFails(getDoc(doc(alice, 'webhookSecrets/org1_w1')));
    await assertFails(setDoc(doc(alice, 'orgs/org1/apiKeys/k2'), { name: 'x' }));
  });
});

describe('MQTT brokers', () => {
  it('members with sensor.view read brokers; nobody reads the broker password', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, 'orgs/org1/members/alice'), { role: 'owner', status: 'active', permissions: ['sensor.view', 'sensor.manage'], siteScope: [] });
      await setDoc(doc(db, 'orgs/org1/members/vic'), { role: 'viewer', status: 'active', permissions: ['screen.view'], siteScope: [] });
      await setDoc(doc(db, 'orgs/org1/mqttBrokers/b1'), { name: 'Plant', siteId: null, hasPassword: true });
      await setDoc(doc(db, 'orgs/org1/mqttBrokerSecrets/b1'), { password: 'p' });
    });
    const alice = env.authenticatedContext('alice').firestore();
    const vic = env.authenticatedContext('vic').firestore();
    await assertSucceeds(getDoc(doc(alice, 'orgs/org1/mqttBrokers/b1')));
    await assertFails(getDoc(doc(vic, 'orgs/org1/mqttBrokers/b1')));
    await assertFails(getDoc(doc(alice, 'orgs/org1/mqttBrokerSecrets/b1')));
    await assertFails(setDoc(doc(alice, 'orgs/org1/mqttBrokers/b2'), { name: 'x' }));
  });
});

describe('reseller accounts', () => {
  it('the reseller team and WallX staff read the account; nobody else; nobody writes', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, 'accounts/acc1'), { name: 'Deccan Displays', status: 'active' });
      await setDoc(doc(db, 'accounts/acc1/members/ravi'), { uid: 'ravi', role: 'owner' });
      await setDoc(doc(db, 'accounts/acc1/payments/p1'), { amountMinor: 100 });
      await setDoc(doc(db, 'accounts/acc1/invites/i1'), { email: 'x@example.com' });
    });
    const ravi = env.authenticatedContext('ravi').firestore();
    const mallory = env.authenticatedContext('mallory').firestore();
    for (const path of ['accounts/acc1', 'accounts/acc1/members/ravi', 'accounts/acc1/payments/p1', 'accounts/acc1/invites/i1']) {
      await assertSucceeds(getDoc(doc(ravi, path)));
      await assertFails(getDoc(doc(mallory, path)));
    }
    await assertSucceeds(getDoc(doc(env.authenticatedContext('root', staffToken('billing')).firestore(), 'accounts/acc1/payments/p1')));
    await assertFails(setDoc(doc(ravi, 'accounts/acc1'), { name: 'x' }));
    await assertFails(setDoc(doc(ravi, 'accounts/acc1/members/mallory'), { uid: 'mallory', role: 'owner' }));
  });
});
