import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { getBytes, ref, uploadBytes } from 'firebase/storage';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';

let env: RulesTestEnvironment;
const ORIGINAL = 'orgs/org1/media/m1/original';

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-visione-x',
    firestore: { rules: readFileSync('firestore.rules', 'utf8') },
    storage: { rules: readFileSync('storage.rules', 'utf8') },
  });
});

afterAll(async () => {
  await env.cleanup();
});

beforeEach(async () => {
  await env.clearFirestore();
  await env.clearStorage();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'orgs/org1'), { name: 'Acme', status: 'active' });
    await setDoc(doc(db, 'orgs/org1/members/alice'), { role: 'editor', status: 'active', permissions: ['media.upload'] });
    await setDoc(doc(db, 'orgs/org1/members/bob'), { role: 'editor', status: 'active', permissions: ['media.upload'] });
    await setDoc(doc(db, 'orgs/org1/media/m1'), {
      status: 'uploading',
      createdBy: 'alice',
      bytes: 100,
      mimeType: 'image/png',
    });
    await setDoc(doc(db, 'orgs/org1/layouts/l1'), { name: 'Lobby' });
    await uploadBytes(ref(ctx.storage(), 'orgs/org1/media/m0/thumb.jpg'), new Uint8Array([1, 2, 3]), {
      contentType: 'image/jpeg',
    });
  });
});

const png = (n: number) => new Uint8Array(n);

describe('media uploads (Storage)', () => {
  it('the reserving user may upload the declared type within the declared size', async () => {
    const storage = env.authenticatedContext('alice').storage();
    await assertSucceeds(uploadBytes(ref(storage, ORIGINAL), png(80), { contentType: 'image/png' }));
  });

  it('rejects oversize, wrong type, other users and non-original paths', async () => {
    const alice = env.authenticatedContext('alice').storage();
    await assertFails(uploadBytes(ref(alice, ORIGINAL), png(200), { contentType: 'image/png' }));
    await assertFails(uploadBytes(ref(alice, ORIGINAL), png(50), { contentType: 'image/jpeg' }));
    await assertFails(uploadBytes(ref(alice, 'orgs/org1/media/m1/display.mp4'), png(50), { contentType: 'image/png' }));
    const bob = env.authenticatedContext('bob').storage();
    await assertFails(uploadBytes(ref(bob, ORIGINAL), png(50), { contentType: 'image/png' }));
  });

  it('no upload once the item is no longer reserved', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'orgs/org1/media/m1'), { status: 'ready' }, { merge: true });
    });
    const storage = env.authenticatedContext('alice').storage();
    await assertFails(uploadBytes(ref(storage, ORIGINAL), png(50), { contentType: 'image/png' }));
  });

  it('members can read media files; outsiders and devices cannot', async () => {
    await assertSucceeds(getBytes(ref(env.authenticatedContext('bob').storage(), 'orgs/org1/media/m0/thumb.jpg')));
    await assertFails(getBytes(ref(env.authenticatedContext('eve').storage(), 'orgs/org1/media/m0/thumb.jpg')));
    await assertFails(
      getBytes(ref(env.authenticatedContext('bob', { type: 'device' }).storage(), 'orgs/org1/media/m0/thumb.jpg')),
    );
  });
});

describe('content documents (Firestore)', () => {
  it('members read content; outsiders cannot; nobody writes from the client', async () => {
    await assertSucceeds(getDoc(doc(env.authenticatedContext('alice').firestore(), 'orgs/org1/layouts/l1')));
    await assertFails(getDoc(doc(env.authenticatedContext('eve').firestore(), 'orgs/org1/layouts/l1')));
    await assertFails(setDoc(doc(env.authenticatedContext('alice').firestore(), 'orgs/org1/layouts/l2'), { name: 'x' }));
    await assertFails(setDoc(doc(env.authenticatedContext('alice').firestore(), 'orgs/org1/media/m9'), { status: 'ready' }));
  });
});
