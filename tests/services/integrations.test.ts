import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Manifest } from '@wallx-play/layout-spec';
import { paths, type DataSourceDoc, type DataSourceValue, type DeviceDataResponse } from '@wallx-play/shared';
import { handle } from '../../functions/src/api/router';
import * as layouts from '../../functions/src/content/layouts';
import * as schedules from '../../functions/src/content/schedules';
import * as integrations from '../../functions/src/integrations/dataSources';
import type { Deps } from '../../functions/src/lib/context';
import { reviewOrgSignup } from '../../functions/src/orgs/review';
import { submitOrgSignup } from '../../functions/src/orgs/signup';
import * as screens from '../../functions/src/screens/screens';
import { advance, db, deps as baseDeps, expectCode, resetEmulator, superadmin, user } from './helpers';

const alice = user('alice');
let orgId: string;
let calls: string[];
let weatherStatus: number;
let airRequests: Array<{ body: unknown; key: string | null }>;

const FORECAST = {
  timezone: 'Asia/Kolkata',
  current: { temperature_2m: 29.6, apparent_temperature: 33, relative_humidity_2m: 70, wind_speed_10m: 9, weather_code: 3, is_day: 1 },
  daily: { time: ['2026-10-01', '2026-10-02', '2026-10-03'], weather_code: [3, 61, 1], temperature_2m_max: [31, 29, 32], temperature_2m_min: [24, 23, 24] },
};
const AIR = {
  dateTime: '2026-10-14T05:00:00Z',
  regionCode: 'in',
  indexes: [
    { code: 'uaqi', displayName: 'Universal AQI', aqi: 52, aqiDisplay: '52', color: { red: 1, green: 0.9 }, category: 'Moderate air quality', dominantPollutant: 'pm25' },
    { code: 'ind_cpcb', displayName: 'NAQI (IN)', aqi: 112, aqiDisplay: '112', color: { red: 1, green: 1 }, category: 'Moderate air quality', dominantPollutant: 'pm10' },
  ],
};
const FEED = `<rss version="2.0"><channel><title>Pune Today</title>
  <item><title>Metro extension opens</title></item><item><title>Ganesh festival traffic plan</title></item><item><title>Rain likely</title></item>
</channel></rss>`;

const deps: Deps = {
  ...baseDeps,
  fetch: (async (input: URL | string, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url === 'https://airquality.googleapis.com/v1/currentConditions:lookup' && init?.method === 'POST') {
      airRequests.push({ body: JSON.parse(String(init.body)), key: new Headers(init.headers).get('x-goog-api-key') });
      return Response.json(AIR);
    }
    if (url.startsWith('https://api.open-meteo.com/v1/forecast')) {
      return weatherStatus === 200 ? Response.json(FORECAST) : new Response('down', { status: weatherStatus });
    }
    if (url.startsWith('https://geocoding-api.open-meteo.com/')) {
      return Response.json({ results: [{ name: 'Pune', admin1: 'Maharashtra', country: 'India', latitude: 18.5196, longitude: 73.8553 }] });
    }
    if (url === 'https://news.example/rss') return new Response(FEED);
    return new Response('not found', { status: 404 });
  }) as typeof fetch,
  lookup: async (host) => (host === 'intranet.example' ? ['10.0.0.8'] : ['93.184.216.34']),
};

const weather = { orgId: '', name: 'Pune', type: 'weather' as const, config: { placeName: 'Pune', latitude: 18.5196, longitude: 73.8553 } };
const rss = { orgId: '', name: 'Pune Today', type: 'rss' as const, config: { url: 'https://news.example/rss', maxItems: 2 } };
const air = { orgId: '', name: 'Pune air', type: 'air_quality' as const, config: { placeName: 'Pune', latitude: 18.5196, longitude: 73.8553 } };

const canvas = { width: 1920, height: 1080, orientation: 'landscape' as const, background: '#000000' };
const zone = (widget: unknown) => ({ id: 'z', name: 'Zone', x: 0, y: 0, w: 1, h: 1, z: 0, content: { kind: 'widget', widget } });
type LayoutInput = Parameters<typeof layouts.saveLayout>[2]['layout'];

/** Pairs a player, shows the layout on it, and returns a GET helper with the player's credentials. */
async function publishToPlayer(layoutId: string) {
  const reg = await handle(deps, {
    method: 'POST', path: '/api/v1/devices/register', headers: {}, ip: '10.0.0.9',
    body: { hardware: { manufacturer: 'X', model: 'Box', androidVersion: '11', sdkInt: 30, appVersion: '0.6.0', display: { width: 1920, height: 1080 } } },
  });
  const b = reg.body as { deviceId: string; deviceSecret: string; pairingCode: string };
  await screens.claimDevice(deps, alice, { orgId, pairingCode: b.pairingCode, name: 'Lobby', siteId: null, groupIds: [], orientation: 'landscape', resolution: { width: 1920, height: 1080 } });
  const { playlistId } = await layouts.savePlaylist(deps, alice, { orgId, name: 'Loop', items: [{ id: 'i', content: { kind: 'layout', layoutId }, durationSec: 30, transition: 'none' }] });
  await schedules.saveSchedule(deps, alice, {
    orgId, name: 'Always', playlistId, target: { kind: 'all' }, priority: 10, timezone: 'Asia/Kolkata',
    startDate: null, endDate: null, daysOfWeek: [], windowStart: null, windowEnd: null, enabled: true,
  });
  await screens.publishScreens(deps, alice, { orgId, screenIds: [] });
  return (path: string) => handle(deps, { method: 'GET', path, headers: { authorization: `Device ${b.deviceId}:${b.deviceSecret}` }, body: {}, ip: '10.0.0.9' });
}

beforeEach(async () => {
  await resetEmulator();
  calls = [];
  weatherStatus = 200;
  airRequests = [];
  const r = await submitOrgSignup(deps, alice, {
    orgName: 'Signage Co',
    contactName: 'Asha',
    phone: '+91 98200 12345',
    city: 'Pune',
    stateCode: '27',
    expectedScreens: 1,
    timezone: 'Asia/Kolkata',
  });
  await reviewOrgSignup(deps, superadmin, { requestId: r.requestId, decision: 'approve' });
  orgId = r.orgId;
  weather.orgId = orgId;
  rss.orgId = orgId;
  air.orgId = orgId;
});

afterEach(() => {
  delete process.env.K_SERVICE;
  delete process.env.GOOGLE_MAPS_API_KEY;
});

describe('weather data sources', () => {
  it('geocodes, previews through the cache and serves stale data when the provider fails', async () => {
    expect((await integrations.geocodePlace(deps, alice, { orgId, query: 'Pune' })).results[0]).toMatchObject({ name: 'Pune', admin1: 'Maharashtra' });
    const { dataSourceId } = await integrations.saveDataSource(deps, alice, weather);

    const first = await integrations.previewDataSource(deps, alice, { orgId, dataSourceId });
    expect(first).toMatchObject({ ok: true, type: 'weather', weather: { current: { tempC: 29.6, code: 3 } } });
    expect(first.weather!.daily).toHaveLength(3);
    await integrations.previewDataSource(deps, alice, { orgId, dataSourceId });
    expect(calls.filter((c) => c.includes('forecast'))).toHaveLength(1); // cached

    advance(16 * 60_000);
    weatherStatus = 503;
    const stale = await integrations.previewDataSource(deps, alice, { orgId, dataSourceId });
    expect(stale).toMatchObject({ ok: false, error: 'The weather service answered with HTTP 503.', weather: { current: { tempC: 29.6 } } });
    expect(((await db.doc(paths.dataSource(orgId, dataSourceId)).get()).data() as DataSourceDoc).lastFetch).toMatchObject({ ok: false });

    await integrations.previewDataSource(deps, alice, { orgId, dataSourceId });
    expect(calls.filter((c) => c.includes('forecast'))).toHaveLength(2); // backing off, no new call
  });

  it('refuses the free API in production and needs the plan feature', async () => {
    const { dataSourceId } = await integrations.saveDataSource(deps, alice, weather);
    process.env.K_SERVICE = 'api';
    const v: DataSourceValue = await integrations.previewDataSource(deps, alice, { orgId, dataSourceId: dataSourceId });
    expect(v).toMatchObject({ ok: false, weather: null });
    expect(v.error).toContain('not configured');
    expect(calls).toHaveLength(0);
    delete process.env.K_SERVICE;

    await db.doc(paths.orgEntitlements(orgId)).update({ features: ['media.basic', 'widget.core'] });
    await expectCode(integrations.saveDataSource(deps, alice, weather), 'permission-denied');
  });
});

describe('RSS data sources on screens', () => {
  it('tests feeds safely, validates widgets and serves headlines to the player', async () => {
    expect((await integrations.testRssFeed(deps, alice, { orgId, config: rss.config })).items.map((i) => i.title)).toEqual([
      'Metro extension opens',
      'Ganesh festival traffic plan',
    ]);
    await expectCode(integrations.testRssFeed(deps, alice, { orgId, config: { url: 'https://intranet.example/feed', maxItems: 5 } }), 'failed-precondition');
    await expectCode(integrations.saveDataSource(deps, user('mallory'), rss), 'permission-denied');
    const { dataSourceId } = await integrations.saveDataSource(deps, alice, rss);
    const { dataSourceId: weatherId } = await integrations.saveDataSource(deps, alice, weather);

    const rssWidget = { type: 'rss', dataSourceId, itemDurationSec: 8, showFeedTitle: true, style: {} };
    await expectCode(
      layouts.saveLayout(deps, alice, { orgId, layout: { name: 'Bad', canvas, zones: [zone({ ...rssWidget, dataSourceId: weatherId })] } as LayoutInput }),
      'invalid-argument',
    );
    const { layoutId } = await layouts.saveLayout(deps, alice, { orgId, layout: { name: 'News', canvas, zones: [zone(rssWidget)] } as LayoutInput });
    await expectCode(integrations.deleteDataSource(deps, alice, { orgId, dataSourceId }), 'failed-precondition');

    const player = await publishToPlayer(layoutId);

    const manifest = Manifest.parse((await player('/api/v1/devices/manifest')).body);
    expect(manifest.dataSources).toEqual([{ id: dataSourceId, type: 'rss' }]);
    const data = (await player('/api/v1/devices/data')).body as DeviceDataResponse;
    expect(data.sources).toHaveLength(1);
    expect(data.sources[0]).toMatchObject({ id: dataSourceId, ok: true, rss: { feedTitle: 'Pune Today' } });
    expect(data.sources[0]!.rss!.items.map((i) => i.title)).toEqual(['Metro extension opens', 'Ganesh festival traffic plan']);

    await integrations.deleteDataSource(deps, alice, { orgId, dataSourceId: weatherId });
    expect((await db.doc(paths.dataSource(orgId, weatherId)).get()).exists).toBe(false);
  });
});

describe('air quality data sources', () => {
  it('needs the Google key, asks for the local index, caches and serves NAQI to the player', async () => {
    const { dataSourceId } = await integrations.saveDataSource(deps, alice, air);
    const { dataSourceId: weatherId } = await integrations.saveDataSource(deps, alice, weather);

    // No free fallback: without the key the source reports "not configured" and calls nobody.
    const off = await integrations.previewDataSource(deps, alice, { orgId, dataSourceId });
    expect(off).toMatchObject({ ok: false, airQuality: null });
    expect(off.error).toContain('not configured');
    expect(airRequests).toHaveLength(0);

    process.env.GOOGLE_MAPS_API_KEY = 'test-key';
    advance(3 * 60_000); // past the retry back-off
    const v = await integrations.previewDataSource(deps, alice, { orgId, dataSourceId });
    expect(v).toMatchObject({
      ok: true,
      type: 'air_quality',
      weather: null,
      rss: null,
      airQuality: { index: { code: 'ind_cpcb', aqi: 112, category: 'Moderate air quality', color: '#FFFF00', dominantPollutant: 'PM10' }, attribution: 'Google Maps' },
    });
    expect(airRequests).toEqual([
      { key: 'test-key', body: { location: { latitude: 18.5196, longitude: 73.8553 }, extraComputations: ['LOCAL_AQI'], universalAqi: true, languageCode: 'en' } },
    ]);
    expect(calls.every((c) => !c.includes('test-key'))).toBe(true); // the key never goes in a URL
    await integrations.previewDataSource(deps, alice, { orgId, dataSourceId });
    expect(airRequests).toHaveLength(1); // cached

    const aqiWidget = { type: 'aqi', dataSourceId, layout: 'detailed', style: {} };
    await expectCode(
      layouts.saveLayout(deps, alice, { orgId, layout: { name: 'Bad', canvas, zones: [zone({ ...aqiWidget, dataSourceId: weatherId })] } as LayoutInput }),
      'invalid-argument',
    );
    const { layoutId } = await layouts.saveLayout(deps, alice, { orgId, layout: { name: 'Air', canvas, zones: [zone(aqiWidget)] } as LayoutInput });
    await expectCode(integrations.deleteDataSource(deps, alice, { orgId, dataSourceId }), 'failed-precondition');

    const player = await publishToPlayer(layoutId);
    const manifest = Manifest.parse((await player('/api/v1/devices/manifest')).body);
    expect(manifest.dataSources).toEqual([{ id: dataSourceId, type: 'air_quality' }]);
    const data = (await player('/api/v1/devices/data')).body as DeviceDataResponse;
    expect(data.sources).toHaveLength(1);
    expect(data.sources[0]).toMatchObject({ id: dataSourceId, ok: true, airQuality: { attribution: 'Google Maps', index: { name: 'NAQI (IN)', display: '112' } } });
    expect(airRequests).toHaveLength(1); // the player is served from the same cache
  });

  it('comes with the weather feature', async () => {
    await db.doc(paths.orgEntitlements(orgId)).update({ features: ['media.basic', 'widget.core', 'widget.rss'] });
    await expectCode(integrations.saveDataSource(deps, alice, air), 'permission-denied');
  });
});
