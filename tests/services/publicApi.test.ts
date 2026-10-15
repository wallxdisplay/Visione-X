import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { paths, type ApiKeyDoc, type ScreenCommandDoc, type WebhookDeliveryDoc, type WebhookDoc } from '@wallx-play/shared';
import { handle } from '../../functions/src/api/router';
import type { Deps } from '../../functions/src/lib/context';
import { notify } from '../../functions/src/lib/notify';
import { sendScreenCommand } from '../../functions/src/ops/commands';
import { reviewOrgSignup } from '../../functions/src/orgs/review';
import { submitOrgSignup } from '../../functions/src/orgs/signup';
import { createApiKey, revokeApiKey } from '../../functions/src/publicApi/keys';
import { deleteWebhook, deliver, deliverNotificationWebhooks, rotateWebhookSecret, saveWebhook, testWebhook } from '../../functions/src/publicApi/webhooks';
import * as screens from '../../functions/src/screens/screens';
import { db, deps, expectCode, resetEmulator, superadmin, user } from './helpers';

const alice = user('alice');
let orgId: string;
let screenId: string;

async function newOrg(name: string, owner = alice) {
  const r = await submitOrgSignup(deps, owner, {
    orgName: name,
    contactName: 'Asha',
    phone: '+91 98200 12345',
    city: 'Pune',
    stateCode: '27',
    expectedScreens: 2,
    timezone: 'Asia/Kolkata',
  });
  await reviewOrgSignup(deps, superadmin, { requestId: r.requestId, decision: 'approve' });
  return r.orgId;
}

const setPlan = async (features: string[], apiCallsPerDay: number | null = null) => {
  const ent = (await db.doc(paths.orgEntitlements(orgId)).get()).data()!;
  await db.doc(paths.orgEntitlements(orgId)).update({
    features: [...new Set([...(ent.features as string[]).filter((f) => !['api.keys', 'api.webhooks'].includes(f)), ...features])],
    'limits.apiCallsPerDay': apiCallsPerDay,
  });
};

const call = (method: string, path: string, key: string | null, body: unknown = {}, query: Record<string, string> = {}) =>
  handle(deps, { method, path: `/api${path}`, headers: key ? { authorization: `Bearer ${key}` } : {}, body, ip: '10.0.0.9', query });

beforeEach(async () => {
  await resetEmulator();
  orgId = await newOrg('Acme');
  const reg = await handle(deps, {
    method: 'POST',
    path: '/api/v1/devices/register',
    headers: {},
    ip: '10.0.0.9',
    body: { hardware: { manufacturer: 'X', model: 'Box', androidVersion: '11', sdkInt: 30, appVersion: '0.15.0', display: { width: 1920, height: 1080 } } },
  });
  const code = (reg.body as { pairingCode: string }).pairingCode;
  ({ screenId } = await screens.claimDevice(deps, alice, {
    orgId,
    pairingCode: code,
    name: 'Lobby',
    siteId: null,
    groupIds: [],
    orientation: 'landscape',
    resolution: { width: 1920, height: 1080 },
  }));
});

describe('API keys', () => {
  it('needs the plan feature; the key is shown once and only its hash is kept', async () => {
    await expectCode(createApiKey(deps, alice, { orgId, name: 'BMS', scopes: ['screens:read'] }), 'permission-denied');
    await setPlan(['api.keys']);
    const { keyId, key } = await createApiKey(deps, alice, { orgId, name: 'BMS', scopes: ['screens:read', 'screens:read'] });
    expect(key).toMatch(new RegExp(`^wxp_${keyId}_[A-Za-z0-9_-]{32}$`));
    const doc = (await db.doc(paths.apiKey(orgId, keyId)).get()).data() as ApiKeyDoc;
    expect(doc).toMatchObject({ name: 'BMS', scopes: ['screens:read'], revokedAt: null });
    expect(JSON.stringify(doc)).not.toContain(key.slice(-20));
    await expectCode(createApiKey(deps, user('eve'), { orgId, name: 'x1', scopes: ['screens:read'] }), 'permission-denied');
  });

  it('reads screens, sends commands, starts and ends emergencies within its scopes', async () => {
    await setPlan(['api.keys']);
    const { key } = await createApiKey(deps, alice, { orgId, name: 'Building system', scopes: ['screens:read', 'screens:command', 'emergency:write'] });
    const { key: readOnly } = await createApiKey(deps, alice, { orgId, name: 'Dashboard', scopes: ['screens:read'] });

    const me = await call('GET', '/v1/me', key);
    expect(me.body).toMatchObject({ organization: { id: orgId, name: 'Acme' }, key: { name: 'Building system' } });
    const list = await call('GET', '/v1/screens', readOnly);
    expect(list.status).toBe(200);
    expect((list.body as { screens: Array<{ name: string; status: string }> }).screens).toMatchObject([{ name: 'Lobby', status: 'authorized' }]);
    expect((await call('GET', `/v1/screens/${screenId}`, readOnly)).status).toBe(200);
    expect((await call('GET', '/v1/screens/nope', readOnly)).status).toBe(404);

    // Commands: refused for the read-only key, accepted (and audited as the key) for the other.
    expect((await call('POST', `/v1/screens/${screenId}/commands`, readOnly, { type: 'refresh' })).status).toBe(403);
    expect((await call('POST', `/v1/screens/${screenId}/commands`, key, { type: 'teleport' })).status).toBe(400);
    const sent = await call('POST', `/v1/screens/${screenId}/commands`, key, { type: 'restart_app' });
    expect(sent.status).toBe(201);
    const commandId = (sent.body as { commandId: string }).commandId;
    expect(((await db.doc(paths.command(orgId, screenId, commandId)).get()).data() as ScreenCommandDoc).createdBy).toMatch(/^apikey_/);
    const audits = await db.collection(paths.auditLogs(orgId)).where('action', '==', 'screen.command.restart_app').get();
    expect(audits.docs[0]!.data()).toMatchObject({ actorType: 'api_key', actorEmail: 'API key: Building system' });

    const started = await call('POST', '/v1/emergencies', key, { name: 'Fire alarm', content: { kind: 'message', text: 'Please leave the building' } });
    expect(started.status).toBe(201);
    const { emergencyId } = started.body as { emergencyId: string };
    expect((await call('GET', '/v1/emergencies', readOnly)).body).toMatchObject({ emergencies: [{ id: emergencyId, name: 'Fire alarm' }] });
    expect((await call('POST', `/v1/emergencies/${emergencyId}/end`, key)).status).toBe(200);
    expect((await call('GET', '/v1/reports/plays', readOnly, {}, { from: '2026-10-01', to: '2026-10-01' })).status).toBe(403);
  });

  it('refuses unknown, revoked and over-limit keys, and never acts in another organization', async () => {
    await setPlan(['api.keys'], 3);
    const { keyId, key } = await createApiKey(deps, alice, { orgId, name: 'BMS', scopes: ['screens:read', 'screens:command'] });
    expect((await call('GET', '/v1/me', null)).status).toBe(401);
    expect((await call('GET', '/v1/me', `wxp_${'x'.repeat(30)}`)).status).toBe(401);
    expect((await call('GET', '/v1/nothing-here', key)).status).toBe(404);
    for (let i = 0; i < 3; i++) expect((await call('GET', '/v1/me', key)).status).toBe(200);
    expect((await call('GET', '/v1/me', key)).status).toBe(429);

    await setPlan(['api.keys'], null);
    await revokeApiKey(deps, alice, { orgId, keyId });
    expect((await call('GET', '/v1/me', key)).status).toBe(401);

    // A key's identity carries its organization; it cannot be used on another one.
    const otherOrg = await newOrg('Other', user('bob'));
    const keyActor = { uid: `apikey_${keyId}`, email: 'API key: BMS', emailVerified: false, platformRole: null, apiKey: { orgId, keyId, name: 'BMS', scopes: ['screens:command' as const] } };
    await expectCode(sendScreenCommand(deps, keyActor, { orgId: otherOrg, screenId, type: 'refresh' }), 'permission-denied');
  });
});

describe('webhooks', () => {
  const sent: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  let status = 200;
  const hookDeps: Deps = {
    ...deps,
    lookup: async (host: string) => (host.endsWith('.internal') ? ['10.0.0.5'] : ['93.184.216.34']),
    fetch: (async (url: URL | string, init?: RequestInit) => {
      sent.push({ url: String(url), headers: init?.headers as Record<string, string>, body: String(init?.body) });
      return new Response(null, { status });
    }) as typeof fetch,
  };

  beforeEach(() => {
    sent.length = 0;
    status = 200;
  });

  it('are created with a secret shown once, refuse internal addresses, and send signed events once', async () => {
    await expectCode(saveWebhook(hookDeps, alice, { orgId, url: 'https://hooks.example.com/wallx', events: ['screen.offline'], active: true }), 'permission-denied');
    await setPlan(['api.webhooks']);
    await expectCode(saveWebhook(hookDeps, alice, { orgId, url: 'https://hooks.internal/x', events: ['screen.offline'], active: true }), 'invalid-argument');
    const { webhookId, secret } = await saveWebhook(hookDeps, alice, { orgId, url: 'https://hooks.example.com/wallx', events: ['screen.offline'], active: true });
    expect(secret).toMatch(/^whsec_/);
    expect(JSON.stringify((await db.doc(paths.webhook(orgId, webhookId)).get()).data())).not.toContain(secret!.slice(-20));

    const batch = db.batch();
    notify(batch, db, orgId, 'screen_offline', { screen: 'Lobby', lastSeen: 1 }, '/screens', deps.now());
    notify(batch, db, orgId, 'billing_past_due', {}, '/billing', deps.now());
    await batch.commit();
    const ids = (await db.collection(paths.notifications(orgId)).get()).docs.map((d) => d.data() as { id: string; type: string });
    const offline = ids.find((n) => n.type === 'screen_offline')!.id;
    expect(await deliverNotificationWebhooks(hookDeps, orgId, offline)).toBe(1);
    expect(await deliverNotificationWebhooks(hookDeps, orgId, offline)).toBe(0); // retried event: not sent twice
    expect(await deliverNotificationWebhooks(hookDeps, orgId, ids.find((n) => n.type === 'billing_past_due')!.id)).toBe(0);

    expect(sent).toHaveLength(1);
    const { headers, body } = sent[0]!;
    expect(JSON.parse(body)).toMatchObject({ id: offline, event: 'screen.offline', organization: { id: orgId, name: 'Acme' }, data: { screen: 'Lobby' } });
    const [, t, v1] = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(headers['X-WallX-Signature']!)!;
    expect(createHmac('sha256', secret!).update(`${t}.${body}`).digest('hex')).toBe(v1);
    expect(headers['X-WallX-Event']).toBe('screen.offline');

    const deliveries = (await db.collection(paths.webhookDeliveries(orgId, webhookId)).get()).docs.map((d) => d.data() as WebhookDeliveryDoc);
    expect(deliveries).toMatchObject([{ event: 'screen.offline', ok: true, status: 200, attempts: 1 }]);
  });

  it('retry, log failures, switch off after too many, and support test, rotate and delete', async () => {
    await setPlan(['api.webhooks']);
    const { webhookId, secret } = await saveWebhook(hookDeps, alice, { orgId, url: 'https://hooks.example.com/wallx', events: ['emergency.started'], active: true });
    status = 503;
    const hook = (await db.doc(paths.webhook(orgId, webhookId)).get()).data() as WebhookDoc;
    const payload = { id: 'n1', event: 'emergency.started' as const, createdAt: 1, organization: { id: orgId, name: 'Acme' }, data: {}, link: null };
    const result = await deliver(hookDeps, orgId, hook, payload, async () => undefined);
    expect(result).toMatchObject({ ok: false, status: 503 });
    expect(sent).toHaveLength(3);
    expect(((await db.doc(paths.webhook(orgId, webhookId)).get()).data() as WebhookDoc).failures).toBe(1);

    await db.doc(paths.webhook(orgId, webhookId)).update({ failures: 19 });
    await deliver(hookDeps, orgId, { ...hook, failures: 19 }, payload, async () => undefined);
    const off = (await db.doc(paths.webhook(orgId, webhookId)).get()).data() as WebhookDoc;
    expect(off).toMatchObject({ active: false, failures: 20 });
    expect(off.disabledReason).toContain('20');

    status = 204;
    expect(await testWebhook(hookDeps, alice, { orgId, webhookId })).toMatchObject({ ok: true, status: 204 });
    const { secret: rotated } = await rotateWebhookSecret(hookDeps, alice, { orgId, webhookId });
    expect(rotated).not.toBe(secret);
    await saveWebhook(hookDeps, alice, { orgId, webhookId, url: 'https://hooks.example.com/wallx', events: ['emergency.started'], active: true });
    expect((await db.doc(paths.webhook(orgId, webhookId)).get()).data()).toMatchObject({ active: true, failures: 0, disabledReason: null });
    await deleteWebhook(hookDeps, alice, { orgId, webhookId });
    expect((await db.doc(paths.webhook(orgId, webhookId)).get()).exists).toBe(false);
    expect((await db.doc(paths.webhookSecret(orgId, webhookId)).get()).exists).toBe(false);
  });
});

describe('Super Admin API overview', () => {
  it('counts keys, calls and webhooks per organization for staff only', async () => {
    await setPlan(['api.keys'], null);
    const { key } = await createApiKey(deps, alice, { orgId, name: 'BMS', scopes: ['screens:read'] });
    await call('GET', '/v1/me', key);
    await call('GET', '/v1/screens', key);
    const { apiOverview } = await import('../../functions/src/publicApi/overview');
    const r = await apiOverview(deps, superadmin, {});
    expect(r.orgs).toEqual([
      expect.objectContaining({ orgId, name: 'Acme', apiInPlan: true, activeKeys: 1, callsToday: 2, webhooks: 0, webhooksOff: 0 }),
    ]);
    await expectCode(apiOverview(deps, alice, {}), 'permission-denied');
  });
});
