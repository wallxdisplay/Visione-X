/**
 * Webhooks (v1.1, Enterprise): WallX Play POSTs JSON to a customer's HTTPS endpoint when screens
 * go offline/online, emergencies start/end, publish approvals are requested/decided and sensors
 * alert. Each request is signed:
 *   X-WallX-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>
 * Deliveries are tried up to 3 times, logged for WEBHOOK_DELIVERY_DAYS, and a webhook is
 * switched off after WEBHOOK_DISABLE_AFTER failures in a row. Addresses are checked against
 * internal networks (SSRF) when saved and on every delivery. Secrets are server-only.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import type { z } from 'zod';
import {
  MAX_WEBHOOKS,
  NOTIFICATION_WEBHOOK_EVENTS,
  REGION,
  WEBHOOK_DELIVERY_DAYS,
  WEBHOOK_DISABLE_AFTER,
  paths,
  type EntitlementsDoc,
  type NotificationDoc,
  type OrgDoc,
  type SaveWebhookInput,
  type WebhookDelivery,
  type WebhookDoc,
  type WebhookPayload,
  type WebhookRefInput,
} from '@wallx-play/shared';
import { userAudit } from '../content/media';
import { getDeps } from '../lib/admin';
import { auditedTransaction } from '../lib/audit';
import { requireActiveOrgPermission, requireOrgPermission } from '../lib/authz';
import type { Actor, Deps } from '../lib/context';
import { APP_URL } from '../lib/email';
import { readEntitlements, requireFeature } from '../lib/entitlements';
import { FetchError, checkPublicUrl, safePost } from '../integrations/net';

const DAY = 86_400_000;
/** Waits before each try (the first is immediate). */
export const RETRY_DELAYS_MS = [0, 2_000, 8_000];

const newSecret = () => `whsec_${randomBytes(24).toString('base64url')}`;
const hint = (secret: string) => `${secret.slice(0, 10)}…`;

/** Signature header value for a body sent at `unixSeconds`. */
export function signWebhook(secret: string, body: string, unixSeconds: number): string {
  return `t=${unixSeconds},v1=${createHmac('sha256', secret).update(`${unixSeconds}.${body}`).digest('hex')}`;
}

async function assertReachable(deps: Deps, url: string) {
  try {
    await checkPublicUrl(deps, url);
  } catch (err) {
    throw new HttpsError('invalid-argument', err instanceof FetchError ? err.message : 'This address cannot be used.');
  }
}

export async function saveWebhook(
  deps: Deps,
  actor: Actor,
  input: z.infer<typeof SaveWebhookInput>,
): Promise<{ webhookId: string; secret?: string }> {
  const { db, now } = deps;
  const at = now();
  await assertReachable(deps, input.url);
  const creating = !input.webhookId;
  const ref = input.webhookId ? db.doc(paths.webhook(input.orgId, input.webhookId)) : db.collection(paths.webhooks(input.orgId)).doc();
  const secret = creating ? newSecret() : undefined;
  const events = [...new Set(input.events)];
  await auditedTransaction(db, [input.orgId], async (tx, audit) => {
    await requireActiveOrgPermission(tx, db, actor, input.orgId, 'apikey.manage');
    requireFeature(await readEntitlements(tx, db, input.orgId), 'api.webhooks', 'Webhooks');
    if (creating) {
      const count = await tx.get(db.collection(paths.webhooks(input.orgId)).count());
      if (count.data().count >= MAX_WEBHOOKS) throw new HttpsError('resource-exhausted', `An organization can have at most ${MAX_WEBHOOKS} webhooks.`);
      const doc: WebhookDoc = {
        id: ref.id,
        url: input.url,
        events,
        active: input.active,
        disabledReason: null,
        failures: 0,
        lastDelivery: null,
        secretHint: hint(secret!),
        createdBy: actor.uid,
        createdAt: at,
        updatedAt: at,
      };
      tx.create(ref, doc);
      tx.set(db.doc(paths.webhookSecret(input.orgId, ref.id)), { secret });
    } else {
      const before = (await tx.get(ref)).data() as WebhookDoc | undefined;
      if (!before) throw new HttpsError('not-found', 'Webhook not found.');
      // Switching it back on clears WallX's automatic switch-off.
      tx.update(ref, { url: input.url, events, active: input.active, ...(input.active ? { disabledReason: null, failures: 0 } : {}), updatedAt: at });
    }
    audit(input.orgId, {
      at,
      ...userAudit(actor),
      orgId: input.orgId,
      action: creating ? 'webhook.created' : 'webhook.updated',
      target: { type: 'webhook', id: ref.id },
      data: { url: input.url, events, active: input.active },
    });
  });
  return { webhookId: ref.id, ...(secret ? { secret } : {}) };
}

export async function deleteWebhook(deps: Deps, actor: Actor, input: z.infer<typeof WebhookRefInput>): Promise<void> {
  const { db, now } = deps;
  const ref = db.doc(paths.webhook(input.orgId, input.webhookId));
  await auditedTransaction(db, [input.orgId], async (tx, audit) => {
    await requireOrgPermission(tx, db, actor, input.orgId, 'apikey.manage');
    const hook = (await tx.get(ref)).data() as WebhookDoc | undefined;
    if (!hook) throw new HttpsError('not-found', 'Webhook not found.');
    tx.delete(ref);
    tx.delete(db.doc(paths.webhookSecret(input.orgId, input.webhookId)));
    audit(input.orgId, { at: now(), ...userAudit(actor), orgId: input.orgId, action: 'webhook.deleted', target: { type: 'webhook', id: input.webhookId }, data: { url: hook.url } });
  });
}

export async function rotateWebhookSecret(deps: Deps, actor: Actor, input: z.infer<typeof WebhookRefInput>): Promise<{ secret: string }> {
  const { db, now } = deps;
  const ref = db.doc(paths.webhook(input.orgId, input.webhookId));
  const secret = newSecret();
  await auditedTransaction(db, [input.orgId], async (tx, audit) => {
    await requireOrgPermission(tx, db, actor, input.orgId, 'apikey.manage');
    if (!(await tx.get(ref)).exists) throw new HttpsError('not-found', 'Webhook not found.');
    tx.update(ref, { secretHint: hint(secret), updatedAt: now() });
    tx.set(db.doc(paths.webhookSecret(input.orgId, input.webhookId)), { secret });
    audit(input.orgId, { at: now(), ...userAudit(actor), orgId: input.orgId, action: 'webhook.secret_rotated', target: { type: 'webhook', id: input.webhookId } });
  });
  return { secret };
}

/** Sends one payload to one webhook (with retries), logs it and updates the webhook's state. */
export async function deliver(
  deps: Deps,
  orgId: string,
  hook: WebhookDoc,
  payload: WebhookPayload,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<WebhookDelivery> {
  const { db, now } = deps;
  const secret = (await db.doc(paths.webhookSecret(orgId, hook.id)).get()).get('secret') as string | undefined;
  const started = now();
  let result: WebhookDelivery = { at: started, ok: false, status: null, error: 'No signing secret.' };
  let attempts = 0;
  if (secret) {
    const body = JSON.stringify(payload);
    for (const delay of RETRY_DELAYS_MS) {
      if (delay) await wait(delay);
      attempts++;
      try {
        const sentAt = Math.floor(now() / 1000);
        const status = await safePost(deps, hook.url, body, {
          'X-WallX-Event': payload.event,
          'X-WallX-Delivery': payload.id,
          'X-WallX-Signature': signWebhook(secret, body, sentAt),
        });
        result = { at: started, ok: status >= 200 && status < 300, status, error: status >= 200 && status < 300 ? null : `HTTP ${status}` };
        // Client errors (other than rate limiting) will not pass on a retry.
        if (result.ok || (status >= 400 && status < 500 && status !== 429)) break;
      } catch (err) {
        result = { at: started, ok: false, status: null, error: err instanceof FetchError ? err.message : 'Delivery failed.' };
        // A blocked or unknown address will not change between tries.
        if (err instanceof FetchError && /not reachable|could not be found|https/.test(err.message)) break;
      }
    }
  }
  const failures = result.ok ? 0 : hook.failures + 1;
  const disable = !result.ok && failures >= WEBHOOK_DISABLE_AFTER && payload.event !== 'ping';
  const batch = db.batch();
  batch.create(db.collection(paths.webhookDeliveries(orgId, hook.id)).doc(), {
    ...result,
    event: payload.event,
    attempts,
    durationMs: now() - started,
    expiresAt: new Date(now() + WEBHOOK_DELIVERY_DAYS * DAY),
  });
  batch.update(db.doc(paths.webhook(orgId, hook.id)), {
    lastDelivery: result,
    // A test ping does not count towards switching a webhook off.
    ...(payload.event === 'ping' ? {} : { failures: result.ok ? 0 : FieldValue.increment(1) }),
    ...(disable ? { active: false, disabledReason: `Switched off after ${WEBHOOK_DISABLE_AFTER} failed deliveries in a row.` } : {}),
  });
  await batch.commit().catch((err) => logger.warn('Could not record webhook delivery', { orgId, webhookId: hook.id, error: (err as Error).message }));
  return result;
}

async function orgRef(deps: Deps, orgId: string) {
  const org = (await deps.db.doc(paths.org(orgId)).get()).data() as OrgDoc | undefined;
  return { id: orgId, name: org?.name ?? '' };
}

/** "Send test": a ping to one webhook, right now. */
export async function testWebhook(deps: Deps, actor: Actor, input: z.infer<typeof WebhookRefInput>): Promise<WebhookDelivery> {
  const { db, now } = deps;
  const hook = await db.runTransaction(async (tx) => {
    await requireOrgPermission(tx, db, actor, input.orgId, 'apikey.manage');
    requireFeature(await readEntitlements(tx, db, input.orgId), 'api.webhooks', 'Webhooks');
    return (await tx.get(db.doc(paths.webhook(input.orgId, input.webhookId)))).data() as WebhookDoc | undefined;
  });
  if (!hook) throw new HttpsError('not-found', 'Webhook not found.');
  const payload: WebhookPayload = {
    id: `ping_${randomBytes(8).toString('hex')}`,
    event: 'ping',
    createdAt: now(),
    organization: await orgRef(deps, input.orgId),
    data: { message: 'Test from WallX Play' },
    link: null,
  };
  return deliver(deps, input.orgId, hook, payload);
}

/** Sends a new in-app notification to the webhooks subscribed to its event (once). */
export async function deliverNotificationWebhooks(deps: Deps, orgId: string, notificationId: string): Promise<number> {
  const { db, now } = deps;
  const n = (await db.doc(`${paths.notifications(orgId)}/${notificationId}`).get()).data() as NotificationDoc | undefined;
  const event = n ? NOTIFICATION_WEBHOOK_EVENTS[n.type] : undefined;
  if (!n || !event) return 0;
  const ent = (await db.doc(paths.orgEntitlements(orgId)).get()).data() as EntitlementsDoc | undefined;
  if (!ent?.features.includes('api.webhooks')) return 0;
  const hooks = (await db.collection(paths.webhooks(orgId)).where('active', '==', true).where('events', 'array-contains', event).get()).docs.map(
    (d) => d.data() as WebhookDoc,
  );
  if (!hooks.length) return 0;
  try {
    await db.doc(`webhookLog/${orgId}_${notificationId}`).create({ at: now(), expiresAt: new Date(now() + 7 * DAY) });
  } catch {
    return 0; // already delivered (event retried)
  }
  const payload: WebhookPayload = {
    id: notificationId,
    event,
    createdAt: n.createdAt,
    organization: await orgRef(deps, orgId),
    data: n.params,
    link: n.link ? `${APP_URL}${n.link}` : null,
  };
  await Promise.all(hooks.map((h) => deliver(deps, orgId, h, payload)));
  return hooks.length;
}

export const webhookNotification = onDocumentCreated(
  { region: REGION, document: 'orgs/{orgId}/notifications/{notificationId}', memory: '256MiB', cpu: 'gcf_gen1', maxInstances: 5, timeoutSeconds: 120 },
  async (event) => {
    try {
      await deliverNotificationWebhooks(getDeps(), event.params.orgId, event.params.notificationId);
    } catch (err) {
      logger.error('Webhook delivery failed', { orgId: event.params.orgId, error: (err as Error).message });
    }
  },
);
