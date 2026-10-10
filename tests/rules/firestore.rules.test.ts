import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';

let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-visione-x',
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

  it('sub-collections not yet opened stay closed', async () => {
    await assertFails(getDoc(doc(env.authenticatedContext('alice').firestore(), 'orgs/org1/screens/s1')));
  });

  it('devices cannot read org documents as users', async () => {
    const db = env.authenticatedContext('device-1', { type: 'device', orgId: 'org1' }).firestore();
    await assertFails(getDoc(doc(db, 'orgs/org1')));
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
