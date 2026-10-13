import { collection, limit, orderBy, query, where } from 'firebase/firestore';
import {
  paths,
  type EmergencyDoc,
  type NotificationDoc,
  type PublishApprovalDoc,
  type ScreenCommandDoc,
} from '@wallx-play/shared';
import { db } from '../lib/firebase';
import { useQueryData } from '../lib/hooks';

export const useNotifications = (orgId: string) =>
  useQueryData<NotificationDoc>(`notifications:${orgId}`, () =>
    query(collection(db, paths.notifications(orgId)), orderBy('createdAt', 'desc'), limit(20)),
  );

export const useActiveEmergencies = (orgId: string) =>
  useQueryData<EmergencyDoc>(`emergencies:${orgId}`, () =>
    query(collection(db, paths.emergencies(orgId)), where('active', '==', true)),
  );

/** Pending approvals, oldest first (sorted client-side to avoid another composite index). */
export function usePendingApprovals(orgId: string, enabled: boolean) {
  const live = useQueryData<PublishApprovalDoc>(enabled ? `approvals:${orgId}` : null, () =>
    query(collection(db, paths.approvals(orgId)), where('status', '==', 'pending')),
  );
  return { ...live, data: [...live.data].sort((a, b) => a.requestedAt - b.requestedAt) };
}

export const useScreenCommands = (orgId: string, screenId: string) =>
  useQueryData<ScreenCommandDoc>(`commands:${orgId}:${screenId}`, () =>
    query(collection(db, paths.commands(orgId, screenId)), orderBy('createdAt', 'desc'), limit(8)),
  );
