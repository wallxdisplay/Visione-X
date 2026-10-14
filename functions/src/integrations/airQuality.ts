/**
 * Air quality from the Google Air Quality API (currentConditions:lookup), with the same key and
 * secret as Google weather (GOOGLE_MAPS_API_KEY; enable "Air Quality API" on that key). We ask
 * for the local index (LOCAL_AQI: India's NAQI by CPCB, "ind_cpcb") and fall back to Google's
 * Universal AQI where there is none. Google's terms require the attribution "Google Maps" next
 * to the data, so AirQualityData.attribution is set and every renderer shows it.
 * There is no free fallback: without the key, requests fail with a clear "not configured" error.
 */
import type { AirQualityConfig, AirQualityData } from '@wallx-play/shared';
import type { Deps } from '../lib/context';
import { FetchError } from './net';
import { ProviderNotConfigured } from './weather';

const ENDPOINT = 'https://airquality.googleapis.com/v1/currentConditions:lookup';

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Google pollutant codes → display names (others, e.g. future ones, are shown upper-cased). */
const POLLUTANTS: Record<string, string> = {
  pm25: 'PM2.5',
  pm10: 'PM10',
  o3: 'O₃',
  no2: 'NO₂',
  so2: 'SO₂',
  co: 'CO',
  nh3: 'NH₃',
  nox: 'NOx',
  nmhc: 'NMHC',
  trs: 'TRS',
  c6h6: 'C₆H₆',
};

export function pollutantLabel(code: unknown): string | null {
  const c = str(code)?.toLowerCase();
  return c ? (POLLUTANTS[c] ?? c.toUpperCase()) : null;
}

/** google.type.Color (channels 0..1, missing = 0) → #RRGGBB. */
export function googleColor(color: unknown): string | null {
  if (!color || typeof color !== 'object') return null;
  const c = color as Record<string, unknown>;
  const hex = (v: unknown) =>
    Math.round(Math.min(1, Math.max(0, num(v) ?? 0)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${hex(c.red)}${hex(c.green)}${hex(c.blue)}`.toUpperCase();
}

/** currentConditions:lookup response → AirQualityData (throws on an unexpected shape). */
export function normalizeAirQuality(json: unknown): AirQualityData {
  const j = json as { dateTime?: unknown; regionCode?: unknown; indexes?: Array<Record<string, unknown>> };
  const indexes = (Array.isArray(j.indexes) ? j.indexes : []).filter((i) => i && typeof i === 'object' && str(i.code) && num(i.aqi) !== null);
  // The local index (e.g. ind_cpcb) when Google has one for the place, else the Universal AQI.
  const index = indexes.find((i) => i.code !== 'uaqi') ?? indexes.find((i) => i.code === 'uaqi');
  if (!index) throw new FetchError('The air quality service returned incomplete data.');
  const aqi = num(index.aqi)!;
  return {
    index: {
      code: str(index.code)!,
      name: str(index.displayName) ?? str(index.code)!,
      aqi,
      display: str(index.aqiDisplay) ?? String(aqi),
      category: str(index.category) ?? '',
      color: googleColor(index.color),
      dominantPollutant: pollutantLabel(index.dominantPollutant),
    },
    regionCode: str(j.regionCode),
    measuredAt: str(j.dateTime),
    attribution: 'Google Maps',
  };
}

export async function fetchAirQuality(deps: Deps, config: AirQualityConfig): Promise<AirQualityData> {
  const key = process.env.GOOGLE_MAPS_API_KEY?.trim();
  if (!key) throw new ProviderNotConfigured('Air quality is not available yet: the air quality provider is not configured for this platform.');
  let res: Response;
  try {
    res = await (deps.fetch ?? fetch)(ENDPOINT, {
      method: 'POST',
      // The key goes in a header, not the URL, so it never appears in request logs.
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        location: { latitude: Number(config.latitude.toFixed(4)), longitude: Number(config.longitude.toFixed(4)) },
        extraComputations: ['LOCAL_AQI'],
        universalAqi: true,
        languageCode: 'en',
      }),
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    throw new FetchError('The air quality service could not be reached.');
  }
  if (!res.ok) throw new FetchError(`The air quality service answered with HTTP ${res.status}.`);
  return normalizeAirQuality(await res.json());
}
