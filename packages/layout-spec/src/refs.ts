import type { LayoutBody, PlaylistItem, Widget } from './schema';

export interface ContentRefs {
  mediaIds: string[];
  playlistIds: string[];
  layoutIds: string[];
  widgetTypes: Widget['type'][];
}

const uniq = <T>(xs: T[]) => [...new Set(xs)];

/** Everything a layout points at — stored denormalized so deletes can check usage. */
export function layoutRefs(layout: Pick<LayoutBody, 'zones'>): ContentRefs {
  const mediaIds: string[] = [];
  const playlistIds: string[] = [];
  const widgetTypes: Widget['type'][] = [];
  for (const zone of layout.zones) {
    const c = zone.content;
    if (c.kind === 'media') mediaIds.push(c.mediaId);
    if (c.kind === 'playlist') playlistIds.push(c.playlistId);
    if (c.kind === 'widget') widgetTypes.push(c.widget.type);
  }
  return { mediaIds: uniq(mediaIds), playlistIds: uniq(playlistIds), layoutIds: [], widgetTypes: uniq(widgetTypes) };
}

export function playlistRefs(items: PlaylistItem[]): ContentRefs {
  const mediaIds: string[] = [];
  const layoutIds: string[] = [];
  const widgetTypes: Widget['type'][] = [];
  for (const item of items) {
    const c = item.content;
    if (c.kind === 'media') mediaIds.push(c.mediaId);
    if (c.kind === 'layout') layoutIds.push(c.layoutId);
    if (c.kind === 'widget') widgetTypes.push(c.widget.type);
  }
  return { mediaIds: uniq(mediaIds), playlistIds: [], layoutIds: uniq(layoutIds), widgetTypes: uniq(widgetTypes) };
}
