/**
 * Integrations (phase 6): external data shown by widgets, fetched and sanitized on the server
 * and cached centrally (providerCache), never fetched by screens or browsers directly.
 *   weather — Open-Meteo (commercial API key required in production; see docs)
 *   rss     — RSS 2.0 / RSS 1.0 / Atom feeds, headlines only, as plain text
 *   air_quality — Google Air Quality API (India's NAQI where Google has it, else Universal AQI)
 */
import { z } from 'zod';

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);

export const DATA_SOURCE_TYPES = ['weather', 'rss', 'air_quality'] as const;
export type DataSourceType = (typeof DATA_SOURCE_TYPES)[number];

/** Provider results are reused this long before fetching again. */
export const WEATHER_TTL_MS = 15 * 60_000;
export const RSS_TTL_MS = 10 * 60_000;
/** Google updates air quality hourly. */
export const AIR_QUALITY_TTL_MS = 30 * 60_000;
/** On provider errors, the last good result is served for up to this long (marked stale). */
export const STALE_SERVE_MS = 24 * 3_600_000;
/** Players refresh data-source values this often while such widgets are on screen. */
export const DATA_POLL_SEC = 300;
export const RSS_MAX_ITEMS = 20;
export const RSS_MAX_BYTES = 1_000_000;

export const WeatherConfig = z.object({
  placeName: z.string().trim().min(1).max(80),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});
export type WeatherConfig = z.infer<typeof WeatherConfig>;

/** A place, like weather (found with geocodePlace). */
export const AirQualityConfig = WeatherConfig;
export type AirQualityConfig = z.infer<typeof AirQualityConfig>;

export const RssConfig = z.object({
  url: z
    .string()
    .trim()
    .url()
    .max(1000)
    .refine((u) => /^https?:\/\//i.test(u), 'Use an http:// or https:// feed address'),
  maxItems: z.number().int().min(1).max(RSS_MAX_ITEMS),
});
export type RssConfig = z.infer<typeof RssConfig>;

/** orgs/{orgId}/dataSources/{id} — readable by members; written by Functions. */
export type DataSourceDoc = {
  id: string;
  name: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  /** Result of the last fetch made for a preview or a screen. */
  lastFetch: { at: number; ok: boolean; error: string | null } | null;
} & ({ type: 'weather'; config: WeatherConfig } | { type: 'rss'; config: RssConfig } | { type: 'air_quality'; config: AirQualityConfig });

// ---------------------------------------------------------------- normalized data

export interface WeatherData {
  current: { tempC: number; feelsLikeC: number | null; humidity: number | null; windKmh: number | null; code: number; isDay: boolean };
  /** Today first. */
  daily: Array<{ date: string; code: number; maxC: number; minC: number }>;
  timezone: string;
  /** Credit the provider requires next to the data ("Google Maps", "Open-Meteo.com"); shown on screens. */
  attribution?: string | null;
}

export interface AirQualityData {
  /** The index shown: the local one where Google has it (India: NAQI by CPCB), else Universal AQI. */
  index: {
    /** Google's index code, e.g. "ind_cpcb", "uaqi". */
    code: string;
    /** e.g. "NAQI (IN)", "Universal AQI". */
    name: string;
    aqi: number;
    /** The score as Google says to display it (may carry a prefix or suffix). */
    display: string;
    /** e.g. "Satisfactory air quality" (English). */
    category: string;
    /** Band colour of the score (#RRGGBB), when given. */
    color: string | null;
    /** Display name of the dominant pollutant, e.g. "PM2.5", when given. */
    dominantPollutant: string | null;
  };
  /** ISO 3166-1 alpha-2 as Google sends it (e.g. "in"), when given. */
  regionCode: string | null;
  /** When the conditions apply (RFC 3339), when given. */
  measuredAt: string | null;
  /** Credit the provider requires next to the data ("Google Maps"); shown on screens. */
  attribution?: string | null;
}

export interface RssItem {
  title: string;
  /** Epoch ms, when the feed gives a parseable date. */
  publishedAt: number | null;
}

export interface RssData {
  feedTitle: string;
  items: RssItem[];
}

/** One data source's current value, as served to players and previews. */
export interface DataSourceValue {
  id: string;
  type: DataSourceType;
  name: string;
  /** False when the provider failed; `data` may then be a stale last good result. */
  ok: boolean;
  error: string | null;
  fetchedAt: number | null;
  weather: WeatherData | null;
  rss: RssData | null;
  airQuality: AirQualityData | null;
}

/** GET /api/v1/devices/data */
export interface DeviceDataResponse {
  serverTime: number;
  sources: DataSourceValue[];
}

// ---------------------------------------------------------------- callable inputs

export const SaveDataSourceInput = z.discriminatedUnion('type', [
  z.object({ orgId: id, dataSourceId: id.optional(), name: z.string().trim().min(1).max(80), type: z.literal('weather'), config: WeatherConfig }),
  z.object({ orgId: id, dataSourceId: id.optional(), name: z.string().trim().min(1).max(80), type: z.literal('rss'), config: RssConfig }),
  z.object({ orgId: id, dataSourceId: id.optional(), name: z.string().trim().min(1).max(80), type: z.literal('air_quality'), config: AirQualityConfig }),
]);
export const DataSourceRefInput = z.object({ orgId: id, dataSourceId: id });
export const GeocodeInput = z.object({ orgId: id, query: z.string().trim().min(2).max(80) });
/** Fetch a feed before saving it (validates the address and shows headlines). */
export const TestRssInput = z.object({ orgId: id, config: RssConfig });

export interface GeocodeResult {
  name: string;
  admin1: string | null;
  country: string | null;
  latitude: number;
  longitude: number;
}
