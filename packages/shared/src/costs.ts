/**
 * Cost tracking (App store phase 6): what each organization costs WallX to run, next to what it
 * pays. Usage is counted inside writes that happen anyway (no extra writes on hot paths):
 *
 * - screens: heartbeats (each stands for 5 minutes of check-ins, data refreshes and the heartbeat
 *   itself) and media bytes newly delivered by a publish — `usage.<day>` on the screen doc;
 * - data sources: Google Weather / Air Quality calls — `usage.<day>` on the data source doc;
 * - sensor devices: ingest requests and readings — `usage.<day>` on the sensor device doc;
 * - API calls (apiUsage), notification emails (mailLog) and stored bytes (usage/current) as before.
 *
 * A daily job rolls the previous days up into orgs/{orgId}/costUsage/{YYYY-MM-DD} (staff only).
 * Unit costs are entered by staff (platform/costRates, prefilled from the phase 0 price sheet);
 * the profitability report multiplies them out per organization and per app.
 */
import { z } from 'zod';

/** Usage counters kept on a doc for the last few days, keyed by `usageKey`. */
export interface UsageDay {
  beats?: number;
  deliveredBytes?: number;
  calls?: number;
  requests?: number;
  readings?: number;
}
export type UsageCounters = Record<string, UsageDay>;

/** Days of counters kept on a doc; the daily rollup reads the previous ones. */
export const USAGE_KEEP_DAYS = 7;

/** Counter key for a UTC day: "d20261019" (a plain field name, safe in update paths). */
export const usageKey = (at: number) => `d${new Date(at).toISOString().slice(0, 10).replace(/-/g, '')}`;
/** Rollup doc id for a UTC day: "2026-10-19". */
export const usageDayId = (at: number) => new Date(at).toISOString().slice(0, 10);
export const keyOfDayId = (dayId: string) => `d${dayId.replace(/-/g, '')}`;

/** Keys older than the days kept (to delete in the same write that adds today's counts). */
export function staleUsageKeys(usage: UsageCounters | undefined, at: number): string[] {
  const oldest = usageKey(at - USAGE_KEEP_DAYS * 86_400_000);
  return Object.keys(usage ?? {}).filter((k) => k < oldest);
}

/** orgs/{orgId}/costUsage/{YYYY-MM-DD} — one organization's usage on one UTC day. */
export interface CostUsageDoc {
  day: string;
  orgId: string;
  screens: number;
  heartbeats: number;
  deliveredBytes: number;
  storageBytes: number;
  weatherCalls: number;
  airQualityCalls: number;
  sensorRequests: number;
  sensorReadings: number;
  apiCalls: number;
  emails: number;
  computedAt: number;
}

export const COST_DRIVERS = ['heartbeats', 'delivered', 'storage', 'weather', 'airQuality', 'sensors', 'api', 'emails', 'fixed'] as const;
export type CostDriver = (typeof COST_DRIVERS)[number];

/** platform/costRates — unit costs in paise (staff). */
export interface CostRatesDoc {
  /** Per 1,000 heartbeats (≈ 83 screen-hours of check-ins and data refreshes). */
  per1000Heartbeats: number;
  perGbDelivered: number;
  perGbMonthStored: number;
  per1000WeatherCalls: number;
  per1000AirQualityCalls: number;
  per1000SensorRequests: number;
  per1000ApiCalls: number;
  per1000Emails: number;
  /** Fixed cost per organization per month (support, overheads). */
  perOrgMonth: number;
  updatedAt?: number;
  updatedBy?: string;
}

/**
 * Starting values from the phase 0 sheet (₹88 per $, list prices without Google's free tiers):
 * a heartbeat stands for 12 function requests, 55 reads and 2 writes (≈ $0.0000351); Weather
 * $0.06 and Air Quality $0.50 per 1,000 calls; egress $0.12/GB; Cloud Storage $0.023/GB-month;
 * a sensor request ≈ 1 request, 4 reads, 7 writes; an API call ≈ 1 request, 3 reads, 1 write.
 */
export const DEFAULT_COST_RATES: CostRatesDoc = {
  per1000Heartbeats: 309,
  perGbDelivered: 1056,
  perGbMonthStored: 202,
  per1000WeatherCalls: 528,
  per1000AirQualityCalls: 4400,
  per1000SensorRequests: 89,
  per1000ApiCalls: 29,
  per1000Emails: 0,
  perOrgMonth: 0,
};

const paise = z.number().int().min(0).max(100_000_000);
export const SaveCostRatesInput = z.object({
  per1000Heartbeats: paise,
  perGbDelivered: paise,
  perGbMonthStored: paise,
  per1000WeatherCalls: paise,
  per1000AirQualityCalls: paise,
  per1000SensorRequests: paise,
  per1000ApiCalls: paise,
  per1000Emails: paise,
  perOrgMonth: paise,
});

export const CostReportInput = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM') });

export type UsageTotals = Omit<CostUsageDoc, 'day' | 'orgId' | 'computedAt' | 'screens' | 'storageBytes'> & {
  /** Average screens and stored bytes over the days covered. */
  screens: number;
  storageBytes: number;
};

/** Adds up the days of a month (averages screens and storage). */
export function sumUsage(days: CostUsageDoc[]): UsageTotals {
  const n = days.length || 1;
  const sum = (k: keyof CostUsageDoc) => days.reduce((s, d) => s + (Number(d[k]) || 0), 0);
  return {
    screens: sum('screens') / n,
    storageBytes: sum('storageBytes') / n,
    heartbeats: sum('heartbeats'),
    deliveredBytes: sum('deliveredBytes'),
    weatherCalls: sum('weatherCalls'),
    airQualityCalls: sum('airQualityCalls'),
    sensorRequests: sum('sensorRequests'),
    sensorReadings: sum('sensorReadings'),
    apiCalls: sum('apiCalls'),
    emails: sum('emails'),
  };
}

const GB = 1_000_000_000;

/** Estimated cost per driver in paise for `daysCovered` days of usage in a month of `daysInMonth`. */
export function costBreakdown(u: UsageTotals, rates: CostRatesDoc, daysCovered: number, daysInMonth: number): Record<CostDriver, number> {
  const share = daysInMonth > 0 ? daysCovered / daysInMonth : 0;
  return {
    heartbeats: Math.round((u.heartbeats / 1000) * rates.per1000Heartbeats),
    delivered: Math.round((u.deliveredBytes / GB) * rates.perGbDelivered),
    storage: Math.round((u.storageBytes / GB) * rates.perGbMonthStored * share),
    weather: Math.round((u.weatherCalls / 1000) * rates.per1000WeatherCalls),
    airQuality: Math.round((u.airQualityCalls / 1000) * rates.per1000AirQualityCalls),
    sensors: Math.round((u.sensorRequests / 1000) * rates.per1000SensorRequests),
    api: Math.round((u.apiCalls / 1000) * rates.per1000ApiCalls),
    emails: Math.round((u.emails / 1000) * rates.per1000Emails),
    fixed: Math.round(rates.perOrgMonth * share),
  };
}

/** Which app a cost driver belongs to (for the per-app view); the rest is the base Screen app. */
export const DRIVER_APP: Partial<Record<CostDriver, string>> = { weather: 'weather', airQuality: 'weather', sensors: 'sensors', api: 'api' };

export interface CostReportRow {
  orgId: string;
  name: string;
  pricing: 'plan' | 'apps';
  status: string;
  /** Billed through a reseller: revenue is at the dealer price (approximate). */
  viaReseller: boolean;
  /** Monthly revenue before GST, in paise (0 in a trial). */
  revenueMinor: number;
  /** Monthly revenue per app (app pricing; plan pricing: all on "plan"). */
  revenueByApp: Record<string, number>;
  usage: UsageTotals;
  cost: Record<CostDriver, number>;
  costMinor: number;
  /** Cost scaled to the whole month (when the month is not over). */
  projectedCostMinor: number;
  daysCovered: number;
}

export interface CostReportResult {
  month: string;
  daysInMonth: number;
  daysCovered: number;
  rates: CostRatesDoc;
  rows: CostReportRow[];
  byApp: Array<{ appId: string; name: string; revenueMinor: number; costMinor: number }>;
}
