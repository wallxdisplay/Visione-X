/**
 * Schedule resolution: which playlist should a screen play at a given instant?
 * Pure and dependency-free so the Android player can port it 1:1 (and so it runs offline).
 */
import type { ScheduleRule } from './schema';

export interface LocalParts {
  /** YYYY-MM-DD */
  date: string;
  /** 0 = Sunday */
  dow: number;
  /** Minutes since local midnight. */
  minutes: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Wall-clock date/time of an instant in an IANA time zone. */
export function localParts(ms: number, timezone: string): LocalParts {
  let fmt = formatters.get(timezone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hourCycle: 'h23',
    });
    formatters.set(timezone, fmt);
  }
  const parts = Object.fromEntries(fmt.formatToParts(ms).map((p) => [p.type, p.value]));
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday ?? '');
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    dow,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Previous calendar day of a YYYY-MM-DD string (no time zone involved). */
export function previousDate(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function dayMatches(rule: ScheduleRule, date: string, dow: number): boolean {
  if (rule.startDate && date < rule.startDate) return false;
  if (rule.endDate && date > rule.endDate) return false;
  return rule.daysOfWeek.length === 0 || rule.daysOfWeek.includes(dow);
}

/** Is the rule in effect at this instant? */
export function ruleActiveAt(rule: ScheduleRule, ms: number): boolean {
  const { date, dow, minutes } = localParts(ms, rule.timezone);

  if (!rule.windowStart || !rule.windowEnd) return dayMatches(rule, date, dow); // all day

  const start = toMinutes(rule.windowStart);
  const end = toMinutes(rule.windowEnd);
  if (end > start) return dayMatches(rule, date, dow) && minutes >= start && minutes < end;

  // Overnight window: the part after midnight belongs to the previous day's occurrence.
  if (minutes >= start) return dayMatches(rule, date, dow);
  if (minutes < end) return dayMatches(rule, previousDate(date), (dow + 6) % 7);
  return false;
}

export type ResolvedSource = 'emergency' | 'schedule' | 'default' | 'none';

export interface Resolution {
  playlistId: string | null;
  source: ResolvedSource;
  ruleId?: string;
}

/**
 * Priority order: emergency override > highest-priority active schedule > default playlist.
 * Ties between schedules go to the rule with the later startDate, then the smaller id, so every
 * device resolves the same answer.
 */
export function resolvePlaylist(
  input: {
    schedules: ScheduleRule[];
    defaultPlaylistId: string | null;
    emergency?: { playlistId: string; expiresAt: number | null } | null;
  },
  ms: number,
): Resolution {
  const { emergency } = input;
  if (emergency && (emergency.expiresAt === null || emergency.expiresAt > ms)) {
    return { playlistId: emergency.playlistId, source: 'emergency' };
  }

  const winner = input.schedules
    .filter((r) => ruleActiveAt(r, ms))
    .sort(
      (a, b) =>
        b.priority - a.priority ||
        (b.startDate ?? '').localeCompare(a.startDate ?? '') ||
        a.id.localeCompare(b.id),
    )[0];
  if (winner) return { playlistId: winner.playlistId, source: 'schedule', ruleId: winner.id };

  return input.defaultPlaylistId
    ? { playlistId: input.defaultPlaylistId, source: 'default' }
    : { playlistId: null, source: 'none' };
}

export interface Conflict {
  a: string;
  b: string;
  /** First instant both rules are active. */
  at: number;
}

/**
 * Pairs of rules with the SAME priority that are active at the same moment, found by sampling
 * every `stepMinutes` from `fromMs` for `days`. Different priorities are not conflicts — the
 * higher one simply wins.
 */
export function findConflicts(
  rules: ScheduleRule[],
  fromMs: number,
  { days = 14, stepMinutes = 15 } = {},
): Conflict[] {
  const found = new Map<string, Conflict>();
  const step = stepMinutes * 60_000;
  for (let t = fromMs; t < fromMs + days * 86_400_000; t += step) {
    const active = rules.filter((r) => ruleActiveAt(r, t));
    for (let i = 0; i < active.length; i++) {
      for (let j = i + 1; j < active.length; j++) {
        const a = active[i]!;
        const b = active[j]!;
        if (a.priority !== b.priority) continue;
        const key = [a.id, b.id].sort().join('|');
        if (!found.has(key)) found.set(key, { a: a.id, b: b.id, at: t });
      }
    }
  }
  return [...found.values()];
}
