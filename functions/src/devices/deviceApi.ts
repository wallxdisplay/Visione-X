/**
 * HTTP API used by the Android player (served at /api/v1/devices/*).
 * Authentication: `Authorization: Device <deviceId>:<secret>`; the secret is issued once at
 * registration and only its SHA-256 is stored. Responses are JSON.
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { notify } from '../lib/notify';
import { completeCommand, takePendingCommands } from '../ops/commands';
import {
  CommandResultBody,
  DEVICE_HEARTBEAT_SEC,
  DEVICE_POLL_SEC,
  HeartbeatBody,
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_LENGTH,
  PAIRING_TTL_MS,
  RegisterDeviceBody,
  paths,
  type DeviceDoc,
  type DeviceStateResponse,
  type OrgDoc,
  type ScreenDoc,
} from '@visione-x/shared';
import type { Deps } from '../lib/context';

export interface ApiRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  ip: string;
}
export interface ApiResult {
  status: number;
  body: unknown;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const fail = (status: number, error: string, message: string): ApiResult => ({ status, body: { error, message } });

/** Public site that renders the pairing QR target (`/screens?pair=CODE`). */
export const PAIRING_URL_BASE = process.env.PAIRING_URL_BASE ?? 'https://visione-x.web.app/screens?pair=';

export function newPairingCode(): string {
  let code = '';
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) code += PAIRING_CODE_ALPHABET[randomInt(PAIRING_CODE_ALPHABET.length)];
  return code;
}

/** Reserves a unique pairing code for a device (retries on the rare collision). */
async function issuePairingCode({ db, now }: Deps, deviceId: string): Promise<{ code: string; expiresAt: number }> {
  const expiresAt = now() + PAIRING_TTL_MS;
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = newPairingCode();
    try {
      await db.runTransaction(async (tx) => {
        const ref = db.doc(paths.pairingCode(code));
        const deviceRef = db.doc(paths.device(deviceId));
        const [existing, device] = await Promise.all([tx.get(ref), tx.get(deviceRef)]);
        const taken = existing.data() as { expiresAt: number } | undefined;
        if (taken && taken.expiresAt > now()) throw new Error('collision');
        // Retire the previous code so only the code currently on screen works.
        const previous = (device.data() as DeviceDoc | undefined)?.pairingCode;
        if (previous && previous !== code) tx.delete(db.doc(paths.pairingCode(previous)));
        tx.set(ref, { deviceId, expiresAt });
        tx.update(db.doc(paths.device(deviceId)), { pairingCode: code, pairingExpiresAt: expiresAt, updatedAt: now() });
      });
      return { code, expiresAt };
    } catch (err) {
      if ((err as Error).message !== 'collision') throw err;
    }
  }
  throw new Error('Could not allocate a pairing code');
}

/** Simple fixed-window limiter in Firestore (per key per hour). */
async function rateLimited({ db, now }: Deps, key: string, max: number): Promise<boolean> {
  const hour = Math.floor(now() / 3_600_000);
  const ref = db.doc(paths.rateLimit(`${key}_${hour}`));
  return db.runTransaction(async (tx) => {
    const count = Number((await tx.get(ref)).get('count') ?? 0);
    if (count >= max) return true;
    // Timestamp field so a Firestore TTL policy on rateLimits.expiresAt can purge old windows.
    tx.set(ref, { count: count + 1, expiresAt: new Date((hour + 2) * 3_600_000) }, { merge: true });
    return false;
  });
}

export async function authenticate(deps: Deps, req: ApiRequest): Promise<DeviceDoc | ApiResult> {
  const header = String(req.headers.authorization ?? '');
  const m = /^Device ([A-Za-z0-9_-]{10,64}):([A-Za-z0-9_-]{32,128})$/.exec(header);
  if (!m) return fail(401, 'unauthenticated', 'Missing or malformed device credentials.');
  const snap = await deps.db.doc(paths.device(m[1]!)).get();
  const device = snap.data() as DeviceDoc | undefined;
  const given = Buffer.from(sha256(m[2]!), 'hex');
  const ok = !!device && timingSafeEqual(Buffer.from(device.secretHash, 'hex'), given);
  if (!ok) return fail(401, 'unauthenticated', 'Unknown device or wrong secret.');
  if (device.status === 'revoked') return fail(403, 'revoked', 'This player was removed. Reset the app to pair it again.');
  return device;
}

export async function registerDevice(deps: Deps, req: ApiRequest): Promise<ApiResult> {
  const parsed = RegisterDeviceBody.safeParse(req.body);
  if (!parsed.success) return fail(400, 'invalid_argument', 'Invalid device information.');
  if (await rateLimited(deps, `register_${sha256(req.ip).slice(0, 16)}`, 20)) {
    return fail(429, 'rate_limited', 'Too many registrations from this network. Try again later.');
  }
  const { db, now } = deps;
  const ref = db.collection(paths.devices()).doc();
  const secret = randomBytes(32).toString('base64url');
  const device: DeviceDoc = {
    id: ref.id,
    status: 'unpaired',
    secretHash: sha256(secret),
    pairingCode: null,
    pairingExpiresAt: null,
    orgId: null,
    screenId: null,
    hardware: parsed.data.hardware,
    lastSeen: now(),
    createdAt: now(),
    updatedAt: now(),
  };
  await ref.create(device);
  const { code, expiresAt } = await issuePairingCode(deps, ref.id);
  return {
    status: 201,
    body: { deviceId: ref.id, deviceSecret: secret, pairingCode: code, pairingExpiresAt: expiresAt, pairingUrl: PAIRING_URL_BASE + code },
  };
}

export async function deviceState(deps: Deps, req: ApiRequest): Promise<ApiResult> {
  const auth = await authenticate(deps, req);
  if ('status' in auth && 'body' in auth) return auth;
  let device = auth as DeviceDoc;
  const { db, now } = deps;

  if (device.status === 'unpaired' && (!device.pairingCode || (device.pairingExpiresAt ?? 0) <= now())) {
    const { code, expiresAt } = await issuePairingCode(deps, device.id);
    device = { ...device, pairingCode: code, pairingExpiresAt: expiresAt };
  }

  let screen: ScreenDoc | undefined;
  let orgName: string | null = null;
  if (device.orgId && device.screenId) {
    const [s, o] = await db.getAll(db.doc(paths.screen(device.orgId, device.screenId)), db.doc(paths.org(device.orgId)));
    screen = s?.data() as ScreenDoc | undefined;
    orgName = (o?.data() as OrgDoc | undefined)?.name ?? null;
  }

  const body: DeviceStateResponse = {
    deviceId: device.id,
    status: device.status,
    pairingCode: device.status === 'unpaired' ? device.pairingCode : null,
    pairingExpiresAt: device.status === 'unpaired' ? device.pairingExpiresAt : null,
    pairingUrl: device.status === 'unpaired' && device.pairingCode ? PAIRING_URL_BASE + device.pairingCode : null,
    orgName,
    screen: screen
      ? {
          id: screen.id,
          name: screen.name,
          orientation: screen.orientation,
          resolution: screen.resolution,
          manifestVersion: screen.manifestVersion,
        }
      : null,
    commandsPending: device.status === 'authorized' ? (screen?.pendingCommands ?? 0) : 0,
    config: { pollSec: DEVICE_POLL_SEC, heartbeatSec: DEVICE_HEARTBEAT_SEC },
    serverTime: now(),
  };
  return { status: 200, body };
}

/** GET /devices/commands — pending remote commands for this screen (marks them delivered). */
export async function deviceCommands(deps: Deps, req: ApiRequest): Promise<ApiResult> {
  const auth = await authenticate(deps, req);
  if ('status' in auth && 'body' in auth) return auth;
  const device = auth as DeviceDoc;
  if (device.status !== 'authorized' || !device.orgId || !device.screenId) {
    return fail(403, 'not_authorized', 'This player is not authorized yet.');
  }
  return { status: 200, body: { commands: await takePendingCommands(deps, device.orgId, device.screenId) } };
}

/** POST /devices/commands/result — outcome of a command (optionally with a screenshot). */
export async function deviceCommandResult(deps: Deps, req: ApiRequest): Promise<ApiResult> {
  const auth = await authenticate(deps, req);
  if ('status' in auth && 'body' in auth) return auth;
  const device = auth as DeviceDoc;
  if (device.status !== 'authorized' || !device.orgId || !device.screenId) {
    return fail(403, 'not_authorized', 'This player is not authorized yet.');
  }
  const parsed = CommandResultBody.safeParse(req.body);
  if (!parsed.success) return fail(400, 'invalid_argument', 'Invalid command result.');
  const ok = await completeCommand(deps, device.orgId, device.screenId, parsed.data);
  return ok ? { status: 200, body: { ok: true } } : fail(404, 'not_found', 'Unknown or already completed command.');
}

export async function deviceManifest(deps: Deps, req: ApiRequest): Promise<ApiResult> {
  const auth = await authenticate(deps, req);
  if ('status' in auth && 'body' in auth) return auth;
  const device = auth as DeviceDoc;
  if (device.status !== 'authorized' || !device.orgId || !device.screenId) {
    return fail(403, 'not_authorized', 'This player is not authorized yet.');
  }
  const [org, manifest] = await deps.db.getAll(
    deps.db.doc(paths.org(device.orgId)),
    deps.db.doc(paths.screenManifest(device.orgId, device.screenId)),
  );
  if ((org?.data() as OrgDoc | undefined)?.status !== 'active') {
    return fail(403, 'org_inactive', 'The organization is not active.');
  }
  if (!manifest?.exists) return fail(404, 'not_published', 'Nothing has been published to this screen yet.');
  return { status: 200, body: manifest.data() };
}

export async function deviceHeartbeat(deps: Deps, req: ApiRequest): Promise<ApiResult> {
  const auth = await authenticate(deps, req);
  if ('status' in auth && 'body' in auth) return auth;
  const device = auth as DeviceDoc;
  const parsed = HeartbeatBody.safeParse(req.body);
  if (!parsed.success) return fail(400, 'invalid_argument', 'Invalid heartbeat.');
  const { db, now } = deps;
  const at = now();
  const batch = db.batch();
  batch.update(db.doc(paths.device(device.id)), {
    lastSeen: at,
    'hardware.appVersion': parsed.data.appVersion,
    'hardware.display': parsed.data.display,
    updatedAt: at,
  });
  if (device.orgId && device.screenId) {
    const screenRef = db.doc(paths.screen(device.orgId, device.screenId));
    const screen = (await screenRef.get()).data() as ScreenDoc | undefined;
    if (screen) {
      batch.update(screenRef, { lastSeen: at, health: { ...parsed.data, reportedAt: at }, offlineAlertedAt: null });
      // The monitor had raised an offline alert: tell the org it is back.
      if (screen.offlineAlertedAt) notify(batch, db, device.orgId, 'screen_online', { screen: screen.name }, '/screens', at);
    }
  }
  await batch.commit();
  return { status: 200, body: { ok: true, serverTime: at } };
}
