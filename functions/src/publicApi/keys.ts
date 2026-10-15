/**
 * Organization API keys (v1.1, Enterprise). Members with apikey.manage create keys with chosen
 * scopes; the key is returned once and only its SHA-256 is kept (apiKeyHashes, server-only).
 * Revoking takes effect on the next call. Both are audited.
 */
import { createHash, randomBytes } from 'node:crypto';
import { HttpsError } from 'firebase-functions/v2/https';
import type { z } from 'zod';
import {
  API_KEY_PREFIX,
  MAX_API_KEYS,
  paths,
  type ApiKeyDoc,
  type ApiKeyLookupDoc,
  type ApiKeyRefInput,
  type CreateApiKeyInput,
} from '@wallx-play/shared';
import { userAudit } from '../content/media';
import { auditedTransaction } from '../lib/audit';
import { requireActiveOrgPermission, requireOrgPermission } from '../lib/authz';
import type { Actor, Deps } from '../lib/context';
import { readEntitlements, requireFeature } from '../lib/entitlements';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export async function createApiKey(deps: Deps, actor: Actor, input: z.infer<typeof CreateApiKeyInput>): Promise<{ keyId: string; key: string }> {
  const { db, now } = deps;
  const at = now();
  const ref = db.collection(paths.apiKeys(input.orgId)).doc();
  const key = `${API_KEY_PREFIX}${ref.id}_${randomBytes(24).toString('base64url')}`;
  const scopes = [...new Set(input.scopes)];
  await auditedTransaction(db, [input.orgId], async (tx, audit) => {
    await requireActiveOrgPermission(tx, db, actor, input.orgId, 'apikey.manage');
    requireFeature(await readEntitlements(tx, db, input.orgId), 'api.keys', 'The API');
    const active = await tx.get(db.collection(paths.apiKeys(input.orgId)).where('revokedAt', '==', null).count());
    if (active.data().count >= MAX_API_KEYS) throw new HttpsError('resource-exhausted', `An organization can have at most ${MAX_API_KEYS} active API keys.`);
    const doc: ApiKeyDoc = {
      id: ref.id,
      name: input.name,
      hint: `${key.slice(0, 12)}…`,
      scopes,
      createdBy: actor.uid,
      createdAt: at,
      lastUsedAt: null,
      revokedAt: null,
      revokedBy: null,
    };
    const lookup: ApiKeyLookupDoc = { orgId: input.orgId, keyId: ref.id, name: input.name, scopes, revoked: false };
    tx.create(ref, doc);
    tx.create(db.doc(paths.apiKeyHash(sha256(key))), lookup);
    audit(input.orgId, {
      at,
      ...userAudit(actor),
      orgId: input.orgId,
      action: 'apikey.created',
      target: { type: 'apiKey', id: ref.id },
      data: { name: input.name, scopes },
    });
  });
  return { keyId: ref.id, key };
}

export async function revokeApiKey(deps: Deps, actor: Actor, input: z.infer<typeof ApiKeyRefInput>): Promise<void> {
  const { db, now } = deps;
  const at = now();
  const ref = db.doc(paths.apiKey(input.orgId, input.keyId));
  await auditedTransaction(db, [input.orgId], async (tx, audit) => {
    // Revoking stays possible while the subscription is restricted.
    await requireOrgPermission(tx, db, actor, input.orgId, 'apikey.manage');
    const key = (await tx.get(ref)).data() as ApiKeyDoc | undefined;
    if (!key) throw new HttpsError('not-found', 'API key not found.');
    if (key.revokedAt) return;
    const lookups = await tx.get(db.collection('apiKeyHashes').where('orgId', '==', input.orgId).where('keyId', '==', input.keyId));
    lookups.docs.forEach((d) => tx.update(d.ref, { revoked: true }));
    tx.update(ref, { revokedAt: at, revokedBy: actor.uid });
    audit(input.orgId, {
      at,
      ...userAudit(actor),
      orgId: input.orgId,
      action: 'apikey.revoked',
      target: { type: 'apiKey', id: input.keyId },
      data: { name: key.name },
    });
  });
}
