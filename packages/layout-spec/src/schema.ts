/**
 * Layout & manifest contract shared by the Studio preview (React) and the Android player
 * (Kotlin). Any change here is a protocol change: bump SPEC_VERSION and keep the player able
 * to read the previous version until all devices have updated.
 */
import { z } from 'zod';

export const SPEC_VERSION = 1;

/** Zone geometry is in fractions of the canvas (0..1) so layouts survive resolution changes. */
const Fraction = z.number().min(0).max(1);
const Size = z.number().min(0.02).max(1);
const Color = z.string().regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/, 'Use a hex colour like #112233');

export const Orientation = z.enum(['landscape', 'portrait']);
export type Orientation = z.infer<typeof Orientation>;

export const Canvas = z.object({
  width: z.number().int().min(320).max(7680),
  height: z.number().int().min(320).max(7680),
  orientation: Orientation,
  background: Color.default('#000000'),
});
export type Canvas = z.infer<typeof Canvas>;

export const TextStyle = z
  .object({
    fontFamily: z.string().max(80).optional(),
    /** Font size as a fraction of the zone height, so text scales with any resolution. */
    fontScale: z.number().min(0.02).max(1).optional(),
    bold: z.boolean().optional(),
    color: Color.optional(),
    background: Color.optional(),
    align: z.enum(['start', 'center', 'end']).optional(),
  })
  .default({});
export type TextStyle = z.infer<typeof TextStyle>;

const BindingId = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);

/**
 * Binds a widget to a live value. For `sensor`, `sourceId` is the sensor device and `field`
 * the channel key. Values are not in the manifest: players fetch them from /devices/live.
 */
export const DataBinding = z.object({
  source: z.enum(['sensor', 'dataSource']),
  sourceId: BindingId,
  field: BindingId,
  /** Digits after the decimal point; absent = up to 1. */
  decimals: z.number().int().min(0).max(4).optional(),
  /** Overrides the channel's own stale-after time. */
  staleAfterSec: z.number().int().positive().optional(),
});
export type DataBinding = z.infer<typeof DataBinding>;

/** Display colour bands (alert rules are separate: they live on the sensor channel). */
export const Threshold = z.object({
  label: z.string().max(40).default(''),
  operator: z.enum(['>', '>=', '<', '<=']),
  value: z.number(),
  color: Color,
});
export type Threshold = z.infer<typeof Threshold>;

/** Longest history a chart widget can show. */
export const MAX_CHART_WINDOW_MINUTES = 24 * 60;

const HttpsUrl = z
  .string()
  .url()
  .refine((u) => u.startsWith('https://'), 'Only https:// addresses are allowed');

export const Widget = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().max(2000), style: TextStyle }),
  z.object({
    type: z.literal('clock'),
    /** 'time' | 'date' | 'datetime'; rendered with the screen's locale. */
    format: z.enum(['time', 'date', 'datetime']),
    timezone: z.string(),
    seconds: z.boolean().default(false),
    style: TextStyle,
  }),
  z.object({
    type: z.literal('qr'),
    value: z.string().min(1).max(1000),
    foreground: Color.default('#000000'),
    background: Color.default('#FFFFFF'),
  }),
  z.object({
    type: z.literal('table'),
    columns: z.array(z.string().max(80)).min(1).max(10),
    /**
     * Rows of cells: text or a live value. Each row is an object because Firestore cannot
     * store an array directly inside an array.
     */
    rows: z.array(z.object({ cells: z.array(z.union([z.string().max(200), DataBinding])).max(10) })).max(50),
    style: TextStyle,
  }),
  z.object({ type: z.literal('web'), url: HttpsUrl, refreshSec: z.number().int().min(30).optional() }),
  z.object({
    type: z.literal('weather'),
    dataSourceId: BindingId,
    /** Current conditions only, or with a 3-day forecast. */
    layout: z.enum(['current', 'forecast']).default('current'),
    style: TextStyle,
  }),
  z.object({
    type: z.literal('rss'),
    dataSourceId: BindingId,
    /** Seconds each headline stays on screen. */
    itemDurationSec: z.number().int().min(3).max(120).default(8),
    showFeedTitle: z.boolean().default(true),
    style: TextStyle,
  }),
  z.object({
    type: z.literal('aqi'),
    /** An `air_quality` data source. */
    dataSourceId: BindingId,
    /** Score and category, or also the dominant pollutant and the index name. */
    layout: z.enum(['compact', 'detailed']).default('compact'),
    style: TextStyle,
  }),
  z.object({
    type: z.literal('sensorValue'),
    binding: DataBinding,
    /** Caption above the value, e.g. "Cold room". */
    label: z.string().max(60).default(''),
    unit: z.string().max(16),
    thresholds: z.array(Threshold).max(5).default([]),
    style: TextStyle,
  }),
  z.object({
    type: z.literal('gauge'),
    binding: DataBinding,
    label: z.string().max(60).default(''),
    unit: z.string().max(16),
    min: z.number(),
    max: z.number(),
    thresholds: z.array(Threshold).max(5).default([]),
    style: TextStyle,
  }),
  z.object({
    type: z.literal('chart'),
    bindings: z.array(DataBinding).min(1).max(3),
    label: z.string().max(60).default(''),
    kind: z.enum(['line', 'bar']),
    windowMinutes: z.number().int().min(5).max(MAX_CHART_WINDOW_MINUTES),
    style: TextStyle,
  }),
  z.object({
    type: z.literal('status'),
    binding: DataBinding,
    label: z.string().max(60).default(''),
    /** First matching state wins; `match` is a number ("2") or true / false / on / off. */
    states: z
      .array(z.object({ match: z.string().trim().min(1).max(20), label: z.string().max(40), color: Color }))
      .min(1)
      .max(8),
    style: TextStyle,
  }),
]).superRefine((w, ctx) => {
  if (w.type === 'gauge' && !(w.max > w.min)) {
    ctx.addIssue({ code: 'custom', path: ['max'], message: 'Maximum must be above minimum' });
  }
});
export type Widget = z.infer<typeof Widget>;
export type WidgetType = Widget['type'];

/** Widgets usable today. Others are part of the contract but ship in later phases. */
export const AVAILABLE_WIDGETS = [
  'text',
  'clock',
  'qr',
  'table',
  'web',
  'weather',
  'rss',
  'aqi',
  'sensorValue',
  'gauge',
  'chart',
  'status',
] as const satisfies readonly WidgetType[];

/** Widgets that show data-source content (weather, RSS, air quality), fetched by the server. */
export const DATA_WIDGETS = ['weather', 'rss', 'aqi'] as const satisfies readonly WidgetType[];
export type DataWidget = (typeof DATA_WIDGETS)[number];

/** Data source type each data widget shows. */
export const DATA_WIDGET_SOURCE = { weather: 'weather', rss: 'rss', aqi: 'air_quality' } as const satisfies Record<DataWidget, string>;

/** Widgets that show live sensor values (need the sensor feature in the plan). */
export const SENSOR_WIDGETS = ['sensorValue', 'gauge', 'chart', 'status'] as const satisfies readonly WidgetType[];

export const ZoneContent = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('empty') }),
  z.object({ kind: z.literal('playlist'), playlistId: z.string() }),
  z.object({ kind: z.literal('media'), mediaId: z.string(), fit: z.enum(['contain', 'cover', 'fill']) }),
  z.object({ kind: z.literal('widget'), widget: Widget }),
]);
export type ZoneContent = z.infer<typeof ZoneContent>;

export const Zone = z.object({
  id: z.string().min(1).max(40),
  name: z.string().max(60),
  x: Fraction,
  y: Fraction,
  w: Size,
  h: Size,
  z: z.number().int().min(0).max(100),
  content: ZoneContent,
});
export type Zone = z.infer<typeof Zone>;

const zonesWithinCanvas = (
  layout: { zones: Array<{ id: string; x: number; y: number; w: number; h: number }> },
  ctx: z.RefinementCtx,
) => {
  const ids = new Set<string>();
  layout.zones.forEach((zone, i) => {
    if (zone.x + zone.w > 1.0001 || zone.y + zone.h > 1.0001) {
      ctx.addIssue({ code: 'custom', path: ['zones', i], message: 'Zone exceeds canvas' });
    }
    if (ids.has(zone.id)) ctx.addIssue({ code: 'custom', path: ['zones', i, 'id'], message: 'Duplicate zone id' });
    ids.add(zone.id);
  });
};

/** What an editor saves: everything except identity/version, which the server owns. */
export const LayoutBody = z
  .object({
    name: z.string().trim().min(1).max(80),
    canvas: Canvas,
    zones: z.array(Zone).max(16),
  })
  .superRefine(zonesWithinCanvas);
export type LayoutBody = z.infer<typeof LayoutBody>;

export const Layout = z
  .object({
    specVersion: z.literal(SPEC_VERSION),
    id: z.string(),
    name: z.string(),
    canvas: Canvas,
    zones: z.array(Zone),
  })
  .superRefine(zonesWithinCanvas);
export type Layout = z.infer<typeof Layout>;

export const PlaylistItemContent = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('media'), mediaId: z.string() }),
  z.object({ kind: z.literal('layout'), layoutId: z.string() }),
  z.object({ kind: z.literal('widget'), widget: Widget }),
]);
export type PlaylistItemContent = z.infer<typeof PlaylistItemContent>;

export const PlaylistItem = z.object({
  id: z.string().min(1).max(40),
  content: PlaylistItemContent,
  /** For video this is filled from the file's length; it can be shortened to trim. */
  durationSec: z.number().int().min(1).max(86_400),
  transition: z.enum(['none', 'fade', 'slide']).default('none'),
});
export type PlaylistItem = z.infer<typeof PlaylistItem>;

/** Asset the device must have locally before switching to a manifest version. */
export const ManifestAsset = z.object({
  mediaId: z.string(),
  url: z.string().url(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().positive(),
  mimeType: z.string(),
});

const LocalDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const LocalTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:mm');

/**
 * When a playlist plays. Dates and times are local to `timezone`, so "09:00–18:00" means the
 * same wall-clock hours on every screen regardless of where the server is.
 * A window whose end is not after its start spans midnight (22:00–06:00); `daysOfWeek` then
 * refers to the day the window starts.
 */
export const ScheduleRule = z.object({
  id: z.string(),
  /** Higher wins. Emergency content is not a schedule; it is a separate override. */
  priority: z.number().int().min(0).max(100),
  timezone: z.string(),
  startDate: LocalDate.nullable(),
  endDate: LocalDate.nullable(),
  /** 0 = Sunday … 6 = Saturday. Empty means every day. */
  daysOfWeek: z.array(z.number().int().min(0).max(6)).max(7),
  windowStart: LocalTime.nullable(),
  windowEnd: LocalTime.nullable(),
  playlistId: z.string(),
});
export type ScheduleRule = z.infer<typeof ScheduleRule>;

/** A bound sensor channel; `historyMinutes` is set when a chart needs past readings. */
export const LiveChannel = z.object({
  sourceId: z.string(),
  field: z.string(),
  historyMinutes: z.number().int().positive().nullable(),
});
export type LiveChannel = z.infer<typeof LiveChannel>;

/** A data source (weather, RSS, air quality) the content shows; values come from /devices/data. */
export const ManifestDataSource = z.object({ id: z.string(), type: z.enum(['weather', 'rss', 'air_quality']) });
export type ManifestDataSource = z.infer<typeof ManifestDataSource>;

/**
 * Multi-screen sync: players in a group derive what to show from a shared timeline (the group's
 * anchor time and the playlist's durations), so they change items at the same instant. In a video
 * wall each screen shows its tile of one large canvas (cols × rows screens).
 */
export const ManifestSync = z.object({
  groupId: z.string(),
  mode: z.enum(['mirror', 'wall']),
  /** Server time (ms) when the timeline starts; every player counts from it. */
  anchor: z.number().int(),
  /** Video wall position; null in mirror mode. */
  tile: z.object({ rows: z.number().int().min(1).max(8), cols: z.number().int().min(1).max(8), row: z.number().int().min(0), col: z.number().int().min(0) }).nullable(),
});
export type ManifestSync = z.infer<typeof ManifestSync>;

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
  /** Live values the player polls from /devices/live (empty when nothing is bound). */
  liveChannels: z.array(LiveChannel).default([]),
  /** Data sources the player fetches from /devices/data (empty when none are used). */
  dataSources: z.array(ManifestDataSource).default([]),
  /** Clockwise degrees the player rotates its whole output (portrait walls on landscape HDMI). */
  rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).default(0),
  /** Set when the screen plays in a sync group (players before 0.16.0 ignore it). */
  sync: ManifestSync.nullable().default(null),
});
export type Manifest = z.infer<typeof Manifest>;
