import { describe, expect, it } from 'vitest';
import { findConflicts, localParts, resolvePlaylist, ruleActiveAt } from './schedule';
import type { ScheduleRule } from './schema';

const IST = 'Asia/Kolkata';
/** Instant for a wall-clock time in IST (UTC+5:30, no DST). */
const ist = (date: string, hhmm: string) => Date.parse(`${date}T${hhmm}:00+05:30`);

const rule = (over: Partial<ScheduleRule>): ScheduleRule => ({
  id: 'r',
  priority: 10,
  timezone: IST,
  startDate: null,
  endDate: null,
  daysOfWeek: [],
  windowStart: null,
  windowEnd: null,
  playlistId: 'p',
  ...over,
});

// 2026-10-09 is a Friday.
describe('localParts', () => {
  it('reports wall-clock time in the given zone', () => {
    expect(localParts(ist('2026-10-09', '23:45'), IST)).toEqual({ date: '2026-10-09', dow: 5, minutes: 23 * 60 + 45 });
    // Same instant is still Friday afternoon in London (BST, UTC+1).
    expect(localParts(ist('2026-10-09', '23:45'), 'Europe/London').date).toBe('2026-10-09');
  });
});

describe('ruleActiveAt', () => {
  it('daytime window is start-inclusive, end-exclusive', () => {
    const r = rule({ windowStart: '09:00', windowEnd: '18:00' });
    expect(ruleActiveAt(r, ist('2026-10-09', '08:59'))).toBe(false);
    expect(ruleActiveAt(r, ist('2026-10-09', '09:00'))).toBe(true);
    expect(ruleActiveAt(r, ist('2026-10-09', '17:59'))).toBe(true);
    expect(ruleActiveAt(r, ist('2026-10-09', '18:00'))).toBe(false);
  });

  it('overnight window belongs to the day it starts', () => {
    const fridayNight = rule({ windowStart: '22:00', windowEnd: '06:00', daysOfWeek: [5] });
    expect(ruleActiveAt(fridayNight, ist('2026-10-09', '23:00'))).toBe(true); // Fri night
    expect(ruleActiveAt(fridayNight, ist('2026-10-10', '02:00'))).toBe(true); // early Sat = Fri's run
    expect(ruleActiveAt(fridayNight, ist('2026-10-10', '23:00'))).toBe(false); // Sat night
    expect(ruleActiveAt(fridayNight, ist('2026-10-09', '02:00'))).toBe(false); // early Fri = Thu's run
  });

  it('respects date range and weekdays', () => {
    const r = rule({ startDate: '2026-10-10', endDate: '2026-10-12', daysOfWeek: [0, 6] });
    expect(ruleActiveAt(r, ist('2026-10-09', '12:00'))).toBe(false); // before start
    expect(ruleActiveAt(r, ist('2026-10-10', '12:00'))).toBe(true); // Sat
    expect(ruleActiveAt(r, ist('2026-10-12', '12:00'))).toBe(false); // Mon not selected
    expect(ruleActiveAt(r, ist('2026-10-17', '12:00'))).toBe(false); // after end
  });

  it('evaluates in the rule time zone, not the device zone', () => {
    const london = rule({ timezone: 'Europe/London', windowStart: '09:00', windowEnd: '10:00' });
    expect(ruleActiveAt(london, Date.parse('2026-10-09T08:30:00Z'))).toBe(true); // 09:30 BST
    expect(ruleActiveAt(london, Date.parse('2026-12-09T08:30:00Z'))).toBe(false); // 08:30 GMT
  });
});

describe('resolvePlaylist', () => {
  const morning = rule({ id: 'morning', playlistId: 'breakfast', windowStart: '06:00', windowEnd: '11:00' });
  const promo = rule({ id: 'promo', playlistId: 'sale', priority: 50, startDate: '2026-10-09', endDate: '2026-10-09' });
  const base = { schedules: [morning, promo], defaultPlaylistId: 'always' };

  it('higher priority wins', () => {
    expect(resolvePlaylist(base, ist('2026-10-09', '08:00'))).toEqual({ playlistId: 'sale', source: 'schedule', ruleId: 'promo' });
    expect(resolvePlaylist(base, ist('2026-10-10', '08:00'))).toMatchObject({ playlistId: 'breakfast' });
  });

  it('falls back to the default playlist, then nothing', () => {
    expect(resolvePlaylist(base, ist('2026-10-10', '20:00'))).toEqual({ playlistId: 'always', source: 'default' });
    expect(resolvePlaylist({ schedules: [], defaultPlaylistId: null }, 0)).toEqual({ playlistId: null, source: 'none' });
  });

  it('emergency overrides everything until it expires', () => {
    const at = ist('2026-10-09', '08:00');
    const emergency = { playlistId: 'evacuate', expiresAt: at + 60_000 };
    expect(resolvePlaylist({ ...base, emergency }, at).source).toBe('emergency');
    expect(resolvePlaylist({ ...base, emergency }, at + 120_000).source).toBe('schedule');
  });

  it('breaks ties deterministically', () => {
    const a = rule({ id: 'a', playlistId: 'A' });
    const b = rule({ id: 'b', playlistId: 'B', startDate: '2026-10-01' });
    expect(resolvePlaylist({ schedules: [a, b], defaultPlaylistId: null }, ist('2026-10-09', '12:00')).playlistId).toBe('B');
    expect(resolvePlaylist({ schedules: [b, a], defaultPlaylistId: null }, ist('2026-10-09', '12:00')).playlistId).toBe('B');
  });
});

describe('findConflicts', () => {
  it('reports same-priority overlaps only', () => {
    const a = rule({ id: 'a', windowStart: '09:00', windowEnd: '12:00' });
    const b = rule({ id: 'b', windowStart: '11:00', windowEnd: '13:00' });
    const c = rule({ id: 'c', priority: 90, windowStart: '09:00', windowEnd: '18:00' });
    const conflicts = findConflicts([a, b, c], ist('2026-10-09', '00:00'), { days: 1 });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ a: 'a', b: 'b' });
    expect(conflicts[0]!.at).toBe(ist('2026-10-09', '11:00'));
  });
});
