import type { Firestore, Transaction, WriteBatch } from 'firebase-admin/firestore';
import { paths, type NotificationDoc, type NotificationType } from '@visione-x/shared';

/**
 * Adds an in-app notification for everyone in the org. Stores type + params only; the web app
 * renders the text in the reader's language. (Email delivery arrives with the notification
 * engine in phase 6.)
 */
export function notify(
  writer: Transaction | WriteBatch,
  db: Firestore,
  orgId: string,
  type: NotificationType,
  params: Record<string, string | number>,
  link: string | null,
  now: number,
): void {
  const ref = db.collection(paths.notifications(orgId)).doc();
  const doc: NotificationDoc = { id: ref.id, type, params, link, createdAt: now, readBy: [] };
  // Transaction.set and WriteBatch.set have the same shape.
  (writer as WriteBatch).set(ref, doc);
}
