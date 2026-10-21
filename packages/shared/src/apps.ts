/**
 * App catalog (App store, phase 1): what WallX sells, priced per app. An app grants existing
 * feature switches (FEATURE_KEYS) and is charged per screen, per organization, per sensor device
 * or per 10 GB of storage. Release status still comes from the feature catalog: an app is as
 * available as the least released of its features.
 *
 * - apps/{appId}: name, description, unit, features, dependencies, price, dealer price — readable
 *   by signed-in users (the App store and the billing pages show prices).
 * - appCosts/{appId}: WallX's estimated cost per unit — platform staff only.
 *
 * Phase 1 only defines the catalog; subscriptions start using it in phase 2.
 */
import { z } from 'zod';
import { FEATURE_KEYS, type FeatureKey, type ReleaseStatus } from './features';

export const APP_UNITS = ['screen', 'organization', 'sensor_device', 'storage_10gb'] as const;
export type AppUnit = (typeof APP_UNITS)[number];

/** Features no app sells (reseller portal is switched on per reseller account). */
export const UNSOLD_FEATURES: readonly FeatureKey[] = ['reseller.portal'];

export interface AppDoc {
  id: string;
  name: string;
  description: string;
  unit: AppUnit;
  /** Feature switches the app turns on. */
  featureKeys: FeatureKey[];
  /** Apps that must be bought too (e.g. MQTT needs Sensors). */
  requires: string[];
  /** Always included with every screen (the base screen app); one per catalog. */
  base: boolean;
  /** Extra limits per unit bought (e.g. +10 GB storage). */
  limitBoosts: { storageGB?: number };
  /** Price per unit per month before GST, in paise. */
  priceMinor: number;
  /**
   * Legacy: the fixed dealer price used to be stored here, where every signed-in user can read it.
   * It now lives in appCosts (staff only); "Load starting catalog" or saving the app moves it.
   */
  dealerPriceMinor?: number | null;
  /** Shown in the store and on bills; inactive apps cannot be bought (existing customers keep them). */
  active: boolean;
  sortOrder: number;
  updatedAt: number;
  updatedBy: string;
}

/** appCosts/{appId} — staff only (resellers get their prices through the partner portal). */
export interface AppCostDoc {
  id: string;
  /** Estimated cost to WallX per unit per month, in paise (from the price sheet). */
  costMinor: number;
  /** Fixed dealer price per unit per month in paise; null / absent = list price less the reseller's discount. */
  dealerPriceMinor?: number | null;
  note: string;
  updatedAt: number;
}

export const AppId = z.string().regex(/^[a-z0-9-]{2,40}$/, 'Use 2–40 lowercase letters, digits or -');

export const SaveAppInput = z
  .object({
    id: AppId,
    isNew: z.boolean(),
    name: z.string().trim().min(2).max(60),
    description: z.string().trim().max(300),
    unit: z.enum(APP_UNITS),
    featureKeys: z.array(z.enum(FEATURE_KEYS)).max(FEATURE_KEYS.length),
    requires: z.array(AppId).max(10),
    base: z.boolean(),
    storageGBPerUnit: z.number().int().min(0).max(10_000).nullable(),
    priceMinor: z.number().int().min(0).max(100_000_000),
    dealerPriceMinor: z.number().int().min(0).max(100_000_000).nullable(),
    costMinor: z.number().int().min(0).max(100_000_000),
    costNote: z.string().trim().max(300).default(''),
    active: z.boolean(),
    sortOrder: z.number().int().min(0).max(1000),
    reason: z.string().trim().min(5, 'Give a reason of at least 5 characters').max(500),
  })
  .refine((a) => !a.base || a.unit === 'screen', { message: 'The base app is charged per screen', path: ['unit'] })
  .refine((a) => !a.requires.includes(a.id), { message: 'An app cannot require itself', path: ['requires'] })
  .refine((a) => a.featureKeys.every((k) => !UNSOLD_FEATURES.includes(k)), { message: 'This feature is not sold as an app', path: ['featureKeys'] })
  .refine((a) => a.dealerPriceMinor === null || a.dealerPriceMinor <= a.priceMinor, { message: 'The dealer price must not exceed the list price', path: ['dealerPriceMinor'] });
export type SaveAppInput = z.infer<typeof SaveAppInput>;

// ---------------------------------------------------------------- pure rules

const RANK: Record<ReleaseStatus, number> = { planned: 0, beta: 1, ga: 2 };

/** An app is as released as its least released feature (planned when it has none). */
export function appReleaseStatus(app: Pick<AppDoc, 'featureKeys'>, catalog: Partial<Record<FeatureKey, ReleaseStatus>>): ReleaseStatus {
  if (app.featureKeys.length === 0) return 'ga';
  return app.featureKeys.map((k) => catalog[k] ?? 'planned').reduce((a, b) => (RANK[a] <= RANK[b] ? a : b));
}

/** Problems with the catalog as a whole (shown to staff; saving refuses the hard ones). */
export function catalogProblems(apps: Array<Pick<AppDoc, 'id' | 'name' | 'featureKeys' | 'requires' | 'base' | 'active'>>): {
  unsold: FeatureKey[];
  duplicated: Array<{ feature: FeatureKey; apps: string[] }>;
  missingRequires: Array<{ app: string; requires: string }>;
  cycles: string[];
  baseCount: number;
} {
  const owners = new Map<FeatureKey, string[]>();
  for (const a of apps) for (const k of a.featureKeys) owners.set(k, [...(owners.get(k) ?? []), a.id]);
  const ids = new Set(apps.map((a) => a.id));
  const byId = new Map(apps.map((a) => [a.id, a]));
  const cycles: string[] = [];
  for (const a of apps) {
    // Walk the requirement graph from each app; meeting it again is a cycle.
    const seen = new Set<string>();
    const stack = [...a.requires];
    while (stack.length) {
      const next = stack.pop()!;
      if (next === a.id) {
        cycles.push(a.id);
        break;
      }
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push(...(byId.get(next)?.requires ?? []));
    }
  }
  return {
    unsold: FEATURE_KEYS.filter((k) => !owners.has(k) && !UNSOLD_FEATURES.includes(k)),
    duplicated: [...owners.entries()].filter(([, a]) => a.length > 1).map(([feature, a]) => ({ feature, apps: a })),
    missingRequires: apps.flatMap((a) => a.requires.filter((r) => !ids.has(r)).map((r) => ({ app: a.id, requires: r }))),
    cycles,
    baseCount: apps.filter((a) => a.base).length,
  };
}

/** Dealer price per unit: the fixed one, else list price less the reseller's discount. */
export function appDealerPriceMinor(app: Pick<AppDoc, 'priceMinor' | 'dealerPriceMinor'>, dealerDiscountBps: number): number {
  return app.dealerPriceMinor ?? Math.round((app.priceMinor * (10_000 - dealerDiscountBps)) / 10_000);
}

// ---------------------------------------------------------------- bill lines (phase 2)

/** How a subscription is priced: by its plan (as before), or by apps (bill lines). */
export const PRICING_MODES = ['plan', 'apps'] as const;
export type PricingMode = (typeof PRICING_MODES)[number];

/** An app bought by an organization; the unit price is locked when the line is added. */
export interface AppLine {
  appId: string;
  quantity: number;
  unitPriceMinor: number;
  addedAt: number;
}

/** One line of a monthly bill (before the annual / extra discounts and GST). */
export interface BillLine {
  kind: 'base' | 'app' | 'adjustment';
  appId: string | null;
  name: string;
  unit: AppUnit | null;
  quantity: number;
  unitPriceMinor: number;
  totalMinor: number;
}

/** Base price per screen in app pricing: a deal price, else the plan's base price, else the Screen app's. */
export function appsBasePriceMinor(
  plan: { appsBasePriceMinor?: number | null; pricePerScreenMonthlyMinor: number | null },
  baseApp: Pick<AppDoc, 'priceMinor'> | undefined,
  customPriceMinor: number | null,
): number {
  return customPriceMinor ?? plan.appsBasePriceMinor ?? baseApp?.priceMinor ?? plan.pricePerScreenMonthlyMinor ?? 0;
}

/** Monthly bill lines of an app-priced subscription. Unknown apps keep their locked price and id. */
export function billLines(input: {
  screens: number;
  basePriceMinor: number;
  lines: AppLine[];
  adjustmentMinor: number;
  catalog: Array<Pick<AppDoc, 'id' | 'name' | 'unit' | 'base' | 'sortOrder'>>;
}): BillLine[] {
  const base = input.catalog.find((a) => a.base);
  const byId = new Map(input.catalog.map((a) => [a.id, a]));
  const out: BillLine[] = [
    { kind: 'base', appId: base?.id ?? null, name: base?.name ?? 'Screen', unit: 'screen', quantity: input.screens, unitPriceMinor: input.basePriceMinor, totalMinor: input.screens * input.basePriceMinor },
  ];
  const lines = [...input.lines].filter((l) => l.quantity > 0).sort((a, b) => (byId.get(a.appId)?.sortOrder ?? 999) - (byId.get(b.appId)?.sortOrder ?? 999));
  for (const l of lines) {
    const app = byId.get(l.appId);
    out.push({ kind: 'app', appId: l.appId, name: app?.name ?? l.appId, unit: app?.unit ?? null, quantity: l.quantity, unitPriceMinor: l.unitPriceMinor, totalMinor: l.quantity * l.unitPriceMinor });
  }
  if (input.adjustmentMinor) {
    out.push({ kind: 'adjustment', appId: null, name: 'Adjustment', unit: null, quantity: 1, unitPriceMinor: input.adjustmentMinor, totalMinor: input.adjustmentMinor });
  }
  return out;
}

export const billTotalMinor = (lines: BillLine[]) => Math.max(0, lines.reduce((s, l) => s + l.totalMinor, 0));

/**
 * What an app-priced organization may use: the base app, the apps it owns (quantity > 0) and,
 * during its trial, every app on sale (decision: all apps free in the trial). Also the extra
 * storage and the sensor devices it bought.
 */
export function resolveAppFeatures(input: {
  catalog: Array<Pick<AppDoc, 'id' | 'featureKeys' | 'base' | 'active' | 'unit' | 'limitBoosts'>>;
  lines: Array<Pick<AppLine, 'appId' | 'quantity'>>;
  trialing: boolean;
}): { features: FeatureKey[]; storageGB: number; sensorDevices: number } {
  const byId = new Map(input.catalog.map((a) => [a.id, a]));
  const owned = input.lines.filter((l) => l.quantity > 0).map((l) => ({ app: byId.get(l.appId), quantity: l.quantity })).filter((o) => !!o.app);
  const features = new Set<FeatureKey>();
  for (const a of input.catalog) if (a.base || (input.trialing && a.active)) a.featureKeys.forEach((k) => features.add(k));
  for (const o of owned) o.app!.featureKeys.forEach((k) => features.add(k));
  const storageGB = owned.reduce((s, o) => s + (o.app!.limitBoosts.storageGB ?? 0) * o.quantity, 0);
  const devices = owned.filter((o) => o.app!.unit === 'sensor_device').reduce((s, o) => s + o.quantity, 0);
  return { features: [...features].sort(), storageGB, sensorDevices: devices };
}

/**
 * Lines that give a plan-priced organization the same features in app pricing (migration):
 * per-screen apps for every screen, organization apps once, sensors for the devices it has.
 */
export function linesForPlanFeatures(
  planFeatures: readonly FeatureKey[],
  catalog: Array<Pick<AppDoc, 'id' | 'featureKeys' | 'base' | 'active' | 'unit' | 'priceMinor'>>,
  screens: number,
  sensorDevices: number,
  at: number,
): AppLine[] {
  const want = new Set(planFeatures);
  return catalog
    .filter((a) => !a.base && a.featureKeys.length > 0 && a.featureKeys.some((k) => want.has(k)))
    .map((a) => ({
      appId: a.id,
      quantity: a.unit === 'screen' ? screens : a.unit === 'sensor_device' ? sensorDevices : a.unit === 'organization' ? 1 : 0,
      unitPriceMinor: a.priceMinor,
      addedAt: at,
    }))
    .filter((l) => l.quantity > 0);
}

/** Problems with requested lines (for staff, resellers and later the customer's App store). */
export function lineProblems(
  lines: Array<Pick<AppLine, 'appId' | 'quantity'>>,
  catalog: Array<Pick<AppDoc, 'id' | 'name' | 'unit' | 'base' | 'requires' | 'active'>>,
  screens: number,
  owned: string[] = [],
): string[] {
  const byId = new Map(catalog.map((a) => [a.id, a]));
  const has = new Set(lines.filter((l) => l.quantity > 0).map((l) => l.appId));
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const l of lines) {
    const app = byId.get(l.appId);
    if (seen.has(l.appId)) problems.push(`${l.appId} is listed twice.`);
    seen.add(l.appId);
    if (!app) {
      problems.push(`App “${l.appId}” does not exist.`);
      continue;
    }
    if (app.base) problems.push(`${app.name} is included with every screen.`);
    if (!app.active && !owned.includes(app.id) && l.quantity > 0) problems.push(`${app.name} is not sold any more.`);
    if (app.unit === 'organization' && l.quantity > 1) problems.push(`${app.name} is bought once per organization.`);
    if (app.unit === 'screen' && l.quantity > screens) problems.push(`${app.name}: at most ${screens} screens.`);
    if (l.quantity > 0) for (const r of app.requires) if (!has.has(r)) problems.push(`${app.name} needs ${byId.get(r)?.name ?? r}.`);
  }
  return problems;
}

// ---------------------------------------------------------------- apps per screen (phase 3)

/** Widgets that only run on screens that have the app selling this feature. */
export const WIDGET_SCREEN_FEATURES: Readonly<Record<string, FeatureKey>> = {
  weather: 'widget.weather',
  aqi: 'widget.weather',
  rss: 'widget.rss',
  button: 'interactive.touch',
};

export interface ScreenSeatInput {
  id: string;
  name: string;
  /** Only authorized screens hold app seats. */
  authorized: boolean;
  apps: string[];
}

/**
 * Who holds which per-screen app seat, and which features each screen may not use.
 *
 * - Plan pricing, or app pricing during the trial: nothing is blocked (seats are left as they are).
 * - App pricing: each screen app is on as many authorized screens as were bought. Free seats go
 *   to screens without the app (by name), extra holders lose it (last by name); apps no longer
 *   bought are removed. A screen may not use the features of screen apps it does not hold,
 *   unless WallX granted the feature to the organization (an override).
 */
export function planScreenApps(input: {
  appPricing: boolean;
  trialing: boolean;
  catalog: Array<Pick<AppDoc, 'id' | 'unit' | 'featureKeys' | 'base'>>;
  lines: Array<Pick<AppLine, 'appId' | 'quantity'>>;
  screens: ScreenSeatInput[];
  grants: readonly FeatureKey[];
}): Map<string, { apps: string[]; blocked: FeatureKey[] }> {
  const out = new Map(input.screens.map((s) => [s.id, { apps: [...s.apps], blocked: [] as FeatureKey[] }]));
  if (!input.appPricing || input.trialing) return out;
  // The base app (Screen) comes with every screen; it is not placed screen by screen.
  const screenApps = input.catalog.filter((a) => a.unit === 'screen' && !a.base);
  const owned = new Map(input.lines.filter((l) => l.quantity > 0 && screenApps.some((a) => a.id === l.appId)).map((l) => [l.appId, l.quantity]));
  const ordered = [...input.screens].filter((s) => s.authorized).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  // Apps no longer bought, and any app on a screen that is not authorized, are dropped.
  for (const s of input.screens) out.get(s.id)!.apps = s.authorized ? s.apps.filter((a) => owned.has(a)) : [];
  for (const [appId, quantity] of owned) {
    const holders = ordered.filter((s) => out.get(s.id)!.apps.includes(appId));
    for (const s of holders.slice(quantity)) out.get(s.id)!.apps = out.get(s.id)!.apps.filter((a) => a !== appId);
    let free = quantity - Math.min(holders.length, quantity);
    for (const s of ordered) {
      if (free <= 0) break;
      const entry = out.get(s.id)!;
      if (!entry.apps.includes(appId)) {
        entry.apps = [...entry.apps, appId];
        free--;
      }
    }
  }
  const sold = new Set(screenApps.flatMap((a) => a.featureKeys));
  for (const s of input.screens) {
    const entry = out.get(s.id)!;
    const allowed = new Set(screenApps.filter((a) => entry.apps.includes(a.id)).flatMap((a) => a.featureKeys));
    entry.apps.sort();
    entry.blocked = [...sold].filter((k) => !allowed.has(k) && !input.grants.includes(k)).sort();
  }
  return out;
}

/** Put a screen app on exactly these screens (free seats are then filled automatically). */
export const SetAppScreensInput = z.object({
  orgId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
  appId: AppId,
  screenIds: z.array(z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/)).max(2000),
});

// ---------------------------------------------------------------- self-service App store (phase 4)

/** One item a customer changes: the base screens ("screens") or an app. */
export interface AppChangeItem {
  item: string;
  from: number;
  to: number;
}

/** A prorated charge for screens or apps added mid-period, collected with the next payment. */
export interface PendingCharge {
  at: number;
  amountMinor: number;
  items: AppChangeItem[];
  /** Share of the paid period that was left, in basis points. */
  periodLeftBps: number;
  by: string;
}

/** Reductions that take effect when the paid period ends (no refunds). */
export interface ScheduledAppChange {
  /** Screens from then on (absent = unchanged). */
  screens?: number;
  /** New quantity per app (0 = removed). */
  apps: Array<{ appId: string; quantity: number }>;
  effectiveAt: number;
  requestedBy: string;
  requestedAt: number;
}

export interface AppState {
  screens: number;
  lines: Array<{ appId: string; quantity: number }>;
}

const qtyOf = (s: AppState, appId: string) => s.lines.find((l) => l.appId === appId)?.quantity ?? 0;

/** What the customer will have once a scheduled change applies (or now, without one). */
export function stateAfter(current: AppState, scheduled: Pick<ScheduledAppChange, 'screens' | 'apps'> | null | undefined): AppState {
  if (!scheduled) return current;
  const lines = current.lines
    .map((l) => ({ ...l, quantity: scheduled.apps.find((a) => a.appId === l.appId)?.quantity ?? l.quantity }))
    .filter((l) => l.quantity > 0);
  return { screens: scheduled.screens ?? current.screens, lines };
}

/**
 * Splits what the customer wants into what changes now and what changes at the end of the paid
 * period. In the trial, or with no paid period running, everything changes now. Otherwise
 * increases are now (charged pro rata with the next payment) and decreases at period end.
 */
export function planAppChange(
  current: AppState,
  wanted: AppState,
  immediate: boolean,
): { now: AppState; later: Pick<ScheduledAppChange, 'screens' | 'apps'> | null; increases: AppChangeItem[]; decreases: AppChangeItem[] } {
  const ids = [...new Set([...current.lines, ...wanted.lines].map((l) => l.appId))];
  const items: AppChangeItem[] = [
    { item: 'screens', from: current.screens, to: wanted.screens },
    ...ids.map((id) => ({ item: id, from: qtyOf(current, id), to: qtyOf(wanted, id) })),
  ].filter((i) => i.from !== i.to);
  const increases = items.filter((i) => i.to > i.from);
  const decreases = items.filter((i) => i.to < i.from);
  if (immediate) return { now: { screens: wanted.screens, lines: wanted.lines.filter((l) => l.quantity > 0) }, later: null, increases, decreases };
  const now: AppState = {
    screens: Math.max(current.screens, wanted.screens),
    lines: ids.map((id) => ({ appId: id, quantity: Math.max(qtyOf(current, id), qtyOf(wanted, id)) })).filter((l) => l.quantity > 0),
  };
  const screensDown = decreases.find((d) => d.item === 'screens');
  const appsDown = decreases.filter((d) => d.item !== 'screens').map((d) => ({ appId: d.item, quantity: d.to }));
  const later = decreases.length ? { ...(screensDown ? { screens: screensDown.to } : {}), apps: appsDown } : null;
  return { now, later, increases, decreases };
}

/** Share of the paid period left at `at`, in basis points (0 when no period is running). */
export function periodLeftBps(start: number | null, end: number | null, at: number): number {
  if (start === null || end === null || end <= start || at >= end) return 0;
  return Math.round((Math.min(end - at, end - start) / (end - start)) * 10_000);
}

/** Owner: change screens and apps (App store). With `apply: false` only returns the preview. */
export const ChangeAppsInput = z.object({
  orgId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
  screens: z.number().int().min(1).max(100_000),
  apps: z.array(z.object({ appId: AppId, quantity: z.number().int().min(0).max(100_000) })).max(30),
  apply: z.boolean(),
});

export interface ChangeAppsResult {
  applied: boolean;
  increases: AppChangeItem[];
  decreases: AppChangeItem[];
  /** Price per billing period now, after this change, and once reductions apply. */
  beforeMinor: number | null;
  nowMinor: number | null;
  laterMinor: number | null;
  /** Prorated amount added to the next payment. */
  chargeMinor: number;
  periodLeftBps: number;
  /** When reductions apply (null: none, or all now). */
  effectiveAt: number | null;
  trialing: boolean;
}
