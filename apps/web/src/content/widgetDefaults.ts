import type { DataBinding, Widget } from '@wallx-play/layout-spec';
import type { SensorChannelDoc } from '@wallx-play/shared';

export type EditableWidgetType = 'text' | 'clock' | 'qr' | 'table' | 'web' | 'button';

/** Sensible starting configuration for each widget the editor offers. */
export function defaultWidget(type: EditableWidgetType, timezone: string): Widget {
  switch (type) {
    case 'text':
      return { type: 'text', text: 'Your message here', style: { color: '#FFFFFF', fontScale: 0.35, align: 'center', bold: true } };
    case 'clock':
      return { type: 'clock', format: 'time', timezone, seconds: false, style: { color: '#FFFFFF', fontScale: 0.45, align: 'center' } };
    case 'qr':
      return { type: 'qr', value: 'https://example.com', foreground: '#000000', background: '#FFFFFF' };
    case 'table':
      return {
        type: 'table',
        columns: ['Item', 'Price'],
        rows: [{ cells: ['Masala chai', '₹30'] }, { cells: ['Filter coffee', '₹45'] }],
        style: { color: '#FFFFFF', fontScale: 0.08 },
      };
    case 'web':
      return { type: 'web', url: 'https://example.com' };
    case 'button':
      return { type: 'button', label: 'Tap here', style: { color: '#FFFFFF', background: '#4F46E5', bold: true } };
  }
}

export type SensorWidgetType = 'sensorValue' | 'gauge' | 'chart' | 'status';
export const SENSOR_WIDGET_TYPES: SensorWidgetType[] = ['sensorValue', 'gauge', 'chart', 'status'];

export interface ChannelChoice {
  sensorDeviceId: string;
  channelId: string;
  /** "Device · Channel", for pickers. */
  name: string;
  /** Channel name alone, used as the default caption. */
  channelName: string;
  unit: string;
  valueType: SensorChannelDoc['valueType'];
  min: number | null;
  max: number | null;
}

export const bindingFor = (c: Pick<ChannelChoice, 'sensorDeviceId' | 'channelId'>): DataBinding => ({
  source: 'sensor',
  sourceId: c.sensorDeviceId,
  field: c.channelId,
});

/** Starting configuration for a sensor widget showing channel `c`. */
export function defaultSensorWidget(type: SensorWidgetType, c: ChannelChoice): Widget {
  const binding = bindingFor(c);
  const style = { color: '#FFFFFF' };
  switch (type) {
    case 'sensorValue':
      return { type, binding, label: c.channelName, unit: c.unit, thresholds: [], style: { ...style, fontScale: 0.4 } };
    case 'gauge': {
      const min = c.min ?? 0;
      const max = c.max !== null && c.max > min ? c.max : min + 100;
      return { type, binding, label: c.channelName, unit: c.unit, min, max, thresholds: [], style };
    }
    case 'chart':
      return { type, bindings: [binding], label: c.channelName, kind: 'line', windowMinutes: 60, style };
    case 'status':
      return {
        type,
        binding,
        label: c.channelName,
        states:
          c.valueType === 'boolean'
            ? [
                { match: 'on', label: 'Open', color: '#B91C1C' },
                { match: 'off', label: 'Closed', color: '#15803D' },
              ]
            : [{ match: '1', label: 'On', color: '#15803D' }],
        style: { ...style, fontScale: 0.3 },
      };
  }
}

export type DataWidgetType = 'weather' | 'rss' | 'aqi';
export const DATA_WIDGET_TYPES: DataWidgetType[] = ['weather', 'rss', 'aqi'];

/** Starting configuration for a weather, RSS or air quality widget showing data source `id`. */
export function defaultDataWidget(type: DataWidgetType, dataSourceId: string): Widget {
  switch (type) {
    case 'weather':
      return { type, dataSourceId, layout: 'current', style: { color: '#FFFFFF' } };
    case 'aqi':
      return { type, dataSourceId, layout: 'compact', style: { color: '#FFFFFF' } };
    case 'rss':
      return { type, dataSourceId, itemDurationSec: 8, showFeedTitle: true, style: { color: '#FFFFFF', fontScale: 0.14, bold: true } };
  }
}
