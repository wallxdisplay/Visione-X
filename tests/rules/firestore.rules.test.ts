import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { collectionGroup, doc, getDoc, getDocs, query, setDoc, where } from 'firebase/firestore';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';

let env: RulesTestEnvironment;

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
    const root = env.authenticatedContext('root', { platformRole: 'superadmin' }).firestore();
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
      getDoc(doc(env.authenticatedContext('s', { platformRole: 'support' }).firestore(), 'signupRequests/r1')),
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

  it('invite tokens and audit heads are never client-readable', async () => {
    const root = env.authenticatedContext('root', { platformRole: 'superadmin' }).firestore();
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
    const root = env.authenticatedContext('root', { platformRole: 'superadmin' }).firestore();
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
    const bill = env.authenticatedContext('b', { platformRole: 'billing' }).firestore();
    await assertSucceeds(getDocs(query(collectionGroup(bill, 'billing'))));
    await assertSucceeds(getDocs(query(collectionGroup(bill, 'billingRequests'), where('status', '==', 'open'))));
    const sup = env.authenticatedContext('s', { platformRole: 'support' }).firestore();
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
    await assertFails(getDoc(doc(env.authenticatedContext('root', { platformRole: 'superadmin' }).firestore(), 'providerCache/w_18.52_73.86')));
  });
});

describe('platform data', () => {
  it('active plans are public, inactive ones are not', async () => {
    const db = env.unauthenticatedContext().firestore();
    await assertSucceeds(getDoc(doc(db, 'plans/starter')));
    await assertFails(getDoc(doc(db, 'plans/legacy')));
  });

  it('platform staff can read org data', async () => {
    const db = env.authenticatedContext('staff', { platformRole: 'support' }).firestore();
    await assertSucceeds(getDoc(doc(db, 'orgs/org1')));
  });

  it('audit logs are readable by auditors only and never writable', async () => {
    const auditor = env.authenticatedContext('aud', { platformRole: 'auditor' }).firestore();
    const support = env.authenticatedContext('sup', { platformRole: 'support' }).firestore();
    const admin = env.authenticatedContext('root', { platformRole: 'superadmin' }).firestore();
    await assertSucceeds(getDoc(doc(auditor, 'auditLogs/a1')));
    await assertFails(getDoc(doc(support, 'auditLogs/a1')));
    await assertFails(setDoc(doc(admin, 'auditLogs/a1'), { action: 'tampered' }));
    await assertFails(setDoc(doc(admin, 'auditLogs/a2'), { action: 'forged' }));
  });
});
