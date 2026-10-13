/**
 * Weather via Open-Meteo. The free API (api.open-meteo.com) is licensed for non-commercial
 * use only, so it is used only in local development / emulators. In production a commercial
 * API key is required (secret OPEN_METEO_API_KEY → customer-api.open-meteo.com); without it
 * weather requests fail with a clear "not configured" error instead of using the free API.
 */
import type { GeocodeResult, WeatherConfig, WeatherData } from '@wallx-play/shared';
import type { Deps } from '../lib/context';
import { FetchError } from './net';

export class ProviderNotConfigured extends Error {}

/** True when running as a deployed function (Cloud Run), not in the emulator or tests. */
const isProduction = () => !!process.env.K_SERVICE && process.env.FUNCTIONS_EMULATOR !== 'true';

function endpoints(): { forecast: string; geocode: string; key: string | null } {
  const key = process.env.OPEN_METEO_API_KEY?.trim() || null;
  if (key) return { forecast: 'https://customer-api.open-meteo.com/v1/forecast', geocode: 'https://customer-geocoding-api.open-meteo.com/v1/search', key };
  if (isProduction()) {
    throw new ProviderNotConfigured('Weather is not available yet: the weather provider is not configured for this platform.');
  }
  return { forecast: 'https://api.open-meteo.com/v1/forecast', geocode: 'https://geocoding-api.open-meteo.com/v1/search', key: null };
}

async function getJson(deps: Deps, url: string): Promise<unknown> {
  let res: Response;
  try {
    res = await (deps.fetch ?? fetch)(url, { signal: AbortSignal.timeout(8_000) });
  } catch {
    throw new FetchError('The weather service could not be reached.');
  }
  if (!res.ok) throw new FetchError(`The weather service answered with HTTP ${res.status}.`);
  return res.json();
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Open-Meteo forecast response → WeatherData (throws on an unexpected shape). */
export function normalizeWeather(json: unknown): WeatherData {
  const j = json as {
    timezone?: string;
    current?: Record<string, unknown>;
    daily?: { time?: string[]; weather_code?: number[]; temperature_2m_max?: number[]; temperature_2m_min?: number[] };
  };
  const c = j.current ?? {};
  const temp = num(c.temperature_2m);
  const code = num(c.weather_code);
  if (temp === null || code === null) throw new FetchError('The weather service returned incomplete data.');
  const d = j.daily ?? {};
  const daily = (d.time ?? []).slice(0, 4).flatMap((date, i) => {
    const max = num(d.temperature_2m_max?.[i]);
    const min = num(d.temperature_2m_min?.[i]);
    const dc = num(d.weather_code?.[i]);
    return max === null || min === null || dc === null ? [] : [{ date, code: dc, maxC: max, minC: min }];
  });
  return {
    current: {
      tempC: temp,
      feelsLikeC: num(c.apparent_temperature),
      humidity: num(c.relative_humidity_2m),
      windKmh: num(c.wind_speed_10m),
      code,
      isDay: c.is_day === 1 || c.is_day === true,
    },
    daily,
    timezone: typeof j.timezone === 'string' ? j.timezone : 'UTC',
  };
}

export async function fetchWeather(deps: Deps, config: WeatherConfig): Promise<WeatherData> {
  const e = endpoints();
  const params = new URLSearchParams({
    latitude: config.latitude.toFixed(4),
    longitude: config.longitude.toFixed(4),
    current: 'temperature_2m,relative_humidity_2m,apparent_temperature,is_day,weather_code,wind_speed_10m',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min',
    timezone: 'auto',
    forecast_days: '4',
  });
  if (e.key) params.set('apikey', e.key);
  return normalizeWeather(await getJson(deps, `${e.forecast}?${params}`));
}

export async function geocode(deps: Deps, query: string): Promise<GeocodeResult[]> {
  const e = endpoints();
  const params = new URLSearchParams({ name: query, count: '6', language: 'en', format: 'json' });
  if (e.key) params.set('apikey', e.key);
  const json = (await getJson(deps, `${e.geocode}?${params}`)) as { results?: Array<Record<string, unknown>> };
  return (json.results ?? []).flatMap((r) => {
    const lat = num(r.latitude);
    const lon = num(r.longitude);
    return typeof r.name === 'string' && lat !== null && lon !== null
      ? [{ name: r.name, admin1: typeof r.admin1 === 'string' ? r.admin1 : null, country: typeof r.country === 'string' ? r.country : null, latitude: lat, longitude: lon }]
      : [];
  });
}
