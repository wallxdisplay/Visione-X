/**
 * Screen diagnostics history: player errors, offline alerts, back-online and player updates,
 * kept per screen for SCREEN_EVENT_DAYS (orgs/{orgId}/screens/{screenId}/events, TTL). The
 * day's error and offline counts also go into the daily summary (playStats) for analytics.
 * Only organizations whose plan includes screen diagnostics keep any of it. Written only when
 * something happens, so ordinary heartbeats cost nothing extra.
 */
import { FieldValue } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { SCREEN_EVENT_DAYS, paths, type EntitlementsDoc, type OrgDoc, type ScreenEventType } from '@wallx-play/shared';
import type { Deps } from '../lib/context';
import { dayBase, localDateHour } from './plays';

const DAY = 86_400_000;
/** At most this many events per screen per call (a player sends up to 20 errors). */
const MAX_EVENTS = 25;

export interface NewScreenEvent {
  type: ScreenEventType;
  at: number;
  message: string | null;
}

/** "2026-10-14T10:00:00Z message" (the player's error log) → time and text. */
export function parsePlayerError(line: string, fallbackAt: number): NewScreenEvent {
  const m = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+([\s\S]*)$/.exec(line);
  const at = m ? Date.parse(m[1]!) : NaN;
  return { type: 'error', at: Number.isFinite(at) && at <= fallbackAt ? at : fallbackAt, message: (m ? m[2]! : line).slice(0, 300) };
}

/** Records events for one screen; returns how many were kept (0 when the plan has no diagnostics). */
export async function recordScreenEvents(
  deps: Deps,
  orgId: string,
  screenId: string,
  siteId: string | null,
  events: NewScreenEvent[],
): Promise<number> {
  if (!events.length) return 0;
  const { db, now } = deps;
  const [ent, org] = await db.getAll(db.doc(paths.orgEntitlements(orgId)), db.doc(paths.org(orgId)));
  const entitlements = ent?.data() as EntitlementsDoc | undefined;
  if (!entitlements?.features.includes('screen.diagnostics')) return 0;
  const timeZone = (org?.data() as OrgDoc | undefined)?.timezone || 'Asia/Kolkata';
  const keepDays = entitlements.limits.retentionDays ?? 730;
  const kept = events.slice(-MAX_EVENTS);
  const batch = db.batch();
  const col = db.collection(paths.screenEvents(orgId, screenId));
  const perDay = new Map<string, { errors: number; offline: number }>();
  for (const e of kept) {
    batch.create(col.doc(), { ...e, expiresAt: new Date(now() + SCREEN_EVENT_DAYS * DAY) });
    if (e.type === 'error' || e.type === 'offline') {
      const { date } = localDateHour(e.at, timeZone);
      const c = perDay.get(date) ?? { errors: 0, offline: 0 };
      perDay.set(date, e.type === 'error' ? { ...c, errors: c.errors + 1 } : { ...c, offline: c.offline + 1 });
    }
  }
  for (const [date, c] of perDay) {
    batch.set(
      db.doc(paths.playStat(orgId, date, screenId)),
      {
        ...dayBase(date, screenId, siteId, keepDays),
        ...(c.errors ? { errors: FieldValue.increment(c.errors) } : {}),
        ...(c.offline ? { offline: FieldValue.increment(c.offline) } : {}),
        updatedAt: now(),
      },
      { merge: true },
    );
  }
  try {
    await batch.commit();
    return kept.length;
  } catch (err) {
    // Diagnostics must never break the heartbeat or the monitor.
    logger.warn('Could not record screen events', { orgId, screenId, error: (err as Error).message });
    return 0;
  }
}
