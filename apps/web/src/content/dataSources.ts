import { collection, orderBy, query } from 'firebase/firestore';
import { useEffect, useState } from 'react';
import { DATA_POLL_SEC, paths, type DataSourceDoc, type DataSourceValue } from '@wallx-play/shared';
import { call } from '../lib/api';
import { db } from '../lib/firebase';
import { useQueryData } from '../lib/hooks';

export const useDataSources = (orgId: string, enabled = true) =>
  useQueryData<DataSourceDoc>(enabled ? `dataSources:${orgId}` : null, () => query(collection(db, paths.dataSources(orgId)), orderBy('name')));

/** One request per data source at a time, shared by every widget showing it. */
const inflight = new Map<string, { at: number; promise: Promise<DataSourceValue> }>();

function load(orgId: string, dataSourceId: string, force = false): Promise<DataSourceValue> {
  const key = `${orgId}/${dataSourceId}`;
  const hit = inflight.get(key);
  if (hit && !force && Date.now() - hit.at < DATA_POLL_SEC * 1000) return hit.promise;
  const promise = call<DataSourceValue>('previewDataSource', { orgId, dataSourceId });
  promise.catch(() => inflight.delete(key));
  inflight.set(key, { at: Date.now(), promise });
  return promise;
}

/**
 * Current value of a data source for previews (the server fetches and caches it). Refreshes
 * every DATA_POLL_SEC like the player; `undefined` while loading, `null` on error.
 */
export function useDataSourceValue(orgId: string | undefined, dataSourceId: string | undefined): { value: DataSourceValue | null | undefined; refresh: () => void } {
  const [value, setValue] = useState<DataSourceValue | null | undefined>(undefined);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!orgId || !dataSourceId) {
      setValue(null);
      return;
    }
    let alive = true;
    load(orgId, dataSourceId, tick > 0)
      .then((v) => alive && setValue(v))
      .catch(() => alive && setValue(null));
    const id = setInterval(() => setTick((t) => t + 1), DATA_POLL_SEC * 1000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [orgId, dataSourceId, tick]);
  return { value, refresh: () => setTick((t) => t + 1) };
}
