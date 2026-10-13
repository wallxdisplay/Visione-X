import { collection, limit, onSnapshot, orderBy, query, where } from 'firebase/firestore';
import { useEffect, useMemo, useState } from 'react';
import type { DataBinding, LiveValue } from '@wallx-play/layout-spec';
import {
  isSensorOnline,
  paths,
  type AlertDoc,
  type ReadingBucketDoc,
  type SensorChannelDoc,
  type SensorDeviceDoc,
} from '@wallx-play/shared';
import { db } from '../lib/firebase';
import { useDoc, useQueryData, type WithId } from '../lib/hooks';
import { bySite, scopeKey } from '../lib/scope';
import { useOrg } from '../org/OrgProvider';

/** Sensor devices the member may see (their sites when scoped), sorted by name. */
export function useSensorDevices(orgId: string, enabled = true) {
  const { siteScope } = useOrg();
  const live = useQueryData<SensorDeviceDoc>(enabled ? `sensorDevices:${orgId}${scopeKey(siteScope)}` : null, () =>
    query(collection(db, paths.sensorDevices(orgId)), ...bySite(siteScope, orderBy('name'))),
  );
  const data = useMemo(() => [...live.data].sort((a, b) => a.name.localeCompare(b.name)), [live.data]);
  return { ...live, data };
}

export const useSensorChannels = (orgId: string, sensorDeviceId: string | null) =>
  useQueryData<SensorChannelDoc>(sensorDeviceId ? `channels:${orgId}:${sensorDeviceId}` : null, () =>
    query(collection(db, paths.sensorChannels(orgId, sensorDeviceId!)), orderBy('name')),
  );

export interface ChannelOption {
  device: WithId<SensorDeviceDoc>;
  channel: SensorChannelDoc;
}

/** Every channel of every sensor device in the org (for widget binding pickers). */
export function useAllChannels(orgId: string, enabled = true): { options: ChannelOption[]; loading: boolean } {
  const devices = useSensorDevices(orgId, enabled);
  const [channels, setChannels] = useState<Record<string, SensorChannelDoc[]>>({});
  const ids = devices.data.map((d) => d.id).join(',');

  useEffect(() => {
    if (!ids) return;
    const unsubs = ids.split(',').map((deviceId) =>
      onSnapshot(
        query(collection(db, paths.sensorChannels(orgId, deviceId)), orderBy('name')),
        (s) => setChannels((prev) => ({ ...prev, [deviceId]: s.docs.map((d) => d.data() as SensorChannelDoc) })),
        () => setChannels((prev) => ({ ...prev, [deviceId]: [] })),
      ),
    );
    return () => unsubs.forEach((u) => u());
  }, [orgId, ids]);

  return useMemo(
    () => ({
      options: devices.data.flatMap((device) => (channels[device.id] ?? []).map((channel) => ({ device, channel }))),
      loading: devices.loading || devices.data.some((d) => !channels[d.id]),
    }),
    [devices.data, devices.loading, channels],
  );
}

/** Live value of one bound channel, in the same shape the player receives. */
export function useLiveValue(orgId: string | undefined, binding: DataBinding | undefined): LiveValue | null | undefined {
  const sensor = binding?.source === 'sensor' && orgId ? binding : null;
  const channel = useDoc<SensorChannelDoc>(sensor ? paths.sensorChannel(orgId!, sensor.sourceId, sensor.field) : null);
  const device = useDoc<SensorDeviceDoc>(sensor ? paths.sensorDevice(orgId!, sensor.sourceId) : null);
  if (!sensor) return null;
  if (channel.loading || device.loading) return undefined;
  const c = channel.data;
  const d = device.data;
  if (!c) return null;
  return {
    value: c.latest?.value ?? null,
    ts: c.latest?.ts ?? null,
    staleAfterSec: c.staleAfterSec,
    deviceOnline: !!d && d.status === 'active' && isSensorOnline(d),
    unit: c.unit,
  };
}

/** Readings of one channel over the last `minutes`, oldest first, as [ms, value]. */
export function useReadings(
  orgId: string | undefined,
  sensorDeviceId: string | undefined,
  channelId: string | undefined,
  minutes: number,
): { points: Array<[number, number]>; loading: boolean } {
  const enabled = !!(orgId && sensorDeviceId && channelId);
  const buckets = Math.ceil(minutes / 60) + 1;
  const live = useQueryData<ReadingBucketDoc>(enabled ? `readings:${orgId}:${sensorDeviceId}:${channelId}:${buckets}` : null, () =>
    query(
      collection(db, `${paths.sensorChannel(orgId!, sensorDeviceId!, channelId!)}/readings`),
      orderBy('hour', 'desc'),
      limit(buckets),
    ),
  );
  // Re-cut the window each minute so old points fall off even without new readings.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  const points = useMemo(() => {
    const from = now - minutes * 60_000;
    return live.data
      .flatMap((b) => b.points)
      .filter((p) => p.t >= from)
      .sort((a, b) => a.t - b.t)
      .map((p): [number, number] => [p.t, p.v]);
  }, [live.data, minutes, now]);
  return { points, loading: live.loading };
}

const newestFirst = <T extends { openedAt: number }>(xs: T[]) => [...xs].sort((a, b) => b.openedAt - a.openedAt);

/** Open alerts the member may see (their sites when scoped), newest first. */
export function useOpenAlerts(orgId: string, enabled = true) {
  const { siteScope } = useOrg();
  const live = useQueryData<AlertDoc>(enabled ? `alerts:open:${orgId}${scopeKey(siteScope)}` : null, () =>
    query(collection(db, paths.alerts(orgId)), where('status', '==', 'open'), ...bySite(siteScope, orderBy('openedAt', 'desc')), limit(100)),
  );
  return { ...live, data: useMemo(() => newestFirst(live.data), [live.data]) };
}

export function useRecentAlerts(orgId: string, enabled = true) {
  const { siteScope } = useOrg();
  const live = useQueryData<AlertDoc>(enabled ? `alerts:recent:${orgId}${scopeKey(siteScope)}` : null, () =>
    query(collection(db, paths.alerts(orgId)), ...bySite(siteScope, orderBy('openedAt', 'desc')), limit(50)),
  );
  return { ...live, data: useMemo(() => newestFirst(live.data), [live.data]) };
}
