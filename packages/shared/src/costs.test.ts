import { describe, expect, it } from 'vitest';
import { DEFAULT_COST_RATES, costBreakdown, staleUsageKeys, sumUsage, usageDayId, usageKey, type CostUsageDoc } from './costs';

const day = (over: Partial<CostUsageDoc>): CostUsageDoc => ({
  day: '2026-10-01', orgId: 'o', screens: 0, heartbeats: 0, deliveredBytes: 0, storageBytes: 0, weatherCalls: 0, airQualityCalls: 0,
  sensorRequests: 0, sensorReadings: 0, apiCalls: 0, emails: 0, computedAt: 0, ...over,
});

describe('cost tracking', () => {
  it('keys days in UTC and finds counters to drop', () => {
    const at = Date.parse('2026-10-19T23:30:00Z');
    expect(usageKey(at)).toBe('d20261019');
    expect(usageDayId(at)).toBe('2026-10-19');
    expect(staleUsageKeys({ d20261019: {}, d20261012: {}, d20261011: {} }, at)).toEqual(['d20261011']);
  });

  it('a screen online all month costs about what the price sheet says', () => {
    // 30 days × 288 heartbeats, 1 GB delivered, 1 GB stored all month.
    const days = Array.from({ length: 30 }, (_, i) => day({ screens: 1, heartbeats: 288, storageBytes: 1e9, deliveredBytes: i === 0 ? 1e9 : 0 }));
    const u = sumUsage(days);
    expect(u.screens).toBe(1);
    const c = costBreakdown(u, DEFAULT_COST_RATES, 30, 30);
    expect(c.heartbeats).toBe(2_670); // ₹26.70
    expect(c.delivered).toBe(1_056);
    expect(c.storage).toBe(202);
    expect(c.heartbeats + c.delivered + c.storage).toBeGreaterThan(3_700); // sheet: ₹37.62 per screen
  });

  it('weather, air quality, sensors and API calls at their rates; fixed cost by share of the month', () => {
    const c = costBreakdown(sumUsage([day({ weatherCalls: 2_000, airQualityCalls: 1_000, sensorRequests: 10_000, apiCalls: 1_000 })]), { ...DEFAULT_COST_RATES, perOrgMonth: 3_000 }, 10, 30);
    expect(c).toMatchObject({ weather: 1_056, airQuality: 4_400, sensors: 890, api: 29, fixed: 1_000 });
  });
});
