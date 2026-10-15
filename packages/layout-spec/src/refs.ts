import { DATA_WIDGET_SOURCE, type DataBinding, type LayoutBody, type LiveChannel, type ManifestDataSource, type PlaylistItem, type Widget } from './schema';

/** A sensor channel a widget shows: sensor device id + channel key. */
export interface SensorRef {
  sourceId: string;
  field: string;
}

export interface ContentRefs {
  mediaIds: string[];
  playlistIds: string[];
  layoutIds: string[];
  widgetTypes: Widget['type'][];
  /** Sensor channels bound by widgets (deduplicated). */
  sensors: SensorRef[];
  /** Data sources (weather, RSS, air quality) used by widgets. */
  dataSourceIds: string[];
}

/** The data source a widget shows, if any. */
export function widgetDataSource(widget: Widget): ManifestDataSource | null {
  return widget.type === 'weather' || widget.type === 'rss' || widget.type === 'aqi'
    ? { id: widget.dataSourceId, type: DATA_WIDGET_SOURCE[widget.type] }
    : null;
}

const uniq = <T>(xs: T[]) => [...new Set(xs)];
const refKey = (r: SensorRef) => `${r.sourceId}/${r.field}`;

function uniqRefs(refs: SensorRef[]): SensorRef[] {
  const seen = new Map<string, SensorRef>();
  for (const r of refs) seen.set(refKey(r), { sourceId: r.sourceId, field: r.field });
  return [...seen.values()];
}

/** Bindings of one widget, with the history window a chart needs. */
export function widgetBindings(widget: Widget): Array<{ binding: DataBinding; historyMinutes: number | null }> {
  switch (widget.type) {
    case 'sensorValue':
    case 'gauge':
    case 'status':
      return [{ binding: widget.binding, historyMinutes: null }];
    case 'chart':
      return widget.bindings.map((binding) => ({ binding, historyMinutes: widget.windowMinutes }));
    case 'table':
      return widget.rows.flatMap((row) => row.cells.flatMap((cell) => (typeof cell === 'string' ? [] : [{ binding: cell, historyMinutes: null }])));
    default:
      return [];
  }
}

const sensorRefsOf = (widget: Widget): SensorRef[] =>
  widgetBindings(widget)
    .filter((b) => b.binding.source === 'sensor')
    .map(({ binding }) => ({ sourceId: binding.sourceId, field: binding.field }));

/** Everything a layout points at — stored denormalized so deletes can check usage. */
export function layoutRefs(layout: Pick<LayoutBody, 'zones'>): ContentRefs {
  const mediaIds: string[] = [];
  const playlistIds: string[] = [];
  const widgetTypes: Widget['type'][] = [];
  const sensors: SensorRef[] = [];
  const dataSourceIds: string[] = [];
  const layoutIds: string[] = [];
  for (const zone of layout.zones) {
    if (zone.action?.kind === 'page') layoutIds.push(zone.action.layoutId);
    const c = zone.content;
    if (c.kind === 'media') mediaIds.push(c.mediaId);
    if (c.kind === 'playlist') playlistIds.push(c.playlistId);
    if (c.kind === 'widget') {
      widgetTypes.push(c.widget.type);
      sensors.push(...sensorRefsOf(c.widget));
      const ds = widgetDataSource(c.widget);
      if (ds) dataSourceIds.push(ds.id);
    }
  }
  return {
    mediaIds: uniq(mediaIds),
    playlistIds: uniq(playlistIds),
    /** Pages that tap actions open. */
    layoutIds: uniq(layoutIds),
    widgetTypes: uniq(widgetTypes),
    sensors: uniqRefs(sensors),
    dataSourceIds: uniq(dataSourceIds),
  };
}

export function playlistRefs(items: PlaylistItem[]): ContentRefs {
  const mediaIds: string[] = [];
  const layoutIds: string[] = [];
  const widgetTypes: Widget['type'][] = [];
  const sensors: SensorRef[] = [];
  const dataSourceIds: string[] = [];
  for (const item of items) {
    const c = item.content;
    if (c.kind === 'media') mediaIds.push(c.mediaId);
    if (c.kind === 'layout') layoutIds.push(c.layoutId);
    if (c.kind === 'widget') {
      widgetTypes.push(c.widget.type);
      sensors.push(...sensorRefsOf(c.widget));
      const ds = widgetDataSource(c.widget);
      if (ds) dataSourceIds.push(ds.id);
    }
  }
  return {
    mediaIds: uniq(mediaIds),
    playlistIds: [],
    layoutIds: uniq(layoutIds),
    widgetTypes: uniq(widgetTypes),
    sensors: uniqRefs(sensors),
    dataSourceIds: uniq(dataSourceIds),
  };
}

/**
 * Sensor channels a manifest's content shows. A channel used by several widgets appears once,
 * with the longest chart window any of them needs.
 */
export function liveChannelsOf(
  layouts: Array<Pick<LayoutBody, 'zones'>>,
  playlists: Array<{ items: PlaylistItem[] }>,
): LiveChannel[] {
  const widgets: Widget[] = [
    ...layouts.flatMap((l) => l.zones.flatMap((z) => (z.content.kind === 'widget' ? [z.content.widget] : []))),
    ...playlists.flatMap((p) => p.items.flatMap((i) => (i.content.kind === 'widget' ? [i.content.widget] : []))),
  ];
  const out = new Map<string, LiveChannel>();
  for (const { binding, historyMinutes } of widgets.flatMap(widgetBindings)) {
    if (binding.source !== 'sensor') continue;
    const key = refKey(binding);
    const prev = out.get(key);
    const history = Math.max(prev?.historyMinutes ?? 0, historyMinutes ?? 0) || null;
    out.set(key, { sourceId: binding.sourceId, field: binding.field, historyMinutes: history });
  }
  return [...out.values()].sort((a, b) => refKey(a).localeCompare(refKey(b)));
}

/** Data sources a manifest's content shows (deduplicated, sorted by id). */
export function dataSourcesOf(
  layouts: Array<Pick<LayoutBody, 'zones'>>,
  playlists: Array<{ items: PlaylistItem[] }>,
): ManifestDataSource[] {
  const widgets: Widget[] = [
    ...layouts.flatMap((l) => l.zones.flatMap((z) => (z.content.kind === 'widget' ? [z.content.widget] : []))),
    ...playlists.flatMap((p) => p.items.flatMap((i) => (i.content.kind === 'widget' ? [i.content.widget] : []))),
  ];
  const out = new Map<string, ManifestDataSource>();
  for (const w of widgets) {
    const ds = widgetDataSource(w);
    if (ds) out.set(ds.id, ds);
  }
  return [...out.values()].sort((a, b) => a.id.localeCompare(b.id));
}
