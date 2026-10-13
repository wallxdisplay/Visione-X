/**
 * Sensors (ESP32 and similar): devices, channels, readings and alerts, plus the ingest API.
 * Sensor devices never use Firebase Auth. Each holds an API key (`wxp_…`) issued once; only
 * its SHA-256 is stored (sensorKeys/{hash} → org + device). They call POST /api/v1/ingest
 * with `Authorization: Bearer <key>`.
 */
import { z } from 'zod';

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);

/** Channel keys are what the firmware sends, e.g. "temp", "humidity", "door_1". */
export const ChannelKey = z
  .string()
  .trim()
  .regex(/^[a-z0-9_]{1,32}$/, 'Use 1–32 lowercase letters, digits or _');

export const SENSOR_KEY_PREFIX = 'wxp_';
export const SENSOR_VALUE_TYPES = ['number', 'boolean'] as const;
export type SensorValueType = (typeof SENSOR_VALUE_TYPES)[number];

export const MAX_CHANNELS_PER_DEVICE = 16;
export const DEFAULT_STALE_AFTER_SEC = 10 * 60;
export const DEFAULT_SENSOR_OFFLINE_MIN = 15;
/** Readings timestamped further than this from server time are rejected. */
export const INGEST_MAX_SKEW_MS = 10 * 60_000;
/**
 * Token bucket per sensor device: bursts of up to `capacity` requests, refilled at one every
 * `refillMs`. Sustained rate ≤ 360/hour keeps each hourly readings bucket well under 1 MiB.
 */
export const INGEST_RATE = { capacity: 6, refillMs: 10_000 } as const;
/**
 * Players poll live values this often while sensor widgets are on screen. Chart history is
 * fetched less often; between fetches the player appends live values to its series.
 */
export const LIVE_POLL_SEC = 15;
export const LIVE_HISTORY_POLL_SEC = 300;
/** Points per chart series sent to players (history is averaged down to this). */
export const HISTORY_MAX_POINTS = 120;

// ---------------------------------------------------------------- alert rules

export const ALERT_OPERATORS = ['>', '>=', '<', '<=', '==', '!='] as const;
export type AlertOperator = (typeof ALERT_OPERATORS)[number];
export const ALERT_SEVERITIES = ['warning', 'critical'] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

export const AlertRule = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
  label: z.string().trim().min(1).max(60),
  operator: z.enum(ALERT_OPERATORS),
  value: z.number(),
  severity: z.enum(ALERT_SEVERITIES),
  /** A breached rule recovers only once the value is this far back on the safe side. */
  hysteresis: z.number().min(0).default(0),
});
export type AlertRule = z.infer<typeof AlertRule>;

function holds(op: AlertOperator, v: number, limit: number): boolean {
  switch (op) {
    case '>':
      return v > limit;
    case '>=':
      return v >= limit;
    case '<':
      return v < limit;
    case '<=':
      return v <= limit;
    case '==':
      return v === limit;
    case '!=':
      return v !== limit;
  }
}

/**
 * Is the rule breached by `value`? While already breached, the limit moves by the hysteresis
 * so a value hovering at the limit does not flap between alert and recovery.
 */
export function ruleBreached(rule: Pick<AlertRule, 'operator' | 'value' | 'hysteresis'>, value: number, wasBreached: boolean): boolean {
  if (!wasBreached || rule.hysteresis === 0) return holds(rule.operator, value, rule.value);
  switch (rule.operator) {
    case '>':
    case '>=':
      return holds(rule.operator, value, rule.value - rule.hysteresis);
    case '<':
    case '<=':
      return holds(rule.operator, value, rule.value + rule.hysteresis);
    default:
      return holds(rule.operator, value, rule.value);
  }
}

// ---------------------------------------------------------------- documents

/** orgs/{orgId}/sensorDevices/{id} — readable with sensor.view. */
export interface SensorDeviceDoc {
  id: string;
  name: string;
  siteId: string | null;
  status: 'active' | 'disabled';
  /** First characters of the API key, to tell keys apart (the key itself is never stored). */
  keyPrefix: string;
  keyCreatedAt: number;
  /** No reading for this long → offline alert. */
  offlineAfterMin: number;
  lastSeen: number | null;
  /** lastSeen + offlineAfterMin; the monitor raises an offline alert after it. */
  offlineAt: number | null;
  firmware: string | null;
  /** Open offline alert, cleared by the next accepted request. */
  offlineAlertId: string | null;
  /** Ingest token bucket. */
  rate: { tokens: number; at: number };
  channelCount: number;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

/** sensorKeys/{sha256(key)} — server-only lookup from API key to device. */
export interface SensorKeyDoc {
  orgId: string;
  sensorDeviceId: string;
  createdAt: number;
}

/** orgs/{orgId}/sensorDevices/{deviceId}/channels/{channelKey} */
export interface SensorChannelDoc {
  id: string;
  name: string;
  unit: string;
  valueType: SensorValueType;
  /** Valid range; readings outside it are rejected as faulty. */
  min: number | null;
  max: number | null;
  staleAfterSec: number;
  alertRules: AlertRule[];
  /** Booleans are stored as 1 / 0. */
  latest: { value: number; ts: number } | null;
  /** latest.ts + staleAfterSec; the monitor raises a stale alert after it. */
  staleAt: number | null;
  /** Open stale alert id, or "offline" while the whole device is offline (no separate alert). */
  staleAlertId: string | null;
  /** Open threshold alert id per rule id. */
  openAlerts: Record<string, string>;
  createdAt: number;
  updatedAt: number;
}

/** Sentinel in staleAlertId: the device's offline alert covers this channel. */
export const STALE_COVERED_BY_OFFLINE = 'offline';

/**
 * orgs/{orgId}/sensorDevices/{deviceId}/channels/{channelKey}/readings/{YYYYMMDDHH} (UTC hour).
 * `points` are [{t, v}]; `expiresAt` drives a Firestore TTL policy (org retention).
 */
export interface ReadingBucketDoc {
  hour: number;
  points: Array<{ t: number; v: number }>;
}

export const ALERT_TYPES = ['threshold', 'stale', 'offline'] as const;
export type AlertType = (typeof ALERT_TYPES)[number];

/** orgs/{orgId}/alerts/{id} */
export interface AlertDoc {
  id: string;
  type: AlertType;
  severity: AlertSeverity;
  status: 'open' | 'resolved';
  sensorDeviceId: string;
  /** The device's site, so site-scoped members see only their alerts (absent on older alerts). */
  siteId: string | null;
  sensorName: string;
  channelId: string | null;
  channelName: string | null;
  unit: string | null;
  ruleId: string | null;
  ruleLabel: string | null;
  operator: AlertOperator | null;
  limit: number | null;
  /** Value that opened the alert, and the latest value seen while it was open. */
  value: number | null;
  lastValue: number | null;
  openedAt: number;
  resolvedAt: number | null;
  acknowledgedBy: string | null;
  acknowledgedByEmail: string | null;
  acknowledgedAt: number | null;
}

/** UTC hour bucket id for a reading time. */
export function readingBucketId(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}`;
}

/** Bucket ids covering [from, to], oldest first. */
export function readingBucketIds(from: number, to: number): string[] {
  const out: string[] = [];
  for (let h = Math.floor(from / 3_600_000); h <= Math.floor(to / 3_600_000); h++) out.push(readingBucketId(h * 3_600_000));
  return out;
}

/** Averages points into at most `max` equal time slots (keeps short series as they are). */
export function downsample(points: Array<[number, number]>, max: number): Array<[number, number]> {
  if (points.length <= max) return points;
  const first = points[0]![0];
  const span = points[points.length - 1]![0] - first || 1;
  const slots = new Map<number, { t: number; v: number; n: number }>();
  for (const [t, v] of points) {
    const i = Math.min(max - 1, Math.floor(((t - first) / span) * max));
    const s = slots.get(i) ?? { t: 0, v: 0, n: 0 };
    s.t += t;
    s.v += v;
    s.n += 1;
    slots.set(i, s);
  }
  return [...slots.entries()].sort(([a], [b]) => a - b).map(([, s]) => [Math.round(s.t / s.n), s.v / s.n]);
}

// ---------------------------------------------------------------- callable inputs

export const SaveSensorDeviceInput = z.object({
  orgId: id,
  sensorDeviceId: id.optional(),
  name: z.string().trim().min(1).max(80),
  siteId: id.nullable(),
  offlineAfterMin: z.number().int().min(2).max(24 * 60),
  enabled: z.boolean(),
});
export const SensorDeviceRefInput = z.object({ orgId: id, sensorDeviceId: id });

export const SaveSensorChannelInput = z
  .object({
    orgId: id,
    sensorDeviceId: id,
    channelId: ChannelKey,
    /** true = create (fails if the key exists); false = update. */
    isNew: z.boolean(),
    name: z.string().trim().min(1).max(60),
    unit: z.string().trim().max(16),
    valueType: z.enum(SENSOR_VALUE_TYPES),
    min: z.number().nullable(),
    max: z.number().nullable(),
    staleAfterSec: z.number().int().min(30).max(7 * 86_400),
    alertRules: z.array(AlertRule).max(5),
  })
  .refine((c) => c.min === null || c.max === null || c.max > c.min, {
    message: 'Maximum must be above minimum',
    path: ['max'],
  })
  .refine((c) => new Set(c.alertRules.map((r) => r.id)).size === c.alertRules.length, {
    message: 'Alert rules need unique ids',
    path: ['alertRules'],
  });
export const DeleteSensorChannelInput = z.object({ orgId: id, sensorDeviceId: id, channelId: ChannelKey });
export const AcknowledgeAlertInput = z.object({ orgId: id, alertId: id });

// ---------------------------------------------------------------- ingest API

export const IngestBody = z.object({
  /** Optional; when sent it must match the key's device. */
  deviceId: id.optional(),
  /** Reading time in Unix seconds (milliseconds are accepted too). Omit if the clock is not set. */
  ts: z.number().nonnegative().optional(),
  /** Firmware version string, shown in the web app. */
  fw: z.string().max(40).optional(),
  readings: z
    .array(z.object({ channel: z.string().max(40), value: z.union([z.number(), z.boolean()]) }))
    .min(1)
    .max(MAX_CHANNELS_PER_DEVICE),
});
export type IngestBody = z.infer<typeof IngestBody>;

export type IngestRejectReason = 'unknown_channel' | 'wrong_type' | 'out_of_range' | 'duplicate';

export interface IngestResponse {
  accepted: number;
  rejected: Array<{ channel: string; reason: IngestRejectReason }>;
  serverTime: number;
}

/** Normalizes `ts` (seconds or ms) to epoch ms; null when absent. */
export function ingestTimeMs(ts: number | undefined): number | null {
  if (ts === undefined) return null;
  return ts > 1e12 ? Math.round(ts) : Math.round(ts * 1000);
}

// ---------------------------------------------------------------- player live data

export interface LiveValueDto {
  sourceId: string;
  field: string;
  /** Channel name (chart legends). */
  name: string;
  value: number | null;
  ts: number | null;
  staleAfterSec: number;
  deviceOnline: boolean;
  unit: string;
  valueType: SensorValueType;
}

/** GET /api/v1/devices/live */
export interface DeviceLiveResponse {
  serverTime: number;
  values: LiveValueDto[];
}

/** GET /api/v1/devices/live/history — [epoch ms, value] points, oldest first. */
export interface DeviceHistoryResponse {
  serverTime: number;
  series: Array<{ sourceId: string; field: string; points: Array<[number, number]> }>;
}

/** Is a sensor device reporting? (Offline once silent for offlineAfterMin.) */
export function isSensorOnline(d: Pick<SensorDeviceDoc, 'lastSeen' | 'offlineAfterMin'>, now = Date.now()): boolean {
  return !!d.lastSeen && now - d.lastSeen < d.offlineAfterMin * 60_000;
}
