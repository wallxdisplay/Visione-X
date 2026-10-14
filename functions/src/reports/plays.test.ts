import { describe, expect, it } from 'vitest';
import { PlayBucket, parsePlayKey } from '@wallx-play/shared';
import { foldBuckets, localDateHour } from './plays';

describe('proof-of-play helpers', () => {
  it('turns UTC hours into local dates and hours', () => {
    expect(localDateHour(Date.parse('2026-09-30T18:00:00Z'), 'Asia/Kolkata')).toEqual({ date: '2026-09-30', hour: '23' });
    expect(localDateHour(Date.parse('2026-09-30T20:00:00Z'), 'Asia/Kolkata')).toEqual({ date: '2026-10-01', hour: '01' });
    expect(localDateHour(Date.parse('2026-10-01T00:00:00Z'), 'UTC')).toEqual({ date: '2026-10-01', hour: '00' });
  });

  it('groups buckets per local day and skips empty ones', () => {
    const days = foldBuckets(
      [
        { hour: Date.parse('2026-10-01T04:00:00Z'), kind: 'media', id: 'a', plays: 2, seconds: 20 },
        { hour: Date.parse('2026-10-01T05:00:00Z'), kind: 'media', id: 'a', plays: 1, seconds: 10 },
        { hour: Date.parse('2026-10-01T05:00:00Z'), kind: 'layout', id: 'l', plays: 0, seconds: 0 },
      ],
      'Asia/Kolkata',
    );
    expect([...days.keys()]).toEqual(['2026-10-01']);
    const d = days.get('2026-10-01')!;
    expect(d.total).toEqual({ plays: 3, seconds: 30 });
    expect([...d.items]).toEqual([['media_a', { plays: 3, seconds: 30 }]]);
    expect([...d.hours.keys()]).toEqual(['09', '10']);
  });

  it('validates buckets and keys', () => {
    expect(PlayBucket.safeParse({ hour: 1_000, kind: 'media', id: 'a', plays: 1, seconds: 1 }).success).toBe(false);
    expect(PlayBucket.safeParse({ hour: 3_600_000, kind: 'widget', id: 'a', plays: 1, seconds: 1 }).success).toBe(false);
    expect(parsePlayKey('media_ab_c')).toEqual({ kind: 'media', id: 'ab_c' });
    expect(parsePlayKey('nope_x')).toBeNull();
  });
});
