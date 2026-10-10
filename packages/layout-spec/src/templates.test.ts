import { describe, expect, it } from 'vitest';
import { layoutRefs, playlistRefs } from './refs';
import { LayoutBody } from './schema';
import { BUILT_IN_TEMPLATES, layoutFromTemplate } from './templates';

describe('templates', () => {
  it('every built-in template produces a valid layout', () => {
    for (const t of BUILT_IN_TEMPLATES) {
      const body = layoutFromTemplate(t, 'Test', { width: 1920, height: 1080 });
      expect(LayoutBody.safeParse(body).success, t.id).toBe(true);
    }
  });

  it('portrait templates get a portrait canvas', () => {
    const t = BUILT_IN_TEMPLATES.find((x) => x.orientation === 'portrait')!;
    const body = layoutFromTemplate(t, 'P', { width: 1920, height: 1080 });
    expect(body.canvas).toMatchObject({ width: 1080, height: 1920, orientation: 'portrait' });
  });
});

describe('schema guards', () => {
  const canvas = { width: 1920, height: 1080, orientation: 'landscape' as const };
  const zone = (id: string, content: object) => ({ id, name: id, x: 0, y: 0, w: 0.5, h: 0.5, z: 0, content });

  it('rejects duplicate zone ids and non-https web widgets', () => {
    expect(LayoutBody.safeParse({ name: 'x', canvas, zones: [zone('a', { kind: 'empty' }), zone('a', { kind: 'empty' })] }).success).toBe(false);
    expect(
      LayoutBody.safeParse({ name: 'x', canvas, zones: [zone('a', { kind: 'widget', widget: { type: 'web', url: 'http://example.com' } })] })
        .success,
    ).toBe(false);
  });

  it('collects references', () => {
    const refs = layoutRefs({
      zones: [
        zone('a', { kind: 'media', mediaId: 'm1', fit: 'cover' }),
        zone('b', { kind: 'playlist', playlistId: 'p1' }),
        zone('c', { kind: 'media', mediaId: 'm1', fit: 'cover' }),
      ] as never,
    });
    expect(refs).toMatchObject({ mediaIds: ['m1'], playlistIds: ['p1'] });
    expect(
      playlistRefs([
        { id: '1', content: { kind: 'layout', layoutId: 'l1' }, durationSec: 5, transition: 'none' },
        { id: '2', content: { kind: 'media', mediaId: 'm2' }, durationSec: 5, transition: 'none' },
      ]),
    ).toMatchObject({ mediaIds: ['m2'], layoutIds: ['l1'] });
  });
});
