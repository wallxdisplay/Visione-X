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
