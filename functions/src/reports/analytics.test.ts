import { describe, expect, it } from 'vitest';
import { datesBetween, expectedSeconds, localDayStart } from './analytics';
import { parsePlayerError } from './events';
import { foldUptime } from './plays';

describe('screen analytics helpers', () => {
  it('finds where a local day starts', () => {
    expect(new Date(localDayStart('2026-10-01', 'Asia/Kolkata')).toISOString()).toBe('2026-09-30T18:30:00.000Z');
    expect(new Date(localDayStart('2026-10-01', 'UTC')).toISOString()).toBe('2026-10-01T00:00:00.000Z');
    // Daylight saving: New York is UTC-4 in October.
    expect(new Date(localDayStart('2026-10-01', 'America/New_York')).toISOString()).toBe('2026-10-01T04:00:00.000Z');
  });

  it('counts expected seconds from when the screen was added until now', () => {
    const start = localDayStart('2026-10-01', 'Asia/Kolkata');
    expect(expectedSeconds('2026-10-01', 'Asia/Kolkata', 0, start + 2 * 86_400_000)).toBe(86_400);
    expect(expectedSeconds('2026-10-01', 'Asia/Kolkata', start + 3_600_000, start + 7_200_000)).toBe(3_600);
    expect(expectedSeconds('2026-10-02', 'Asia/Kolkata', 0, start + 3_600_000)).toBe(0);
    expect(datesBetween('2026-09-30', '2026-10-02')).toEqual(['2026-09-30', '2026-10-01', '2026-10-02']);
  });

  it('groups uptime into local days and reads player error lines', () => {
    const days = foldUptime(
      [
        { hour: Date.parse('2026-09-30T18:00:00Z'), on: 1800, online: 900 },
        { hour: Date.parse('2026-09-30T19:00:00Z'), on: 3600, online: 3600 },
      ],
      'Asia/Kolkata',
    );
    expect([...days.keys()]).toEqual(['2026-09-30', '2026-10-01']);
    expect(days.get('2026-10-01')!.total).toEqual({ on: 3600, online: 3600 });
    const now = Date.parse('2026-10-01T10:00:00Z');
    expect(parsePlayerError('2026-10-01T09:59:00.120Z network: timeout', now)).toEqual({ type: 'error', at: Date.parse('2026-10-01T09:59:00.120Z'), message: 'network: timeout' });
    expect(parsePlayerError('odd line', now)).toEqual({ type: 'error', at: now, message: 'odd line' });
  });
});
