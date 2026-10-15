import { beforeEach, describe, expect, it } from 'vitest';
import { BUILT_IN_TEMPLATES, Manifest, layoutFromTemplate, type LayoutBody } from '@wallx-play/layout-spec';
import { paths, type LayoutDoc } from '@wallx-play/shared';
import { handle } from '../../functions/src/api/router';
import * as layouts from '../../functions/src/content/layouts';
import { reviewOrgSignup } from '../../functions/src/orgs/review';
import { submitOrgSignup } from '../../functions/src/orgs/signup';
import * as screens from '../../functions/src/screens/screens';
import { saveSyncGroup } from '../../functions/src/screens/syncGroups';
import { db, deps, expectCode, resetEmulator, superadmin, user } from './helpers';

const alice = user('alice');
let orgId: string;
let screenId: string;

const setFeatures = async (add: string[]) => {
  const ent = (await db.doc(paths.orgEntitlements(orgId)).get()).data()!;
  await db.doc(paths.orgEntitlements(orgId)).update({ features: [...new Set([...(ent.features as string[]), ...add])], 'limits.screens': 10 });
};

/** A one-zone page whose zone is a button doing `action`. */
function page(name: string, label: string, action?: LayoutBody['zones'][number]['action']): LayoutBody {
  const body = layoutFromTemplate(BUILT_IN_TEMPLATES[0]!, name, { width: 1080, height: 1920 });
  body.zones[0]!.content = { kind: 'widget', widget: { type: 'button', label, style: {} } };
  if (action) body.zones[0]!.action = action;
  return body;
}

async function pair(name: string) {
  const reg = await handle(deps, {
    method: 'POST',
    path: '/api/v1/devices/register',
    headers: {},
    ip: '10.0.0.9',
    body: { hardware: { manufacturer: 'X', model: 'Kiosk', androidVersion: '12', sdkInt: 31, appVersion: '0.17.0', display: { width: 1080, height: 1920 } } },
  });
  return (
    await screens.claimDevice(deps, alice, {
      orgId,
      pairingCode: (reg.body as { pairingCode: string }).pairingCode,
      name,
      siteId: null,
      groupIds: [],
      orientation: 'portrait',
      resolution: { width: 1080, height: 1920 },
    })
  ).screenId;
}

const screenInput = (touch: unknown) => ({
  orgId,
  screenId,
  name: 'Kiosk',
  siteId: null,
  groupIds: [],
  orientation: 'portrait' as const,
  resolution: { width: 1080, height: 1920 },
  rotation: 0 as const,
  defaultPlaylistId: null,
  touch: touch as never,
});

beforeEach(async () => {
  await resetEmulator();
  const r = await submitOrgSignup(deps, alice, {
    orgName: 'Acme',
    contactName: 'Asha',
    phone: '+91 98200 12345',
    city: 'Pune',
    stateCode: '27',
    expectedScreens: 2,
    timezone: 'Asia/Kolkata',
  });
  await reviewOrgSignup(deps, superadmin, { requestId: r.requestId, decision: 'approve' });
  orgId = r.orgId;
  screenId = await pair('Kiosk');
});

describe('touch screens', () => {
  it('tap actions and buttons need the plan feature and existing pages', async () => {
    await expectCode(layouts.saveLayout(deps, alice, { orgId, layout: page('Home', 'Menu') }), 'permission-denied');
    await setFeatures(['interactive.touch']);
    const { layoutId: menu } = await layouts.saveLayout(deps, alice, { orgId, layout: page('Menu', 'Back', { kind: 'back' }) });
    await expectCode(layouts.saveLayout(deps, alice, { orgId, layout: page('Home', 'Menu', { kind: 'page', layoutId: 'nope' }) }), 'invalid-argument');
    const { layoutId: home } = await layouts.saveLayout(deps, alice, { orgId, layout: page('Home', 'Menu', { kind: 'page', layoutId: menu }) });
    expect(((await db.doc(paths.layout(orgId, home)).get()).data() as LayoutDoc).layoutIds).toEqual([menu]);
  });

  it('a touch screen gets its home page and the pages taps reach; linked pages cannot be deleted', async () => {
    await setFeatures(['interactive.touch']);
    const { layoutId: details } = await layouts.saveLayout(deps, alice, { orgId, layout: page('Details', 'Home', { kind: 'home' }) });
    const { layoutId: menu } = await layouts.saveLayout(deps, alice, { orgId, layout: page('Menu', 'Details', { kind: 'page', layoutId: details }) });
    const { layoutId: home } = await layouts.saveLayout(deps, alice, { orgId, layout: page('Home', 'Menu', { kind: 'page', layoutId: menu }) });

    await expectCode(screens.updateScreen(deps, alice, screenInput({ homeLayoutId: 'nope', idleSec: 60, attract: true })), 'invalid-argument');
    await screens.updateScreen(deps, alice, screenInput({ homeLayoutId: home, idleSec: 45, attract: true }));
    await screens.publishScreens(deps, alice, { orgId, screenIds: [screenId] });
    const m = Manifest.parse((await db.doc(paths.screenManifest(orgId, screenId)).get()).data());
    expect(m.touch).toEqual({ homeLayoutId: home, idleSec: 45, attract: true });
    expect(m.layouts.map((l) => l.name).sort()).toEqual(['Details', 'Home', 'Menu']);
    expect(m.layouts.find((l) => l.id === home)!.zones[0]!.action).toEqual({ kind: 'page', layoutId: menu });

    await expectCode(layouts.deleteLayout(deps, alice, { orgId, layoutId: menu }), 'failed-precondition'); // Home opens it
    await expectCode(layouts.deleteLayout(deps, alice, { orgId, layoutId: home }), 'failed-precondition'); // the screen's home page

    // Touch off: back to a normal screen.
    await screens.updateScreen(deps, alice, screenInput(null));
    await screens.publishScreens(deps, alice, { orgId, screenIds: [screenId] });
    const plain = Manifest.parse((await db.doc(paths.screenManifest(orgId, screenId)).get()).data());
    expect(plain.touch).toBeNull();
    expect(plain.layouts).toEqual([]);
  });

  it('touch and sync groups do not mix', async () => {
    await setFeatures(['interactive.touch', 'screen.multiSync']);
    const { layoutId: home } = await layouts.saveLayout(deps, alice, { orgId, layout: page('Home', 'Start') });
    const other = await pair('Second');
    const { playlistId } = await layouts.savePlaylist(deps, alice, {
      orgId,
      name: 'Loop',
      items: [{ id: 'i', content: { kind: 'widget', widget: { type: 'text', text: 'Hi', style: {} } }, durationSec: 5, transition: 'none' }],
    });
    await screens.updateScreen(deps, alice, screenInput({ homeLayoutId: home, idleSec: 60, attract: true }));
    await expectCode(
      saveSyncGroup(deps, alice, { orgId, name: 'Pair', mode: 'mirror', playlistId, rows: 1, cols: 1, members: [{ screenId, row: 0, col: 0 }, { screenId: other, row: 0, col: 0 }], enabled: true }),
      'failed-precondition',
    );
  });
});
