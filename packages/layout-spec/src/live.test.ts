import { describe, expect, it } from 'vitest';
import { formatLiveValue, gaugeFraction, liveChannelsOf, liveState, statusMatches, thresholdColor, Widget } from './index';

const binding = (field: string) => ({ source: 'sensor' as const, sourceId: 'dev1', field });

describe('liveState', () => {
  const now = 1_000_000;
  const v = { value: 4, ts: now - 30_000, staleAfterSec: 60, deviceOnline: true };

  it('reports ok, stale, offline and no data', () => {
    expect(liveState(v, now)).toBe('ok');
    expect(liveState({ ...v, ts: now - 61_000 }, now)).toBe('stale');
    expect(liveState({ ...v, ts: now - 61_000, deviceOnline: false }, now)).toBe('offline');
    expect(liveState({ ...v, value: null }, now)).toBe('nodata');
    expect(liveState(undefined, now)).toBe('nodata');
  });

  it('honours a per-widget stale override', () => {
    expect(liveState(v, now, 10)).toBe('stale');
  });
});

describe('formatting and matching', () => {
  it('formats with optional fixed decimals', () => {
    expect(formatLiveValue(21)).toBe('21');
    expect(formatLiveValue(21.04)).toBe('21');
    expect(formatLiveValue(21.26)).toBe('21.3');
    expect(formatLiveValue(21.26, 2)).toBe('21.26');
  });

  it('picks the first matching colour band', () => {
    const bands = [
      { label: 'Hot', operator: '>=' as const, value: 8, color: '#DC2626' },
      { label: 'Warm', operator: '>=' as const, value: 5, color: '#F59E0B' },
    ];
    expect(thresholdColor(bands, 9)).toBe('#DC2626');
    expect(thresholdColor(bands, 6)).toBe('#F59E0B');
    expect(thresholdColor(bands, 2)).toBeNull();
  });

  it('matches status states by number or on/off', () => {
    expect(statusMatches('2', 2)).toBe(true);
    expect(statusMatches('on', 1)).toBe(true);
    expect(statusMatches('OFF', 0)).toBe(true);
    expect(statusMatches('true', 0)).toBe(false);
    expect(statusMatches('open', 1)).toBe(false);
  });

  it('clamps gauge positions', () => {
    expect(gaugeFraction(5, 0, 10)).toBe(0.5);
    expect(gaugeFraction(-3, 0, 10)).toBe(0);
    expect(gaugeFraction(30, 0, 10)).toBe(1);
  });
});

describe('sensor widgets', () => {
  it('requires gauge max above min and caps chart windows', () => {
    const gauge = { type: 'gauge', binding: binding('t'), unit: '°C', min: 10, max: 10 };
    expect(Widget.safeParse(gauge).success).toBe(false);
    expect(Widget.safeParse({ ...gauge, max: 40 }).success).toBe(true);
    const chart = { type: 'chart', bindings: [binding('t')], kind: 'line', windowMinutes: 60 };
    expect(Widget.safeParse(chart).success).toBe(true);
    expect(Widget.safeParse({ ...chart, windowMinutes: 2000 }).success).toBe(false);
  });

  it('collects bound channels once, with the longest chart window', () => {
    const layout = {
      zones: [
        { id: 'a', name: '', x: 0, y: 0, w: 0.5, h: 1, z: 0, content: { kind: 'widget' as const, widget: Widget.parse({ type: 'sensorValue', binding: binding('t'), unit: '°C' }) } },
        { id: 'b', name: '', x: 0.5, y: 0, w: 0.5, h: 1, z: 0, content: { kind: 'widget' as const, widget: Widget.parse({ type: 'chart', bindings: [binding('t'), binding('h')], kind: 'line', windowMinutes: 120 }) } },
      ],
    };
    const playlist = {
      items: [{ id: 'i', durationSec: 10, transition: 'none' as const, content: { kind: 'widget' as const, widget: Widget.parse({ type: 'chart', bindings: [binding('t')], kind: 'bar', windowMinutes: 30 }) } }],
    };
    expect(liveChannelsOf([layout], [playlist])).toEqual([
      { sourceId: 'dev1', field: 'h', historyMinutes: 120 },
      { sourceId: 'dev1', field: 't', historyMinutes: 120 },
    ]);
    expect(liveChannelsOf([], [])).toEqual([]);
  });

  it('collects sensor values shown in table cells', () => {
    const table = Widget.parse({ type: 'table', columns: ['Room', 'Temp'], rows: [{ cells: ['Cold room', binding('t')] }, { cells: ['Office', 'n/a'] }] });
    const playlist = { items: [{ id: 'i', durationSec: 10, transition: 'none' as const, content: { kind: 'widget' as const, widget: table } }] };
    expect(liveChannelsOf([], [playlist])).toEqual([{ sourceId: 'dev1', field: 't', historyMinutes: null }]);
  });
});

describe('weather conditions', () => {
  it('maps WMO codes to conditions and icons', async () => {
    const { weatherCondition, weatherIcon } = await import('./index');
    expect([0, 2, 3, 45, 53, 63, 81, 73, 95].map(weatherCondition)).toEqual(['clear', 'partly', 'cloudy', 'fog', 'drizzle', 'rain', 'rain', 'snow', 'storm']);
    expect(weatherIcon('clear', false)).toBe('🌙');
  });
});
