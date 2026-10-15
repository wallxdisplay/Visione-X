/**
 * Public REST API (v1.1, Enterprise): `Authorization: Bearer wxp_…` organization API keys.
 * Every action goes through the same services, permission checks (the key's scopes), plan
 * checks, approval workflow and audit log as the web app. Calls count against the plan's
 * apiCallsPerDay limit (per organization, per UTC day).
 */
import { createHash } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import { ZodError, z } from 'zod';
import {
  EMERGENCY_CONFIRM_PHRASE,
  EndEmergencyInput,
  OFFLINE_AFTER_MS,
  PlaybackReportInput,
  PublishScreensInput,
  ScreenAnalyticsInput,
  SendScreenCommandInput,
  TriggerEmergencyInput,
  paths,
  type ApiKeyLookupDoc,
  type EmergencyDoc,
  type EntitlementsDoc,
  type OrgDoc,
  type ScreenDoc,
} from '@wallx-play/shared';
import type { ApiRequest, ApiResult } from '../devices/deviceApi';
import { requireOrgPermission } from '../lib/authz';
import type { Actor, Deps } from '../lib/context';
import * as commands from '../ops/commands';
import * as emergency from '../ops/emergency';
import { screenAnalytics } from '../reports/analytics';
import { playbackReport } from '../reports/plays';
import * as screens from '../screens/screens';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const fail = (status: number, error: string, message: string, details?: unknown): ApiResult => ({ status, body: { error, message, ...(details ? { details } : {}) } });
const ok = (body: unknown, status = 200): ApiResult => ({ status, body });

/** Only refresh a key's "last used" time this often (avoids a write per call). */
const LAST_USED_EVERY_MS = 10 * 60_000;

const STATUS: Record<string, number> = {
  'invalid-argument': 400,
  unauthenticated: 401,
  'permission-denied': 403,
  'not-found': 404,
  'already-exists': 409,
  'failed-precondition': 409,
  'resource-exhausted': 429,
};

interface Caller {
  actor: Actor;
  orgId: string;
}

/** Bearer key → caller (or an error result). Also enforces the plan feature and daily limit. */
export async function authenticateApiKey(deps: Deps, req: ApiRequest): Promise<Caller | ApiResult> {
  const m = /^Bearer (wxp_[A-Za-z0-9_-]{20,200})$/.exec(String(req.headers.authorization ?? ''));
  if (!m) return fail(401, 'unauthenticated', 'Send an API key: Authorization: Bearer wxp_…');
  const { db, now } = deps;
  const lookup = (await db.doc(paths.apiKeyHash(sha256(m[1]!))).get()).data() as ApiKeyLookupDoc | undefined;
  if (!lookup || lookup.revoked) return fail(401, 'unauthenticated', 'Unknown or revoked API key.');
  const orgId = lookup.orgId;

  const day = new Date(now()).toISOString().slice(0, 10);
  const verdict = await db.runTransaction(async (tx) => {
    const [ent, org, usage] = await Promise.all([
      tx.get(db.doc(paths.orgEntitlements(orgId))),
      tx.get(db.doc(paths.org(orgId))),
      tx.get(db.doc(paths.apiUsage(orgId, day))),
    ]);
    const entitlements = ent.data() as EntitlementsDoc | undefined;
    if (!entitlements?.features.includes('api.keys')) return fail(403, 'not_in_plan', 'The API is not included in this organization’s plan.');
    if ((org.data() as OrgDoc | undefined)?.status !== 'active') return fail(403, 'org_inactive', 'The organization is not active.');
    const limit = entitlements.limits.apiCallsPerDay;
    const calls = Number(usage.get('calls') ?? 0);
    if (limit !== null && calls >= limit) return fail(429, 'rate_limited', `Daily API limit reached (${limit} calls per day, resets at 00:00 UTC).`);
    tx.set(db.doc(paths.apiUsage(orgId, day)), { orgId, day, calls: FieldValue.increment(1), expiresAt: new Date(now() + 40 * 86_400_000) }, { merge: true });
    return null;
  });
  if (verdict) return verdict;

  const keyRef = db.doc(paths.apiKey(orgId, lookup.keyId));
  void keyRef
    .get()
    .then((s) => {
      const last = (s.get('lastUsedAt') as number | null | undefined) ?? 0;
      return now() - last > LAST_USED_EVERY_MS ? keyRef.update({ lastUsedAt: now() }) : undefined;
    })
    .catch(() => undefined);

  return {
    orgId,
    actor: {
      uid: `apikey_${lookup.keyId}`,
      email: `API key: ${lookup.name}`,
      emailVerified: false,
      platformRole: null,
      apiKey: { orgId, keyId: lookup.keyId, name: lookup.name, scopes: lookup.scopes },
    },
  };
}

/** Public view of a screen. */
function screenView(s: ScreenDoc, at: number) {
  return {
    id: s.id,
    name: s.name,
    siteId: s.siteId ?? null,
    status: s.status,
    online: s.status === 'authorized' && !!s.lastSeen && at - s.lastSeen < OFFLINE_AFTER_MS,
    lastSeen: s.lastSeen ?? null,
    orientation: s.orientation,
    resolution: s.resolution,
    publishedVersion: s.manifestVersion,
    playingVersion: s.health?.manifestVersion ?? null,
    publishedAt: s.publishedAt ?? null,
    playerVersion: s.health?.appVersion ?? null,
  };
}

async function requirePermission(deps: Deps, c: Caller, permission: Parameters<typeof requireOrgPermission>[4]) {
  await deps.db.runTransaction((tx) => requireOrgPermission(tx, deps.db, c.actor, c.orgId, permission));
}

const body = (req: ApiRequest) => (req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {});
const q = (req: ApiRequest, k: string) => {
  const v = req.query?.[k];
  return typeof v === 'string' && v ? v : null;
};

type Route = { method: string; pattern: RegExp; run: (deps: Deps, c: Caller, req: ApiRequest, p: string[]) => Promise<ApiResult> };

const ROUTES: Route[] = [
  {
    method: 'GET',
    pattern: /^\/v1\/me$/,
    run: async (deps, c) => {
      const [org, ent, usage] = await deps.db.getAll(
        deps.db.doc(paths.org(c.orgId)),
        deps.db.doc(paths.orgEntitlements(c.orgId)),
        deps.db.doc(paths.apiUsage(c.orgId, new Date(deps.now()).toISOString().slice(0, 10))),
      );
      return ok({
        organization: { id: c.orgId, name: (org!.data() as OrgDoc).name },
        key: { id: c.actor.apiKey!.keyId, name: c.actor.apiKey!.name, scopes: c.actor.apiKey!.scopes },
        usage: { today: Number(usage!.get('calls') ?? 0), limitPerDay: (ent!.data() as EntitlementsDoc).limits.apiCallsPerDay },
      });
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/screens$/,
    run: async (deps, c) => {
      await requirePermission(deps, c, 'screen.view');
      const snap = await deps.db.collection(paths.screens(c.orgId)).get();
      const at = deps.now();
      return ok({ screens: snap.docs.map((d) => screenView(d.data() as ScreenDoc, at)).sort((a, b) => a.name.localeCompare(b.name)) });
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/screens\/([A-Za-z0-9_-]{1,128})$/,
    run: async (deps, c, _req, [screenId]) => {
      await requirePermission(deps, c, 'screen.view');
      const s = (await deps.db.doc(paths.screen(c.orgId, screenId!)).get()).data() as ScreenDoc | undefined;
      return s ? ok({ screen: screenView(s, deps.now()) }) : fail(404, 'not_found', 'Screen not found.');
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/screens\/([A-Za-z0-9_-]{1,128})\/commands$/,
    run: async (deps, c, req, [screenId]) => {
      const input = SendScreenCommandInput.parse({ orgId: c.orgId, screenId, type: body(req).type });
      return ok(await commands.sendScreenCommand(deps, c.actor, input), 201);
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/publish$/,
    run: async (deps, c, req) => {
      const b = body(req);
      const input = PublishScreensInput.extend({ note: z.string().trim().max(500).optional() }).parse({
        orgId: c.orgId,
        screenIds: b.screenIds ?? [],
        ...(b.note !== undefined ? { note: b.note } : {}),
      });
      return ok(await screens.publishScreens(deps, c.actor, input));
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/emergencies$/,
    run: async (deps, c) => {
      await requirePermission(deps, c, 'screen.view');
      const snap = await deps.db.collection(paths.emergencies(c.orgId)).where('active', '==', true).get();
      return ok({
        emergencies: snap.docs.map((d) => {
          const e = d.data() as EmergencyDoc;
          return { id: e.id, name: e.name, target: e.target, startedAt: e.startedAt, expiresAt: e.expiresAt, screens: e.screenCount };
        }),
      });
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/emergencies$/,
    run: async (deps, c, req) => {
      const b = body(req);
      // Calling this endpoint is the explicit action; the web app's typed confirmation does not apply.
      const input = TriggerEmergencyInput.parse({
        orgId: c.orgId,
        name: b.name,
        content: b.content,
        target: b.target ?? { kind: 'all' },
        durationMinutes: b.durationMinutes ?? null,
        confirm: EMERGENCY_CONFIRM_PHRASE,
      });
      return ok(await emergency.triggerEmergency(deps, c.actor, input), 201);
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/emergencies\/([A-Za-z0-9_-]{1,128})\/end$/,
    run: async (deps, c, _req, [emergencyId]) => ok(await emergency.endEmergency(deps, c.actor, EndEmergencyInput.parse({ orgId: c.orgId, emergencyId }))),
  },
  {
    method: 'GET',
    pattern: /^\/v1\/reports\/plays$/,
    run: async (deps, c, req) =>
      ok(
        await playbackReport(
          deps,
          c.actor,
          PlaybackReportInput.parse({ orgId: c.orgId, from: q(req, 'from'), to: q(req, 'to'), siteId: q(req, 'siteId'), screenId: q(req, 'screenId') }),
        ),
      ),
  },
  {
    method: 'GET',
    pattern: /^\/v1\/reports\/screens$/,
    run: async (deps, c, req) =>
      ok(
        await screenAnalytics(
          deps,
          c.actor,
          ScreenAnalyticsInput.parse({ orgId: c.orgId, from: q(req, 'from'), to: q(req, 'to'), siteId: q(req, 'siteId'), screenId: q(req, 'screenId') }),
        ),
      ),
  },
];

/** True when this path belongs to the public API (so the router can answer 404s itself). */
export const isPublicApiPath = (path: string) => /^\/v1\/(me|screens|publish|emergencies|reports)(\/|$)/.test(path);

export async function handlePublicApi(deps: Deps, req: ApiRequest, path: string): Promise<ApiResult> {
  const route = ROUTES.find((r) => r.method === req.method && r.pattern.test(path));
  if (!route) return fail(404, 'not_found', 'Unknown API endpoint. See the API reference in WallX Play.');
  const caller = await authenticateApiKey(deps, req);
  if ('status' in caller) return caller;
  try {
    return await route.run(deps, caller, req, route.pattern.exec(path)!.slice(1));
  } catch (err) {
    if (err instanceof ZodError) return fail(400, 'invalid_argument', 'Some fields are invalid.', err.flatten());
    if (err instanceof HttpsError) return fail(STATUS[err.code] ?? 400, err.code.replace(/-/g, '_'), err.message);
    logger.error('Public API error', { path, error: (err as Error).message });
    return fail(500, 'internal', 'Something went wrong.');
  }
}
