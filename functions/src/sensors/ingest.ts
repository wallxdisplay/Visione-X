/**
 * POST /api/v1/ingest — readings from ESP32 (and other) sensor devices.
 *
 * Checks, in order: API key → device (active) → org (active) → plan includes sensors →
 * rate limit (token bucket per device) → clock skew → per reading: channel exists, value
 * type, valid range. Accepted readings update the channel's latest value, are appended to the
 * channel's hourly bucket and evaluated against its alert rules — all in one transaction.
 */
import { FieldValue, Timestamp, type DocumentSnapshot } from 'firebase-admin/firestore';
import {
  INGEST_MAX_SKEW_MS,
  INGEST_RATE,
  IngestBody,
  STALE_COVERED_BY_OFFLINE,
  ingestTimeMs,
  paths,
  readingBucketId,
  ruleBreached,
  type AlertDoc,
  type EntitlementsDoc,
  type IngestRejectReason,
  type MqttBrokerDoc,
  type IngestResponse,
  type OrgDoc,
  type SensorChannelDoc,
  type SensorDeviceDoc,
  type SensorKeyDoc,
} from '@wallx-play/shared';
import type { Deps } from '../lib/context';
import type { ApiRequest, ApiResult } from '../devices/deviceApi';
import { openAlert, resolveAlert } from './alerts';
import { sha256 } from './sensors';

const fail = (status: number, error: string, message: string, extra: Record<string, unknown> = {}): ApiResult => ({
  status,
  body: { error, message, ...extra },
});

/** Refills the device's token bucket up to `now`. */
export function refill(rate: { tokens: number; at: number }, now: number): number {
  return Math.min(INGEST_RATE.capacity, rate.tokens + Math.max(0, now - rate.at) / INGEST_RATE.refillMs);
}

/** Normalizes a reading for the channel type (booleans become 1/0), or says why not. */
export function acceptValue(channel: Pick<SensorChannelDoc, 'valueType' | 'min' | 'max'>, raw: number | boolean): number | IngestRejectReason {
  let v: number;
  if (channel.valueType === 'boolean') {
    if (typeof raw === 'boolean') v = raw ? 1 : 0;
    else if (raw === 0 || raw === 1) v = raw;
    else return 'wrong_type';
  } else {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return 'wrong_type';
    v = raw;
    if ((channel.min !== null && v < channel.min) || (channel.max !== null && v > channel.max)) return 'out_of_range';
  }
  return v;
}

export async function ingest(deps: Deps, req: ApiRequest): Promise<ApiResult> {
  const { db } = deps;
  const m = /^Bearer (wxp_[A-Za-z0-9_-]{32})$/.exec(String(req.headers.authorization ?? '').trim());
  if (!m) return fail(401, 'unauthenticated', 'Send the device API key as "Authorization: Bearer wxp_…".');
  const parsed = IngestBody.safeParse(req.body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return fail(400, 'invalid_argument', `Invalid payload${issue ? ` at ${issue.path.join('.') || 'body'}: ${issue.message}` : ''}.`);
  }
  const body = parsed.data;

  const keyDoc = (await db.doc(paths.sensorKey(sha256(m[1]!))).get()).data() as SensorKeyDoc | undefined;
  if (!keyDoc) return fail(401, 'unauthenticated', 'Unknown API key.');
  const { orgId, sensorDeviceId } = keyDoc;
  if (body.deviceId && body.deviceId !== sensorDeviceId) {
    return fail(400, 'device_mismatch', 'deviceId does not belong to this API key.');
  }
  return ingestReadings(deps, orgId, sensorDeviceId, body, { kind: 'http' });
}

/** Who delivers the readings: the device itself (API key) or an MQTT bridge screen. */
export type IngestVia = { kind: 'http' } | { kind: 'mqtt'; screenId: string };

/** The ingest core: checks, history, latest value and alerts for one sensor device, in one transaction. */
export async function ingestReadings(
  deps: Deps,
  orgId: string,
  sensorDeviceId: string,
  body: Pick<IngestBody, 'ts' | 'fw' | 'readings'>,
  via: IngestVia,
): Promise<ApiResult> {
  const { db, now } = deps;
  const deviceRef = db.doc(paths.sensorDevice(orgId, sensorDeviceId));
  const channelKeys = [...new Set(body.readings.map((r) => r.channel).filter((c) => /^[a-z0-9_]{1,32}$/.test(c)))];

  return db.runTransaction(async (tx): Promise<ApiResult> => {
    const at = now();
    // ---- reads (all before any write)
    const [deviceSnap, orgSnap, entSnap, ...channelSnaps] = await tx.getAll(
      deviceRef,
      db.doc(paths.org(orgId)),
      db.doc(paths.orgEntitlements(orgId)),
      ...channelKeys.map((c) => db.doc(paths.sensorChannel(orgId, sensorDeviceId, c))),
    );
    const device = deviceSnap!.data() as SensorDeviceDoc | undefined;
    if (!device) return via.kind === 'http' ? fail(401, 'unauthenticated', 'Unknown API key.') : fail(404, 'not_found', 'Unknown sensor device.');
    if (device.status !== 'active') return fail(403, 'disabled', 'This sensor device is disabled.');
    if ((orgSnap!.data() as OrgDoc | undefined)?.status !== 'active') return fail(403, 'org_inactive', 'The organization is not active.');
    const entitlements = entSnap!.data() as EntitlementsDoc | undefined;
    if (!entitlements?.features.includes('sensor.esp32')) return fail(403, 'not_entitled', 'Sensors are not included in the plan.');
    const transport = device.transport ?? 'http';
    if (via.kind === 'mqtt') {
      // Only the broker's bridge screen may report for an MQTT device.
      if (transport !== 'mqtt' || !device.mqttBrokerId) return fail(403, 'not_mqtt', 'This sensor device does not read from MQTT.');
      if (!entitlements.features.includes('sensor.mqtt')) return fail(403, 'not_entitled', 'MQTT sensors are not included in the plan.');
      const broker = (await tx.get(db.doc(paths.mqttBroker(orgId, device.mqttBrokerId)))).data() as MqttBrokerDoc | undefined;
      if (broker?.bridgeScreenId !== via.screenId) return fail(403, 'not_bridge', 'This screen is not the bridge for this sensor device’s broker.');
    } else if (transport !== 'http') {
      return fail(403, 'not_http', 'This sensor device reads from MQTT.');
    }

    const tokens = refill(device.rate, at);
    if (tokens < 1) {
      const retryAfterSec = Math.ceil(((1 - tokens) * INGEST_RATE.refillMs) / 1000);
      return fail(429, 'rate_limited', `Too many requests; send at most one every ${INGEST_RATE.refillMs / 1000} s.`, { retryAfterSec });
    }
    const sent = ingestTimeMs(body.ts);
    if (sent !== null && Math.abs(sent - at) > INGEST_MAX_SKEW_MS) {
      return fail(400, 'clock_skew', 'The reading time is too far from server time. Sync the clock (NTP) or omit ts.', { serverTime: at });
    }
    const readingAt = sent ?? at;

    const channels = new Map<string, { doc: SensorChannelDoc; snap: DocumentSnapshot }>();
    channelSnaps.forEach((s) => s?.exists && channels.set(s.id, { doc: s.data() as SensorChannelDoc, snap: s }));
    const parked =
      device.offlineAlertId !== null
        ? await tx.get(db.collection(paths.sensorChannels(orgId, sensorDeviceId)).where('staleAlertId', '==', STALE_COVERED_BY_OFFLINE))
        : null;

    // ---- evaluate
    const rejected: IngestResponse['rejected'] = [];
    const seen = new Set<string>();
    const accepted: Array<{ key: string; channel: SensorChannelDoc; ref: DocumentSnapshot['ref']; value: number }> = [];
    for (const r of body.readings) {
      const entry = channels.get(r.channel);
      if (!entry) {
        rejected.push({ channel: r.channel, reason: 'unknown_channel' });
        continue;
      }
      if (seen.has(r.channel)) {
        rejected.push({ channel: r.channel, reason: 'duplicate' });
        continue;
      }
      seen.add(r.channel);
      const v = acceptValue(entry.doc, r.value);
      if (typeof v !== 'number') rejected.push({ channel: r.channel, reason: v });
      else accepted.push({ key: r.channel, channel: entry.doc, ref: entry.snap.ref, value: v });
    }

    // ---- writes
    const retentionDays = entitlements.limits.retentionDays;
    const hour = Math.floor(readingAt / 3_600_000) * 3_600_000;
    for (const { key, channel, ref, value } of accepted) {
      tx.set(
        db.doc(paths.sensorReading(orgId, sensorDeviceId, key, readingBucketId(readingAt))),
        {
          hour,
          points: FieldValue.arrayUnion({ t: readingAt, v: value }),
          ...(retentionDays ? { expiresAt: Timestamp.fromMillis(hour + (retentionDays + 1) * 86_400_000) } : {}),
        },
        { merge: true },
      );
      // A late reading (older than the latest) only goes into history.
      if (channel.latest && readingAt < channel.latest.ts) continue;

      const openAlerts = { ...channel.openAlerts };
      for (const rule of channel.alertRules) {
        const openId = openAlerts[rule.id];
        const breached = ruleBreached(rule, value, !!openId);
        if (breached && !openId) {
          openAlerts[rule.id] = openAlert(
            tx,
            db,
            orgId,
            {
              type: 'threshold',
              severity: rule.severity,
              sensorDeviceId,
              siteId: device.siteId,
              sensorName: device.name,
              channelId: key,
              channelName: channel.name,
              unit: channel.unit,
              ruleId: rule.id,
              ruleLabel: rule.label,
              operator: rule.operator,
              limit: rule.value,
              value,
            },
            at,
          );
        } else if (!breached && openId) {
          resolveAlert(tx, db, orgId, { id: openId, type: 'threshold', sensorName: device.name, channelName: channel.name }, at);
          delete openAlerts[rule.id];
        } else if (breached && openId) {
          tx.update(db.doc(paths.alert(orgId, openId)), { lastValue: value });
        }
      }
      if (channel.staleAlertId && channel.staleAlertId !== STALE_COVERED_BY_OFFLINE) {
        resolveAlert(tx, db, orgId, { id: channel.staleAlertId, type: 'stale', sensorName: device.name, channelName: channel.name }, at);
      }
      tx.update(ref, {
        latest: { value, ts: readingAt },
        staleAt: readingAt + channel.staleAfterSec * 1000,
        staleAlertId: null,
        openAlerts,
        updatedAt: at,
      });
    }

    // Back online: close the offline alert and watch the channels parked under it again.
    if (device.offlineAlertId) {
      resolveAlert(tx, db, orgId, { id: device.offlineAlertId, type: 'offline', sensorName: device.name, channelName: null } as Pick<AlertDoc, 'id' | 'type' | 'sensorName' | 'channelName'>, at);
      const touched = new Set(accepted.map((a) => a.key));
      for (const d of parked?.docs ?? []) if (!touched.has(d.id)) tx.update(d.ref, { staleAlertId: null });
    }
    tx.update(deviceRef, {
      lastSeen: at,
      offlineAt: at + device.offlineAfterMin * 60_000,
      offlineAlertId: null,
      rate: { tokens: tokens - 1, at },
      ...(body.fw ? { firmware: body.fw } : {}),
      updatedAt: at,
    });

    const response: IngestResponse = { accepted: accepted.length, rejected, serverTime: at };
    if (accepted.length === 0) {
      return { status: 422, body: { error: 'no_valid_readings', message: 'No reading was accepted; check the channel keys.', ...response } };
    }
    return { status: 200, body: response };
  });
}
