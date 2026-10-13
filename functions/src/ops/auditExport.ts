/**
 * Daily audit-log export (docs/ARCHITECTURE.md §12): each finished UTC day of `auditLogs` is
 * written once to a separate archive bucket as NDJSON plus a summary (entry count, SHA-256 of
 * the file, first/last sequence and last hash per chain). The bucket is meant to have a
 * retention policy, so exported days cannot be changed or deleted. Files are written with
 * `ifGenerationMatch: 0` and are never overwritten.
 */
import { createHash } from 'node:crypto';
import type { Bucket } from '@google-cloud/storage';
import { getStorage } from 'firebase-admin/storage';
import { logger } from 'firebase-functions/v2';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { REGION, paths, type AuditDoc } from '@wallx-play/shared';
import { getDeps } from '../lib/admin';
import type { Deps } from '../lib/context';

const DAY = 86_400_000;
const PAGE = 5000;
/** At most this many days per run (catching up after an outage or on the first run). */
const MAX_DAYS_PER_RUN = 31;
const STATE = 'platform/auditExport';

const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const dayStart = (key: string) => Date.parse(`${key}T00:00:00.000Z`);
export const archivePath = (key: string) => `audit/${key.slice(0, 4)}/${key.slice(5, 7)}/${key}`;

interface ChainSummary {
  firstSeq: number;
  lastSeq: number;
  lastHash: string;
}

/** Writes one day; returns the number of entries (0 days still get a summary, so gaps are visible). */
async function exportDay({ db }: Deps, archive: Bucket, key: string): Promise<number> {
  const start = dayStart(key);
  const entries: Array<AuditDoc & { id: string }> = [];
  const chains: Record<string, ChainSummary> = {};
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  for (;;) {
    let q = db.collection(paths.auditLogs()).where('at', '>=', start).where('at', '<', start + DAY).orderBy('at').limit(PAGE);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    for (const d of snap.docs) {
      const e = d.data() as AuditDoc;
      entries.push({ id: d.id, ...e });
      const c = chains[e.chainId];
      chains[e.chainId] = {
        firstSeq: Math.min(c?.firstSeq ?? e.seq, e.seq),
        lastSeq: Math.max(c?.lastSeq ?? e.seq, e.seq),
        lastHash: !c || e.seq >= c.lastSeq ? e.hash : c.lastHash,
      };
    }
    if (snap.size < PAGE) break;
    cursor = snap.docs[snap.docs.length - 1];
  }
  // Same-millisecond entries come back in id order; sort so files are stable and chains read in order.
  entries.sort((a, b) => a.at - b.at || (a.chainId < b.chainId ? -1 : a.chainId > b.chainId ? 1 : a.seq - b.seq));
  const lines = entries.map((e) => JSON.stringify(e));
  const body = lines.length ? `${lines.join('\n')}\n` : '';
  const summary = { day: key, entries: lines.length, sha256: createHash('sha256').update(body).digest('hex'), chains };
  const write = async (name: string, data: string, contentType: string) => {
    try {
      await archive.file(name).save(data, { contentType, resumable: false, preconditionOpts: { ifGenerationMatch: 0 } });
    } catch (e) {
      // 412: already exported (an earlier run wrote it before failing to record progress).
      if ((e as { code?: number }).code !== 412) throw e;
    }
  };
  await write(`${archivePath(key)}.ndjson`, body, 'application/x-ndjson');
  await write(`${archivePath(key)}.summary.json`, JSON.stringify(summary, null, 2), 'application/json');
  return lines.length;
}

/** Exports every finished day not exported yet (oldest first). */
export async function exportAuditLogs(deps: Deps, archive: Bucket): Promise<{ days: string[]; entries: number }> {
  const { db, now } = deps;
  const today = dayKey(now());
  const state = (await db.doc(STATE).get()).data() as { lastDay?: string } | undefined;
  let next: string;
  if (state?.lastDay) {
    next = dayKey(dayStart(state.lastDay) + DAY);
  } else {
    const first = await db.collection(paths.auditLogs()).orderBy('at').limit(1).get();
    if (first.empty) return { days: [], entries: 0 };
    next = dayKey((first.docs[0]!.data() as AuditDoc).at);
  }
  const days: string[] = [];
  let entries = 0;
  while (next < today && days.length < MAX_DAYS_PER_RUN) {
    entries += await exportDay(deps, archive, next);
    await db.doc(STATE).set({ lastDay: next, updatedAt: now() }, { merge: true });
    days.push(next);
    next = dayKey(dayStart(next) + DAY);
  }
  return { days, entries };
}

/** Runs after midnight UTC (06:00 IST). Needs AUDIT_ARCHIVE_BUCKET in functions/.env.wallx-play. */
export const auditExportDaily = onSchedule(
  { schedule: '0 6 * * *', region: REGION, timeZone: 'Asia/Kolkata', memory: '512MiB', timeoutSeconds: 540, maxInstances: 1, retryCount: 2 },
  async () => {
    const name = process.env.AUDIT_ARCHIVE_BUCKET;
    if (!name) {
      logger.warn('Audit export skipped: AUDIT_ARCHIVE_BUCKET is not set (docs/DEVELOPMENT.md).');
      return;
    }
    logger.info('Audit export', await exportAuditLogs(getDeps(), getStorage().bucket(name)));
  },
);
