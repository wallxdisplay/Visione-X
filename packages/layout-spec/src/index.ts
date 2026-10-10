/**
 * Layout & manifest contract shared by the Studio preview (React) and the Android player
 * (Kotlin). Any change here is a protocol change: bump SPEC_VERSION and keep the player able
 * to read the previous version until all devices have updated.
 */
import { z } from 'zod';

export const SPEC_VERSION = 1;

/** Zone geometry is in fractions of the canvas (0..1) so layouts survive resolution changes. */
const Fraction = z.number().min(0).max(1);

export const Canvas = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  orientation: z.enum(['landscape', 'portrait']),
  background: z.string().default('#000000'),
});

const Style = z
  .object({
    fontFamily: z.string().optional(),
    fontSizePx: z.number().positive().optional(),
    color: z.string().optional(),
    background: z.string().optional(),
    align: z.enum(['start', 'center', 'end']).optional(),
  })
  .default({});

/** Binds a widget field to a live value, e.g. a sensor channel. */
export const DataBinding = z.object({
  source: z.enum(['sensor', 'dataSource']),
  sourceId: z.string(),
  field: z.string(),
  format: z.string().optional(),
  staleAfterSec: z.number().int().positive().optional(),
});

const Threshold = z.object({
  label: z.string(),
  operator: z.enum(['>', '>=', '<', '<=']),
  value: z.number(),
  color: z.string(),
});

export const Widget = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string(), style: Style }),
  z.object({ type: z.literal('clock'), format: z.string(), timezone: z.string(), style: Style }),
  z.object({ type: z.literal('qr'), value: z.string(), foreground: z.string().optional() }),
  z.object({
    type: z.literal('table'),
    columns: z.array(z.string()),
    rows: z.array(z.array(z.union([z.string(), DataBinding]))),
    style: Style,
  }),
  z.object({ type: z.literal('web'), url: z.string().url(), refreshSec: z.number().int().optional() }),
  z.object({ type: z.literal('weather'), dataSourceId: z.string(), style: Style }),
  z.object({ type: z.literal('rss'), dataSourceId: z.string(), itemDurationSec: z.number().int(), style: Style }),
  z.object({
    type: z.literal('sensorValue'),
    binding: DataBinding,
    unit: z.string(),
    thresholds: z.array(Threshold).default([]),
    style: Style,
  }),
  z.object({
    type: z.literal('gauge'),
    binding: DataBinding,
    unit: z.string(),
    min: z.number(),
    max: z.number(),
    thresholds: z.array(Threshold).default([]),
  }),
  z.object({
    type: z.literal('chart'),
    bindings: z.array(DataBinding).min(1),
    kind: z.enum(['line', 'bar']),
    windowMinutes: z.number().int().positive(),
  }),
  z.object({
    type: z.literal('status'),
    binding: DataBinding,
    states: z.array(z.object({ match: z.string(), label: z.string(), color: z.string() })),
  }),
]);
export type Widget = z.infer<typeof Widget>;

export const ZoneContent = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('playlist'), playlistId: z.string() }),
  z.object({ kind: z.literal('media'), mediaId: z.string(), fit: z.enum(['contain', 'cover', 'fill']) }),
  z.object({ kind: z.literal('widget'), widget: Widget }),
]);

export const Zone = z.object({
  id: z.string(),
  name: z.string(),
  x: Fraction,
  y: Fraction,
  w: Fraction,
  h: Fraction,
  z: z.number().int(),
  content: ZoneContent,
});

export const Layout = z
  .object({
    specVersion: z.literal(SPEC_VERSION),
    id: z.string(),
    name: z.string(),
    canvas: Canvas,
    zones: z.array(Zone),
  })
  .superRefine((layout, ctx) => {
    layout.zones.forEach((zone, i) => {
      if (zone.x + zone.w > 1.0001 || zone.y + zone.h > 1.0001) {
        ctx.addIssue({ code: 'custom', path: ['zones', i], message: 'Zone exceeds canvas' });
      }
    });
  });
export type Layout = z.infer<typeof Layout>;

export const PlaylistItem = z.object({
  id: z.string(),
  content: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('media'), mediaId: z.string() }),
    z.object({ kind: z.literal('layout'), layoutId: z.string() }),
    z.object({ kind: z.literal('widget'), widget: Widget }),
  ]),
  /** Ignored for video, which plays its own length unless trimmed. */
  durationSec: z.number().int().positive(),
  transition: z.enum(['none', 'fade', 'slide']).default('none'),
});

/** Asset the device must have locally before switching to a manifest version. */
export const ManifestAsset = z.object({
  mediaId: z.string(),
  url: z.string().url(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().positive(),
  mimeType: z.string(),
});

export const ScheduleRule = z.object({
  id: z.string(),
  /** Higher wins. Emergency content is not a schedule; it is a separate override. */
  priority: z.number().int().min(0).max(100),
  timezone: z.string(),
  startAt: z.number().int().nullable(),
  endAt: z.number().int().nullable(),
  daysOfWeek: z.array(z.number().int().min(0).max(6)),
  /** "HH:mm" local to timezone; null = all day. */
  windowStart: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
  windowEnd: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
  playlistId: z.string(),
});

export const Manifest = z.object({
  specVersion: z.literal(SPEC_VERSION),
  orgId: z.string(),
  screenId: z.string(),
  version: z.number().int().positive(),
  generatedAt: z.number().int(),
  layouts: z.array(Layout),
  playlists: z.array(z.object({ id: z.string(), items: z.array(PlaylistItem) })),
  schedules: z.array(ScheduleRule),
  defaultPlaylistId: z.string().nullable(),
  fallbackMediaId: z.string().nullable(),
  emergency: z
    .object({ id: z.string(), playlistId: z.string(), expiresAt: z.number().int().nullable() })
    .nullable(),
  assets: z.array(ManifestAsset),
});
export type Manifest = z.infer<typeof Manifest>;
