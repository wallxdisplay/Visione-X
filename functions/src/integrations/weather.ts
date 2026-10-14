/**
 * Weather providers, in order of preference:
 *  1. Google Maps Platform (secret GOOGLE_MAPS_API_KEY): Weather API (current conditions +
 *     daily forecast) and Geocoding API. Google's terms require the attribution "Google Maps"
 *     next to the data, so WeatherData.attribution is set and every renderer shows it.
 *  2. Open-Meteo commercial (secret OPEN_METEO_API_KEY, customer-api.open-meteo.com).
 *  3. Open-Meteo free API (non-commercial licence): local development and emulators only.
 * In production without a key, weather requests fail with a clear "not configured" error.
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
    attribution: 'Open-Meteo.com',
  };
}

const googleKey = () => process.env.GOOGLE_MAPS_API_KEY?.trim() || null;

/**
 * Google weather condition types → the WMO codes our renderers already understand (web and
 * player). Unknown or future types fall back by keyword, then to "cloudy" (Google may add types).
 */
const GOOGLE_TO_WMO: Record<string, number> = {
  CLEAR: 0,
  MOSTLY_CLEAR: 1,
  PARTLY_CLOUDY: 2,
  MOSTLY_CLOUDY: 3,
  CLOUDY: 3,
  WINDY: 3,
  LIGHT_RAIN: 61,
  LIGHT_TO_MODERATE_RAIN: 61,
  RAIN: 63,
  MODERATE_TO_HEAVY_RAIN: 65,
  HEAVY_RAIN: 65,
  RAIN_PERIODICALLY_HEAVY: 65,
  WIND_AND_RAIN: 63,
  LIGHT_RAIN_SHOWERS: 80,
  CHANCE_OF_SHOWERS: 80,
  SCATTERED_SHOWERS: 80,
  RAIN_SHOWERS: 81,
  HEAVY_RAIN_SHOWERS: 82,
  RAIN_AND_SNOW: 68,
  HAIL: 96,
  HAIL_SHOWERS: 96,
  THUNDERSTORM: 95,
  THUNDERSHOWER: 95,
  LIGHT_THUNDERSTORM_RAIN: 95,
  SCATTERED_THUNDERSTORMS: 95,
  HEAVY_THUNDERSTORM: 99,
};

export function googleConditionToWmo(type: unknown): number {
  const t = typeof type === 'string' ? type : '';
  if (t in GOOGLE_TO_WMO) return GOOGLE_TO_WMO[t]!;
  if (t.includes('THUNDER')) return 95;
  if (t.includes('SNOW')) return t.includes('HEAVY') ? 75 : t.includes('LIGHT') ? 71 : 73;
  if (t.includes('RAIN') || t.includes('SHOWER')) return 63;
  if (t.includes('FOG') || t.includes('HAZE')) return 45;
  return 3;
}

const deg = (v: unknown) => num((v as { degrees?: unknown } | undefined)?.degrees);

/** Google currentConditions + forecast/days responses → WeatherData (throws on an unexpected shape). */
export function normalizeGoogleWeather(current: unknown, days: unknown): WeatherData {
  const c = current as {
    isDaytime?: boolean;
    weatherCondition?: { type?: string };
    temperature?: unknown;
    feelsLikeTemperature?: unknown;
    relativeHumidity?: unknown;
    wind?: { speed?: { value?: unknown; unit?: string } };
    timeZone?: { id?: string };
  };
  const temp = deg(c.temperature);
  if (temp === null || !c.weatherCondition?.type) throw new FetchError('The weather service returned incomplete data.');
  const speed = num(c.wind?.speed?.value);
  const windKmh = speed === null ? null : c.wind?.speed?.unit === 'MILES_PER_HOUR' ? speed * 1.609 : speed;
  const d = (days as { forecastDays?: Array<Record<string, unknown>> } | undefined)?.forecastDays ?? [];
  const daily = d.slice(0, 4).flatMap((day) => {
    const date = day.displayDate as { year?: number; month?: number; day?: number } | undefined;
    const max = deg(day.maxTemperature);
    const min = deg(day.minTemperature);
    const type = (day.daytimeForecast as { weatherCondition?: { type?: string } } | undefined)?.weatherCondition?.type;
    if (!date?.year || !date.month || !date.day || max === null || min === null) return [];
    const iso = `${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
    return [{ date: iso, code: googleConditionToWmo(type), maxC: max, minC: min }];
  });
  return {
    current: {
      tempC: temp,
      feelsLikeC: deg(c.feelsLikeTemperature),
      humidity: num(c.relativeHumidity),
      windKmh,
      code: googleConditionToWmo(c.weatherCondition.type),
      isDay: c.isDaytime !== false,
    },
    daily,
    timezone: c.timeZone?.id ?? 'UTC',
    attribution: 'Google Maps',
  };
}

async function fetchGoogleWeather(deps: Deps, config: WeatherConfig, key: string): Promise<WeatherData> {
  const where = new URLSearchParams({
    key,
    'location.latitude': config.latitude.toFixed(4),
    'location.longitude': config.longitude.toFixed(4),
    unitsSystem: 'METRIC',
  });
  const [current, days] = await Promise.all([
    getJson(deps, `https://weather.googleapis.com/v1/currentConditions:lookup?${where}`),
    getJson(deps, `https://weather.googleapis.com/v1/forecast/days:lookup?${where}&days=4&pageSize=4`),
  ]);
  return normalizeGoogleWeather(current, days);
}

async function googleGeocode(deps: Deps, query: string, key: string): Promise<GeocodeResult[]> {
  const params = new URLSearchParams({ address: query, key, region: 'in', language: 'en' });
  const json = (await getJson(deps, `https://maps.googleapis.com/maps/api/geocode/json?${params}`)) as {
    status?: string;
    results?: Array<{ address_components?: Array<{ long_name: string; types: string[] }>; geometry?: { location?: { lat?: number; lng?: number } } }>;
  };
  if (json.status && json.status !== 'OK' && json.status !== 'ZERO_RESULTS') throw new FetchError(`Place search failed (${json.status}).`);
  return (json.results ?? []).slice(0, 6).flatMap((r) => {
    const part = (type: string) => r.address_components?.find((a) => a.types.includes(type))?.long_name ?? null;
    const lat = num(r.geometry?.location?.lat);
    const lon = num(r.geometry?.location?.lng);
    const name = part('locality') ?? part('administrative_area_level_2') ?? part('administrative_area_level_1');
    return name && lat !== null && lon !== null ? [{ name, admin1: part('administrative_area_level_1'), country: part('country'), latitude: lat, longitude: lon }] : [];
  });
}

export async function fetchWeather(deps: Deps, config: WeatherConfig): Promise<WeatherData> {
  const google = googleKey();
  if (google) return fetchGoogleWeather(deps, config, google);
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

/** Credit for the active weather / place-search provider (shown next to its data). */
export const weatherAttribution = () => (googleKey() ? 'Google Maps' : 'Open-Meteo.com');

export async function geocode(deps: Deps, query: string): Promise<GeocodeResult[]> {
  const google = googleKey();
  if (google) return googleGeocode(deps, query, google);
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
