import type { Canvas, LayoutBody, Orientation, Zone } from './schema';

export interface LayoutTemplate {
  id: string;
  /** i18n key suffix: templates.<id> */
  key: string;
  orientation: Orientation;
  zones: Array<Pick<Zone, 'name' | 'x' | 'y' | 'w' | 'h'>>;
}

const EMPTY = { kind: 'empty' as const };

/** Built-in starting points. Zones start empty; the editor fills them. */
export const BUILT_IN_TEMPLATES: LayoutTemplate[] = [
  { id: 'full', key: 'full', orientation: 'landscape', zones: [{ name: 'Main', x: 0, y: 0, w: 1, h: 1 }] },
  {
    id: 'l-bar',
    key: 'lBar',
    orientation: 'landscape',
    zones: [
      { name: 'Main', x: 0, y: 0, w: 0.75, h: 0.85 },
      { name: 'Side', x: 0.75, y: 0, w: 0.25, h: 0.85 },
      { name: 'Ticker', x: 0, y: 0.85, w: 1, h: 0.15 },
    ],
  },
  {
    id: 'split',
    key: 'split',
    orientation: 'landscape',
    zones: [
      { name: 'Left', x: 0, y: 0, w: 0.5, h: 1 },
      { name: 'Right', x: 0.5, y: 0, w: 0.5, h: 1 },
    ],
  },
  {
    id: 'header-main-footer',
    key: 'headerMainFooter',
    orientation: 'landscape',
    zones: [
      { name: 'Header', x: 0, y: 0, w: 1, h: 0.15 },
      { name: 'Main', x: 0, y: 0.15, w: 1, h: 0.7 },
      { name: 'Footer', x: 0, y: 0.85, w: 1, h: 0.15 },
    ],
  },
  { id: 'portrait-full', key: 'portraitFull', orientation: 'portrait', zones: [{ name: 'Main', x: 0, y: 0, w: 1, h: 1 }] },
  {
    id: 'portrait-stack',
    key: 'portraitStack',
    orientation: 'portrait',
    zones: [
      { name: 'Header', x: 0, y: 0, w: 1, h: 0.12 },
      { name: 'Top', x: 0, y: 0.12, w: 1, h: 0.44 },
      { name: 'Bottom', x: 0, y: 0.56, w: 1, h: 0.44 },
    ],
  },
];

export const RESOLUTION_PRESETS: Array<{ id: string; width: number; height: number }> = [
  { id: 'fhd', width: 1920, height: 1080 },
  { id: 'uhd', width: 3840, height: 2160 },
  { id: 'hd', width: 1280, height: 720 },
];

export function layoutFromTemplate(
  template: LayoutTemplate,
  name: string,
  size: { width: number; height: number },
): LayoutBody {
  // Presets are landscape; swap for portrait templates.
  const portrait = template.orientation === 'portrait';
  const canvas: Canvas = {
    width: portrait ? Math.min(size.width, size.height) : Math.max(size.width, size.height),
    height: portrait ? Math.max(size.width, size.height) : Math.min(size.width, size.height),
    orientation: template.orientation,
    background: '#000000',
  };
  return {
    name,
    canvas,
    zones: template.zones.map((z, i) => ({ ...z, id: `z${i + 1}`, z: i, content: EMPTY })),
  };
}
