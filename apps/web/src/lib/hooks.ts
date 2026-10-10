import {
  doc,
  onSnapshot,
  type DocumentData,
  type FirestoreError,
  type Query,
} from 'firebase/firestore';
import { useEffect, useRef, useState } from 'react';
import { db } from './firebase';

export interface Live<T> {
  data: T;
  loading: boolean;
  error: FirestoreError | null;
}

export type WithId<T> = T & { _id: string };

interface Snapshot<T> {
  /** The path/key this result belongs to; anything else is stale. */
  key: string | null;
  data: T;
  error: FirestoreError | null;
}

/**
 * Live document. `path` null = not requested.
 * `loading` is derived from whether the stored result belongs to the current path, so there
 * is never a render where a new path looks "loaded but empty".
 */
export function useDoc<T>(path: string | null): Live<T | undefined> {
  const [snap, setSnap] = useState<Snapshot<T | undefined>>({ key: null, data: undefined, error: null });
  useEffect(() => {
    if (!path) return;
    return onSnapshot(
      doc(db, path),
      (s) => setSnap({ key: path, data: s.exists() ? (s.data() as T) : undefined, error: null }),
      (error) => setSnap({ key: path, data: undefined, error }),
    );
  }, [path]);

  if (!path) return { data: undefined, loading: false, error: null };
  const current = snap.key === path;
  return { data: current ? snap.data : undefined, loading: !current, error: current ? snap.error : null };
}

/**
 * Live query. `key` identifies the query (it is rebuilt only when the key changes);
 * pass null to skip.
 */
export function useQueryData<T>(
  key: string | null,
  build: () => Query<DocumentData>,
): Live<WithId<T>[]> {
  const [snap, setSnap] = useState<Snapshot<WithId<T>[]>>({ key: null, data: [], error: null });
  const buildRef = useRef(build);
  buildRef.current = build;

  useEffect(() => {
    if (!key) return;
    return onSnapshot(
      buildRef.current(),
      (s) =>
        setSnap({
          key,
          data: s.docs.map((d) => ({ ...(d.data() as T), _id: d.id }) as WithId<T>),
          error: null,
        }),
      (error) => setSnap({ key, data: [], error }),
    );
  }, [key]);

  if (!key) return { data: [], loading: false, error: null };
  const current = snap.key === key;
  return { data: current ? snap.data : [], loading: !current, error: current ? snap.error : null };
}
