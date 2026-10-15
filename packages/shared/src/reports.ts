/**
 * Proof-of-play: players count what they show (media items and layouts, anywhere on screen,
 * including inside layout zones) per UTC hour, keep the counts on the box and upload finished
 * hours. The server keeps one summary per screen per local day (orgs/{orgId}/playStats).
 */
import { z } from 'zod';

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const HOUR_MS = 3_600_000;

/** What is counted: a media item (image/video), a whole layout, or taps on a touch page (id = layout). */
export const PLAY_KINDS = ['media', 'layout', 'tap'] as const;
export type PlayKind = (typeof PLAY_KINDS)[number];

/** One content item in one UTC hour on one screen. */
export const PlayBucket = z.object({
  /** Start of the UTC hour (ms). */
  hour: z
    .number()
    .int()
    .min(0)
    .refine((h) => h % HOUR_MS === 0, 'Must be the start of an hour'),
  kind: z.enum(PLAY_KINDS),
  id,
  /** Times the item came on screen in this hour. */
  plays: z.number().int().min(0).max(100_000),
  /** Seconds it was on screen in this hour (several zones can show it at once). */
  seconds: z.number().int().min(0).max(24 * 3600),
});
export type PlayBucket = z.infer<typeof PlayBucket>;

/** Player running ("on") and in contact with WallX Play ("online") in one UTC hour (0.14.0+). */
export const UptimeBucket = z.object({
  hour: PlayBucket.shape.hour,
  on: z.number().int().min(0).max(3600),
  online: z.number().int().min(0).max(3600),
});
export type UptimeBucket = z.infer<typeof UptimeBucket>;

/** POST /api/v1/devices/plays. `batchId` makes a retried upload count once. */
export const PlayReportBody = z
  .object({
    batchId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
    buckets: z.array(PlayBucket).max(2000),
    uptime: z.array(UptimeBucket).max(2000).default([]),
  })
  .refine((b) => b.buckets.length + b.uptime.length > 0, 'Nothing to report');
export type PlayReportBody = z.infer<typeof PlayReportBody>;

/** Uploads older than this are dropped (a box that was offline for weeks). */
export const PLAY_MAX_AGE_DAYS = 35;

export interface PlayCounts {
  plays: number;
  seconds: number;
}

export interface UptimeCounts {
  on: number;
  online: number;
}

/**
 * orgs/{orgId}/playStats/{date}_{screenId}: one screen, one day in the org's time zone. Plays
 * are kept with proof-of-play reports in the plan; uptime, errors and offline counts with
 * screen diagnostics.
 */
export interface PlayStatsDoc extends PlayCounts {
  /** YYYY-MM-DD in the organization's time zone. */
  date: string;
  screenId: string;
  siteId: string | null;
  /** Keyed `${kind}_${id}` (e.g. media_abc123). */
  items: Record<string, PlayCounts>;
  /** Keyed by local hour '00'…'23'. */
  hours: Record<string, PlayCounts>;
  /** Seconds the player ran / was online, per local hour and in total. */
  uptime?: Record<string, UptimeCounts>;
  onSeconds?: number;
  onlineSeconds?: number;
  /** Player errors reported and offline alerts raised this day. */
  errors?: number;
  offline?: number;
  updatedAt: number;
  /** Firestore TTL: the plan's retention period after the day. */
  expiresAt: Date;
}

export const SCREEN_EVENT_TYPES = ['error', 'offline', 'online', 'updated'] as const;
export type ScreenEventType = (typeof SCREEN_EVENT_TYPES)[number];

/** orgs/{orgId}/screens/{screenId}/events/{id}: diagnostics history (screen diagnostics plan feature). */
export interface ScreenEventDoc {
  type: ScreenEventType;
  at: number;
  /** Error text, or "0.13.0 → 0.14.0" for an update. */
  message: string | null;
  /** Firestore TTL. */
  expiresAt: Date;
}

/** Diagnostics history is kept this long. */
export const SCREEN_EVENT_DAYS = 30;

/** Longest report range in days. */
export const PLAY_REPORT_MAX_DAYS = 92;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const PlaybackReportInput = z
  .object({
    orgId: id,
    from: isoDate,
    to: isoDate,
    siteId: id.nullable().default(null),
    screenId: id.nullable().default(null),
  })
  .refine((v) => v.from <= v.to, { message: 'The start date must be before the end date.', path: ['to'] });

export interface PlaybackReport {
  from: string;
  to: string;
  timezone: string;
  totals: PlayCounts & { screens: number; items: number };
  byContent: Array<PlayCounts & { kind: PlayKind; id: string; name: string; screens: number }>;
  byScreen: Array<PlayCounts & { screenId: string; name: string; siteId: string | null }>;
  byDay: Array<PlayCounts & { date: string }>;
  /** Plays per local hour of day (0–23), summed over the range. */
  byHour: number[];
  /** Detail for CSV export: one row per day, screen and content item. */
  rows: Array<PlayCounts & { date: string; screenId: string; kind: PlayKind; id: string }>;
  /** True when `rows` was cut at PLAY_REPORT_MAX_ROWS (totals are still complete). */
  rowsTruncated: boolean;
}

export const PLAY_REPORT_MAX_ROWS = 50_000;

/** `${kind}_${id}` → parts (ids never contain the first underscore's prefix). */
export function parsePlayKey(key: string): { kind: PlayKind; id: string } | null {
  const i = key.indexOf('_');
  const kind = key.slice(0, i) as PlayKind;
  return i > 0 && (PLAY_KINDS as readonly string[]).includes(kind) ? { kind, id: key.slice(i + 1) } : null;
}

export const ScreenAnalyticsInput = z
  .object({
    orgId: id,
    from: isoDate,
    to: isoDate,
    siteId: id.nullable().default(null),
    screenId: id.nullable().default(null),
  })
  .refine((v) => v.from <= v.to, { message: 'The start date must be before the end date.', path: ['to'] });

export interface ScreenAnalyticsRow {
  /** Share (0–1) of the expected time the player was running / online; null without data. */
  onShare: number | null;
  onlineShare: number | null;
  errors: number;
  offline: number;
  plays: number;
}

export interface ScreenAnalytics {
  from: string;
  to: string;
  timezone: string;
  totals: ScreenAnalyticsRow & { screens: number; screensWithData: number };
  byDay: Array<ScreenAnalyticsRow & { date: string }>;
  byScreen: Array<
    ScreenAnalyticsRow & {
      screenId: string;
      name: string;
      siteId: string | null;
      status: string;
      lastSeen: number | null;
      appVersion: string | null;
    }
  >;
}
