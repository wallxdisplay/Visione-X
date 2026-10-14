import { describe, expect, it } from 'vitest';
import { Layout, SPEC_VERSION, Widget, dataSourcesOf, widgetDataSource } from './index';

const base = {
  specVersion: SPEC_VERSION,
  id: 'l1',
  name: 'Lobby',
  canvas: { width: 1920, height: 1080, orientation: 'landscape' as const },
};

describe('Layout', () => {
  it('accepts a Devanagari text widget zone', () => {
    const result = Layout.safeParse({
      ...base,
      zones: [
        {
          id: 'z1',
          name: 'Header',
          x: 0,
          y: 0,
          w: 1,
          h: 0.2,
          z: 0,
          content: { kind: 'widget', widget: { type: 'text', text: 'स्वागत आहे', style: {} } },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects zones that overflow the canvas', () => {
    const result = Layout.safeParse({
      ...base,
      zones: [
        {
          id: 'z1',
          name: 'Too wide',
          x: 0.5,
          y: 0,
          w: 0.6,
          h: 1,
          z: 0,
          content: { kind: 'media', mediaId: 'm1', fit: 'cover' },
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});

describe('data widgets', () => {
  it('map the air quality widget to its data source type and default to the compact layout', () => {
    const aqi = Widget.parse({ type: 'aqi', dataSourceId: 'a1', style: {} });
    expect(aqi).toMatchObject({ type: 'aqi', layout: 'compact' });
    expect(widgetDataSource(aqi)).toEqual({ id: 'a1', type: 'air_quality' });
    const zone = (id: string, widget: unknown) => ({ id, name: id, x: 0, y: 0, w: 1, h: 1, z: 0, content: { kind: 'widget', widget } });
    const layout = Layout.parse({ ...base, zones: [zone('z1', aqi), zone('z2', { type: 'weather', dataSourceId: 'w1', style: {} })] });
    expect(dataSourcesOf([layout], [])).toEqual([
      { id: 'a1', type: 'air_quality' },
      { id: 'w1', type: 'weather' },
    ]);
    expect(Widget.safeParse({ type: 'aqi', dataSourceId: 'a1', layout: 'forecast', style: {} }).success).toBe(false);
  });
});
