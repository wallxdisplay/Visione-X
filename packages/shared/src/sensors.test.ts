import { describe, expect, it } from 'vitest';
import {
  IngestBody,
  SaveSensorChannelInput,
  downsample,
  ingestTimeMs,
  readingBucketId,
  readingBucketIds,
  ruleBreached,
} from './sensors';

describe('ruleBreached', () => {
  const hot = { operator: '>' as const, value: 8, hysteresis: 0.5 };

  it('opens when the value crosses the limit', () => {
    expect(ruleBreached(hot, 8, false)).toBe(false);
    expect(ruleBreached(hot, 8.1, false)).toBe(true);
  });

  it('applies hysteresis only while breached', () => {
    expect(ruleBreached(hot, 7.8, true)).toBe(true); // still within 0.5 of the limit
    expect(ruleBreached(hot, 7.5, true)).toBe(false);
    const cold = { operator: '<=' as const, value: 2, hysteresis: 1 };
    expect(ruleBreached(cold, 2.5, true)).toBe(true);
    expect(ruleBreached(cold, 3.5, true)).toBe(false);
  });

  it('compares equality rules exactly (door open = 1)', () => {
    const door = { operator: '==' as const, value: 1, hysteresis: 3 };
    expect(ruleBreached(door, 1, false)).toBe(true);
    expect(ruleBreached(door, 0, true)).toBe(false);
  });
});

describe('reading buckets', () => {
  it('uses UTC hours', () => {
    expect(readingBucketId(Date.UTC(2026, 9, 1, 3, 59, 59))).toBe('2026100103');
  });

  it('lists every hour of a range', () => {
    const from = Date.UTC(2026, 9, 1, 22, 30);
    expect(readingBucketIds(from, from + 3 * 3_600_000)).toEqual(['2026100122', '2026100123', '2026100200', '2026100201']);
  });
});

describe('downsample', () => {
  it('keeps short series and averages long ones into slots', () => {
    const short: Array<[number, number]> = [
      [1, 1],
      [2, 2],
    ];
    expect(downsample(short, 10)).toBe(short);
    const long = Array.from({ length: 1000 }, (_, i): [number, number] => [i * 1000, i % 2]);
    const out = downsample(long, 100);
    expect(out.length).toBe(100);
    expect(out.every(([, v]) => v > 0.4 && v < 0.6)).toBe(true);
    expect(out[0]![0]).toBeLessThan(out[99]![0]);
  });
});

describe('ingest payload', () => {
  it('accepts seconds or milliseconds', () => {
    expect(ingestTimeMs(1_790_000_000)).toBe(1_790_000_000_000);
    expect(ingestTimeMs(1_790_000_000_123)).toBe(1_790_000_000_123);
    expect(ingestTimeMs(undefined)).toBeNull();
  });

  it('validates the body shape', () => {
    expect(IngestBody.safeParse({ readings: [{ channel: 'temp', value: 4.2 }, { channel: 'door', value: true }] }).success).toBe(true);
    expect(IngestBody.safeParse({ readings: [] }).success).toBe(false);
    expect(IngestBody.safeParse({ readings: [{ channel: 'temp', value: 'hot' }] }).success).toBe(false);
  });
});

describe('SaveSensorChannelInput', () => {
  const base = {
    orgId: 'o',
    sensorDeviceId: 'd',
    channelId: 'temp',
    isNew: true,
    name: 'Temperature',
    unit: '°C',
    valueType: 'number' as const,
    min: -40,
    max: 85,
    staleAfterSec: 600,
    alertRules: [],
  };

  it('accepts a typical channel and lowercase keys only', () => {
    expect(SaveSensorChannelInput.safeParse(base).success).toBe(true);
    expect(SaveSensorChannelInput.safeParse({ ...base, channelId: 'Temp' }).success).toBe(false);
  });

  it('rejects an empty range and duplicate rule ids', () => {
    expect(SaveSensorChannelInput.safeParse({ ...base, min: 10, max: 10 }).success).toBe(false);
    const rule = { id: 'r1', label: 'Too warm', operator: '>', value: 8, severity: 'warning' };
    expect(SaveSensorChannelInput.safeParse({ ...base, alertRules: [rule, rule] }).success).toBe(false);
  });
});
