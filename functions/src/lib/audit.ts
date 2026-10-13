import { createHash } from 'node:crypto';
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { paths, type AuditDoc } from '@wallx-play/shared';

export type AuditInput = Omit<AuditDoc, 'chainId' | 'seq' | 'prevHash' | 'hash'>;
export type RecordAudit = (chainId: string, entry: AuditInput) => void;

interface Head {
  seq: number;
  hash: string | null;
}

/** Deterministic JSON: object keys sorted, undefined dropped. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

export function hashAuditEntry(entry: Omit<AuditDoc, 'hash'>): string {
  return createHash('sha256').update(stableStringify(entry)).digest('hex');
}

/**
 * Runs `fn` in a transaction and appends its audit entries in the same commit, so an action
 * and its audit record either both happen or neither does. Each chain (an org id, or
 * "platform") is a hash chain: every entry includes the previous entry's hash, which makes
 * deletion or editing of past entries detectable.
 *
 * Chain heads are read first because Firestore transactions need all reads before writes;
 * `fn` must likewise do its reads before its writes.
 */
export async function auditedTransaction<T>(
  db: Firestore,
  chainIds: string[],
  fn: (tx: Transaction, audit: RecordAudit) => Promise<T>,
): Promise<T> {
  return db.runTransaction(async (tx) => {
    const unique = [...new Set(chainIds)];
    const heads = new Map<string, Head>();
    for (const chainId of unique) {
      const snap = await tx.get(db.doc(paths.auditHead(chainId)));
      heads.set(chainId, (snap.data() as Head | undefined) ?? { seq: 0, hash: null });
    }

    const pending: Array<{ chainId: string; entry: AuditInput }> = [];
    const result = await fn(tx, (chainId, entry) => {
      if (!heads.has(chainId)) throw new Error(`Audit chain ${chainId} was not opened`);
      pending.push({ chainId, entry });
    });

    for (const { chainId, entry } of pending) {
      const head = heads.get(chainId)!;
      const unsigned: Omit<AuditDoc, 'hash'> = {
        ...entry,
        chainId,
        seq: head.seq + 1,
        prevHash: head.hash,
      };
      const hash = hashAuditEntry(unsigned);
      tx.create(db.collection(paths.auditLogs()).doc(), JSON.parse(JSON.stringify({ ...unsigned, hash })));
      heads.set(chainId, { seq: unsigned.seq, hash });
    }
    for (const chainId of new Set(pending.map((p) => p.chainId))) {
      tx.set(db.doc(paths.auditHead(chainId)), heads.get(chainId)!);
    }
    return result;
  });
}

/** Recomputes a chain and reports the first broken link (used by audits and tests). */
export async function verifyAuditChain(
  db: Firestore,
  chainId: string,
): Promise<{ ok: true; count: number } | { ok: false; brokenAtSeq: number }> {
  const snap = await db.collection(paths.auditLogs()).where('chainId', '==', chainId).orderBy('seq').get();
  let prevHash: string | null = null;
  let expectedSeq = 1;
  for (const doc of snap.docs) {
    const { hash, ...rest } = doc.data() as AuditDoc;
    if (rest.seq !== expectedSeq || rest.prevHash !== prevHash || hashAuditEntry(rest) !== hash) {
      return { ok: false, brokenAtSeq: expectedSeq };
    }
    prevHash = hash;
    expectedSeq += 1;
  }
  return { ok: true, count: snap.size };
}
