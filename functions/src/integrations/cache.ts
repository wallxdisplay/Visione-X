/**
 * Central provider cache (providerCache/{key}, server-only). Weather and air quality are cached
 * per place (coordinates rounded to ~1 km), RSS per feed URL, so many screens and orgs showing
 * the same place or feed cost one provider call per TTL. On a provider error the last good
 * result is served (marked not ok) for up to STALE_SERVE_MS, and retries back off for 2 minutes.
 */
import { createHash } from 'node:crypto';
import { Timestamp } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import {
  AIR_QUALITY_TTL_MS,
  RSS_MAX_BYTES,
  RSS_MAX_ITEMS,
  RSS_TTL_MS,
  STALE_SERVE_MS,
  WEATHER_TTL_MS,
  paths,
  type AirQualityData,
  type DataSourceDoc,
  type DataSourceValue,
  type RssConfig,
  type RssData,
  type WeatherData,
} from '@wallx-play/shared';
import type { Deps } from '../lib/context';
import { fetchAirQuality } from './airQuality';
import { FetchError, safeGet } from './net';
import { FeedError, parseFeed } from './rss';
import { ProviderNotConfigured, fetchWeather } from './weather';
import { usageFields } from '../costs/usage';

interface CacheDoc {
  fetchedAt: number | null;
  freshUntil: number;
  retryAt: number;
  error: string | null;
  weather: WeatherData | null;
  rss: RssData | null;
  /** Absent on entries cached before air quality existed. */
  airQuality?: AirQualityData | null;
  /** Firestore TTL deletes entries nobody has refreshed for a day. */
  expiresAt: Timestamp;
}

const RETRY_MS = 2 * 60_000;

export function cacheKey(ds: DataSourceDoc): string {
  if (ds.type === 'weather') return `w_${ds.config.latitude.toFixed(2)}_${ds.config.longitude.toFixed(2)}`;
  if (ds.type === 'air_quality') return `a_${ds.config.latitude.toFixed(2)}_${ds.config.longitude.toFixed(2)}`;
  return `r_${createHash('sha256').update(ds.config.url).digest('hex').slice(0, 40)}`;
}

/** Message safe to show to customers for any provider failure. */
export function providerMessage(err: unknown): string {
  if (err instanceof FetchError || err instanceof FeedError || err instanceof ProviderNotConfigured) return err.message;
  return 'The data could not be loaded.';
}

export async function fetchRss(deps: Deps, config: Pick<RssConfig, 'url'>): Promise<RssData> {
  const xml = await safeGet(deps, config.url, { maxBytes: RSS_MAX_BYTES, accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' });
  return parseFeed(xml, RSS_MAX_ITEMS);
}

function valueOf(ds: DataSourceDoc, c: Pick<CacheDoc, 'fetchedAt' | 'weather' | 'rss' | 'airQuality'> | null, ok: boolean, error: string | null): DataSourceValue {
  return {
    id: ds.id,
    type: ds.type,
    name: ds.name,
    ok,
    error,
    fetchedAt: c?.fetchedAt ?? null,
    weather: ds.type === 'weather' ? (c?.weather ?? null) : null,
    rss: ds.type === 'rss' && c?.rss ? { ...c.rss, items: c.rss.items.slice(0, ds.config.maxItems) } : null,
    airQuality: ds.type === 'air_quality' ? (c?.airQuality ?? null) : null,
  };
}

/** Current value of a data source: from the cache when fresh, else fetched (and cached). */
export async function getDataSourceValue(deps: Deps, orgId: string, ds: DataSourceDoc): Promise<DataSourceValue> {
  const { db, now } = deps;
  const at = now();
  const ref = db.doc(paths.providerCache(cacheKey(ds)));
  const cached = (await ref.get()).data() as CacheDoc | undefined;
  const usable = cached?.fetchedAt != null && at - cached.fetchedAt < STALE_SERVE_MS ? cached : null;
  if (cached && !cached.error && at < cached.freshUntil) return valueOf(ds, cached, true, null);
  if (cached?.error && at < cached.retryAt) return valueOf(ds, usable, false, cached.error);

  let fresh: Pick<CacheDoc, 'weather' | 'rss' | 'airQuality'>;
  try {
    const none = { weather: null, rss: null, airQuality: null };
    if (ds.type === 'weather') fresh = { ...none, weather: await fetchWeather(deps, ds.config) };
    else if (ds.type === 'air_quality') fresh = { ...none, airQuality: await fetchAirQuality(deps, ds.config) };
    else fresh = { ...none, rss: await fetchRss(deps, ds.config) };
  } catch (err) {
    const error = providerMessage(err);
    if (!(err instanceof FetchError || err instanceof FeedError || err instanceof ProviderNotConfigured)) logger.warn('Provider fetch failed', { key: ref.id, err: String(err) });
    await ref.set(
      {
        error,
        retryAt: at + RETRY_MS,
        freshUntil: 0,
        expiresAt: Timestamp.fromMillis(at + STALE_SERVE_MS),
        ...(cached ? {} : { fetchedAt: null, weather: null, rss: null, airQuality: null }),
      },
      { merge: true },
    );
    await db.doc(paths.dataSource(orgId, ds.id)).update({ lastFetch: { at, ok: false, error } }).catch(() => undefined);
    return valueOf(ds, usable, false, error);
  }
  const doc: CacheDoc = {
    ...fresh,
    fetchedAt: at,
    freshUntil: at + (ds.type === 'weather' ? WEATHER_TTL_MS : ds.type === 'air_quality' ? AIR_QUALITY_TTL_MS : RSS_TTL_MS),
    retryAt: 0,
    error: null,
    expiresAt: Timestamp.fromMillis(at + STALE_SERVE_MS),
  };
  await ref.set(doc);
  const calls = ds.type === 'weather' ? 2 : ds.type === 'air_quality' ? 1 : 0;
  await db
    .doc(paths.dataSource(orgId, ds.id))
    .update({ lastFetch: { at, ok: true, error: null }, ...usageFields(ds.usage, at, { calls }) })
    .catch(() => undefined);
  return valueOf(ds, doc, true, null);
}
