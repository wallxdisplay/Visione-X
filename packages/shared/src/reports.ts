/**
 * Proof-of-play: players count what they show (media items and layouts, anywhere on screen,
 * including inside layout zones) per UTC hour, keep the counts on the box and upload finished
 * hours. The server keeps one summary per screen per local day (orgs/{orgId}/playStats).
 */
import { z } from 'zod';

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const HOUR_MS = 3_600_000;

/** What is counted: a media item (image/video) or a whole layout. */
export const PLAY_KINDS = ['media', 'layout'] as const;
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

/** POST /api/v1/devices/plays. `batchId` makes a retried upload count once. */
export const PlayReportBody = z.object({
  batchId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  buckets: z.array(PlayBucket).min(1).max(2000),
});
export type PlayReportBody = z.infer<typeof PlayReportBody>;

/** Uploads older than this are dropped (a box that was offline for weeks). */
export const PLAY_MAX_AGE_DAYS = 35;

export interface PlayCounts {
  plays: number;
  seconds: number;
}

/** orgs/{orgId}/playStats/{date}_{screenId}: one screen, one day in the org's time zone. */
export interface PlayStatsDoc extends PlayCounts {
  /** YYYY-MM-DD in the organization's time zone. */
  date: string;
  screenId: string;
  siteId: string | null;
  /** Keyed `${kind}_${id}` (e.g. media_abc123). */
  items: Record<string, PlayCounts>;
  /** Keyed by local hour '00'…'23'. */
  hours: Record<string, PlayCounts>;
  updatedAt: number;
  /** Firestore TTL: the plan's retention period after the day. */
  expiresAt: Date;
}

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
