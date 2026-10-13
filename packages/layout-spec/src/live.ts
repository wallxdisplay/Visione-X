/**
 * How sensor widgets present a live value. The Android player mirrors these rules
 * (core/Live.kt); keep both in step.
 */
import type { Threshold } from './schema';

/** One live value as the player receives it from /devices/live. */
export interface LiveValue {
  value: number | null;
  /** Reading time (epoch ms). */
  ts: number | null;
  staleAfterSec: number;
  /** False when the sensor device itself stopped reporting. */
  deviceOnline: boolean;
  /** The channel's unit, e.g. "°C" (shown by table cells). */
  unit?: string;
}

export type LiveState = 'ok' | 'stale' | 'offline' | 'nodata';

/** Device offline beats stale; both still show the last value, dimmed. */
export function liveState(v: LiveValue | null | undefined, now: number, staleOverrideSec?: number): LiveState {
  if (!v || v.value === null || v.ts === null) return 'nodata';
  if (!v.deviceOnline) return 'offline';
  const staleAfter = (staleOverrideSec ?? v.staleAfterSec) * 1000;
  return now - v.ts > staleAfter ? 'stale' : 'ok';
}

export function formatLiveValue(value: number, decimals?: number): string {
  if (decimals !== undefined) return value.toFixed(decimals);
  // Up to one decimal, without a trailing ".0".
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, '');
}

const compare = (op: Threshold['operator'], v: number, limit: number) =>
  op === '>' ? v > limit : op === '>=' ? v >= limit : op === '<' ? v < limit : v <= limit;

/** Colour of the first band the value falls in, or null. */
export function thresholdColor(thresholds: readonly Threshold[], value: number): string | null {
  return thresholds.find((t) => compare(t.operator, value, t.value))?.color ?? null;
}

/**
 * Does a status state match a value? Numbers compare numerically ("2" matches 2);
 * true/on match any non-zero value, false/off match zero.
 */
export function statusMatches(match: string, value: number): boolean {
  const m = match.trim().toLowerCase();
  if (m === 'true' || m === 'on') return value !== 0;
  if (m === 'false' || m === 'off') return value === 0;
  const n = Number(m);
  return m !== '' && !Number.isNaN(n) && n === value;
}

/** Position of a value on a gauge, clamped to 0..1. */
export function gaugeFraction(value: number, min: number, max: number): number {
  if (!(max > min)) return 0;
  return Math.min(1, Math.max(0, (value - min) / (max - min)));
}

export type WeatherCondition = 'clear' | 'partly' | 'cloudy' | 'fog' | 'drizzle' | 'rain' | 'snow' | 'storm';

/** WMO weather code (Open-Meteo `weather_code`) → a small set of conditions with an icon. */
export function weatherCondition(code: number): WeatherCondition {
  if (code === 0) return 'clear';
  if (code <= 2) return 'partly';
  if (code === 3) return 'cloudy';
  if (code === 45 || code === 48) return 'fog';
  if (code >= 51 && code <= 57) return 'drizzle';
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  if (code >= 95) return 'storm';
  return 'cloudy';
}

/** Symbol per condition (night variant for clear / partly cloudy). Same on the player. */
export function weatherIcon(condition: WeatherCondition, isDay = true): string {
  switch (condition) {
    case 'clear':
      return isDay ? '☀️' : '🌙';
    case 'partly':
      return isDay ? '⛅' : '☁️';
    case 'cloudy':
      return '☁️';
    case 'fog':
      return '🌫️';
    case 'drizzle':
      return '🌦️';
    case 'rain':
      return '🌧️';
    case 'snow':
      return '❄️';
    case 'storm':
      return '⛈️';
  }
}
