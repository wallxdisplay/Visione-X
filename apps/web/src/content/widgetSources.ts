import { useMemo } from 'react';
import { useOrg } from '../org/OrgProvider';
import { useDataSources } from './dataSources';
import { useAllChannels } from './sensors';
import type { ChannelChoice, DataWidgetType } from './widgetDefaults';

/** A weather place or RSS feed the org has set up (Integrations). */
export interface DataSourceChoice {
  id: string;
  name: string;
  type: DataWidgetType;
}

export interface WidgetSources {
  /** Sensor channels to bind; null when the plan has no sensors (sensor widgets are not offered). */
  sensors: ChannelChoice[] | null;
  /** Data sources per widget type the plan includes; a type missing from the map is not offered. */
  dataSources: Partial<Record<DataWidgetType, DataSourceChoice[]>>;
}

/** What widget editors may bind to, limited by the plan and the member's permissions. */
export function useWidgetSources(): WidgetSources {
  const { orgId, can, entitlements } = useOrg();
  const sensorsOn = !!entitlements?.features.includes('sensor.esp32') && can('sensor.view');
  const channels = useAllChannels(orgId, sensorsOn);
  const sensors = useMemo<ChannelChoice[] | null>(
    () =>
      sensorsOn
        ? channels.options.map(({ device, channel }) => ({
            sensorDeviceId: device.id,
            channelId: channel.id,
            name: `${device.name} · ${channel.name}`,
            channelName: channel.name,
            unit: channel.unit,
            valueType: channel.valueType,
            min: channel.min,
            max: channel.max,
          }))
        : null,
    [sensorsOn, channels.options],
  );
  const weatherOn = !!entitlements?.features.includes('widget.weather');
  const rssOn = !!entitlements?.features.includes('widget.rss');
  const sources = useDataSources(orgId, weatherOn || rssOn);
  const dataSources = useMemo<WidgetSources['dataSources']>(() => {
    const pick = (type: DataWidgetType) => sources.data.filter((d) => d.type === type).map((d) => ({ id: d.id, name: d.name, type }));
    return { ...(weatherOn ? { weather: pick('weather') } : {}), ...(rssOn ? { rss: pick('rss') } : {}) };
  }, [sources.data, weatherOn, rssOn]);
  return useMemo(() => ({ sensors, dataSources }), [sensors, dataSources]);
}
