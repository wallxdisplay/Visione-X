import { describe, expect, it } from 'vitest';
import type { LayoutDoc, MediaDoc, PlaylistDoc, ScheduleDoc, ScreenDoc } from '@wallx-play/shared';
import { newPairingCode } from '../devices/deviceApi';
import { assembleManifest, targetsScreen } from './manifest';

const meta = { mediaIds: [], playlistIds: [], layoutIds: [], createdBy: 'u', createdAt: 0, updatedBy: 'u', updatedAt: 0 };
const screen = { id: 's1', siteId: 'site1', groupIds: ['g1'], defaultPlaylistId: 'pDefault' } as ScreenDoc;
const schedule = (over: Partial<ScheduleDoc>): ScheduleDoc =>
  ({
    id: 'sch',
    name: 'x',
    playlistId: 'p1',
    target: { kind: 'all' },
    priority: 10,
    timezone: 'Asia/Kolkata',
    startDate: null,
    endDate: null,
    daysOfWeek: [],
    windowStart: null,
    windowEnd: null,
    enabled: true,
    ...over,
  }) as ScheduleDoc;

describe('targetsScreen', () => {
  it('matches all / site / group targets', () => {
    expect(targetsScreen(schedule({}), screen)).toBe(true);
    expect(targetsScreen(schedule({ target: { kind: 'sites', ids: ['site1'] } }), screen)).toBe(true);
    expect(targetsScreen(schedule({ target: { kind: 'sites', ids: ['site2'] } }), screen)).toBe(false);
    expect(targetsScreen(schedule({ target: { kind: 'groups', ids: ['g9', 'g1'] } }), screen)).toBe(true);
  });
});

describe('assembleManifest', () => {
  const ready: MediaDoc = {
    id: 'm1',
    status: 'ready',
    display: { path: 'p', mimeType: 'image/png', bytes: 10, sha256: 'a'.repeat(64) },
  } as MediaDoc;
  const processing = { id: 'm2', status: 'processing' } as MediaDoc;
  const playlists = new Map<string, PlaylistDoc>([
    [
      'p1',
      {
        ...meta,
        id: 'p1',
        name: 'P1',
        totalDurationSec: 20,
        items: [
          { id: 'i1', content: { kind: 'media', mediaId: 'm1' }, durationSec: 10, transition: 'none' },
          { id: 'i2', content: { kind: 'media', mediaId: 'm2' }, durationSec: 10, transition: 'none' },
        ],
      },
    ],
  ]);
  const layouts = new Map<string, LayoutDoc>([
    [
      'l1',
      {
        ...meta,
        id: 'l1',
        specVersion: 1,
        name: 'L',
        canvas: { width: 1920, height: 1080, orientation: 'landscape', background: '#000000' },
        zones: [{ id: 'z', name: 'z', x: 0, y: 0, w: 1, h: 1, z: 0, content: { kind: 'media', mediaId: 'm2', fit: 'cover' } }],
      },
    ],
  ]);

  const manifest = assembleManifest({
    orgId: 'o',
    screen,
    version: 3,
    now: 1,
    schedules: [schedule({}), schedule({ id: 'other', target: { kind: 'groups', ids: ['g9'] } }), schedule({ id: 'off', enabled: false })],
    playlists,
    layouts,
    media: new Map([
      ['m1', ready],
      ['m2', processing],
    ]),
    assetUrls: new Map([['m1', 'https://example.com/m1']]),
  });

  it('keeps only schedules for this screen and drops unknown default playlist', () => {
    expect(manifest.schedules.map((s) => s.id)).toEqual(['sch']);
    expect(manifest.defaultPlaylistId).toBeNull();
    expect(manifest.version).toBe(3);
    expect(manifest.liveChannels).toEqual([]);
  });

  it('never references media that is not downloadable', () => {
    expect(manifest.playlists[0]!.items.map((i) => i.id)).toEqual(['i1']);
    expect(manifest.layouts[0]!.zones[0]!.content).toEqual({ kind: 'empty' });
    expect(manifest.assets).toEqual([
      { mediaId: 'm1', url: 'https://example.com/m1', sha256: 'a'.repeat(64), bytes: 10, mimeType: 'image/png' },
    ]);
  });
});

describe('pairing codes', () => {
  it('use 6 unambiguous characters', () => {
    for (let i = 0; i < 200; i++) expect(newPairingCode()).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);
  });
});
