/**
 * Cost tracking (App store phase 6): the daily usage rollup, staff unit costs and the monthly
 * profitability report. Only usage counts and prices are read — never customer content.
 */
import { logger } from 'firebase-functions/v2';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { FieldPath } from 'firebase-admin/firestore';
import type { z } from 'zod';
import {
  DEFAULT_COST_RATES,
  DRIVER_APP,
  PLATFORM_AUDIT_CHAIN,
  REGION,
  appsBasePriceMinor,
  billLines,
  costBreakdown,
  intervalMonths,
  keyOfDayId,
  normalizeSubscription,
  paths,
  sumUsage,
  usageDayId,
  type AccountDoc,
  type AppDoc,
  type CostDriver,
  type CostRatesDoc,
  type CostReportInput,
  type CostReportResult,
  type CostReportRow,
  type CostUsageDoc,
  type DataSourceDoc,
  type OrgDoc,
  type Plan,
  type SaveCostRatesInput,
  type ScreenDoc,
  type SensorDeviceDoc,
  type SubscriptionDoc,
} from '@wallx-play/shared';
import { getDeps } from '../lib/admin';
import { auditedTransaction, platformAudit } from '../lib/audit';
import { requirePlatform } from '../lib/authz';
import type { Actor, Deps } from '../lib/context';

const DAY = 86_400_000;
/** Days the rollup looks back (counters are kept on docs for USAGE_KEEP_DAYS). */
const ROLLUP_DAYS = 3;
const LIVE_STATUSES = ['active', 'suspended'];

/** One organization's usage on one UTC day, from the counters on its docs. */
export async function rollupOrgDay(deps: Deps, orgId: string, dayId: string, emailsByOrg: Map<string, number>): Promise<CostUsageDoc> {
  const { db, now } = deps;
  const key = keyOfDayId(dayId);
  const [screens, devices, sources, api, usage] = await Promise.all([
    db.collection(paths.screens(orgId)).get(),
    db.collection(paths.sensorDevices(orgId)).get(),
    db.collection(paths.dataSources(orgId)).get(),
    db.doc(paths.apiUsage(orgId, dayId)).get(),
    db.doc(paths.orgUsage(orgId)).get(),
  ]);
  let heartbeats = 0;
  let deliveredBytes = 0;
  let authorized = 0;
  for (const d of screens.docs) {
    const s = d.data() as ScreenDoc;
    if (s.status === 'authorized') authorized++;
    heartbeats += s.usage?.[key]?.beats ?? 0;
    deliveredBytes += s.usage?.[key]?.deliveredBytes ?? 0;
  }
  let sensorRequests = 0;
  let sensorReadings = 0;
  for (const d of devices.docs) {
    const u = (d.data() as SensorDeviceDoc).usage?.[key];
    sensorRequests += u?.requests ?? 0;
    sensorReadings += u?.readings ?? 0;
  }
  let weatherCalls = 0;
  let airQualityCalls = 0;
  for (const d of sources.docs) {
    const ds = d.data() as DataSourceDoc;
    const calls = ds.usage?.[key]?.calls ?? 0;
    if (ds.type === 'weather') weatherCalls += calls;
    if (ds.type === 'air_quality') airQualityCalls += calls;
  }
  const doc: CostUsageDoc = {
    day: dayId,
    orgId,
    screens: authorized,
    heartbeats,
    deliveredBytes,
    storageBytes: Number(usage.get('storageBytes') ?? 0),
    weatherCalls,
    airQualityCalls,
    sensorRequests,
    sensorReadings,
    apiCalls: Number(api.get('calls') ?? 0),
    emails: emailsByOrg.get(orgId) ?? 0,
    computedAt: now(),
  };
  await db.doc(paths.costUsageDay(orgId, dayId)).set(doc);
  return doc;
}

/** Rolls up the last few finished UTC days that have no rollup yet, for every live organization. */
export async function runCostRollup(deps: Deps): Promise<{ orgs: number; days: number }> {
  const { db, now } = deps;
  const today = Date.parse(`${usageDayId(now())}T00:00:00Z`);
  const days = Array.from({ length: ROLLUP_DAYS }, (_, i) => usageDayId(today - (i + 1) * DAY));
  const orgs = (await db.collection(paths.orgs()).where('status', 'in', LIVE_STATUSES).get()).docs;
  let written = 0;
  for (const dayId of days) {
    const start = Date.parse(`${dayId}T00:00:00Z`);
    // Notification emails sent that day, per organization (one query for everyone).
    const mails = await db.collection('mailLog').where('at', '>=', start).where('at', '<', start + DAY).get();
    const emailsByOrg = new Map<string, number>();
    for (const m of mails.docs) emailsByOrg.set(m.get('orgId'), (emailsByOrg.get(m.get('orgId')) ?? 0) + Number(m.get('recipients') ?? 0));
    for (const o of orgs) {
      if ((await db.doc(paths.costUsageDay(o.id, dayId)).get()).exists) continue;
      try {
        await rollupOrgDay(deps, o.id, dayId, emailsByOrg);
        written++;
      } catch (err) {
        logger.error('Cost rollup failed', { orgId: o.id, dayId, err: String(err) });
      }
    }
  }
  return { orgs: orgs.length, days: written };
}

export const costRollupDaily = onSchedule(
  { schedule: '30 6 * * *', region: REGION, timeZone: 'Asia/Kolkata', memory: '512MiB', timeoutSeconds: 540, maxInstances: 1, retryCount: 1 },
  async () => {
    logger.info('Cost rollup', await runCostRollup(getDeps()));
  },
);

/** Staff: the unit costs used by the report. */
export async function saveCostRates({ db, now }: Deps, actor: Actor, input: z.infer<typeof SaveCostRatesInput>): Promise<void> {
  requirePlatform(actor, 'plan.manage');
  const ref = db.doc(paths.costRates());
  await auditedTransaction(db, [PLATFORM_AUDIT_CHAIN], async (tx, audit) => {
    const before = (await tx.get(ref)).data() as CostRatesDoc | undefined;
    const at = now();
    tx.set(ref, { ...input, updatedAt: at, updatedBy: actor.uid });
    audit(PLATFORM_AUDIT_CHAIN, {
      at,
      ...platformAudit(actor),
      orgId: null,
      action: 'platform.costRates.updated',
      target: { type: 'costRates', id: 'costRates' },
      data: { from: before ?? null, to: input },
    });
  });
}

/** Monthly price before GST of a subscription, and how it splits over apps. */
function monthlyRevenue(sub: SubscriptionDoc, plan: Plan | undefined, catalog: AppDoc[], dealerBps: number): { total: number; byApp: Record<string, number> } {
  const trialing = sub.status === 'trialing' && sub.currentPeriodEnd === null;
  if (trialing || sub.amountPerPeriodMinor === null) return { total: 0, byApp: {} };
  const total = Math.round((sub.amountPerPeriodMinor / intervalMonths(sub.interval)) * (1 - dealerBps / 10_000));
  if (sub.pricing !== 'apps' || !plan) return { total, byApp: { plan: total } };
  // Split the period price over the bill lines in proportion (discounts apply to all of them).
  const lines = billLines({
    screens: sub.quantity,
    basePriceMinor: appsBasePriceMinor(plan, catalog.find((a) => a.base), sub.customPriceMinor),
    lines: sub.apps ?? [],
    adjustmentMinor: 0,
    catalog,
  });
  const list = lines.reduce((s, l) => s + l.totalMinor, 0);
  const byApp: Record<string, number> = {};
  for (const l of lines) {
    const id = l.kind === 'base' ? (catalog.find((a) => a.base)?.id ?? 'screen') : (l.appId ?? 'other');
    byApp[id] = (byApp[id] ?? 0) + (list > 0 ? Math.round((l.totalMinor / list) * total) : 0);
  }
  return { total, byApp };
}

/** Staff: revenue against estimated cost per organization and per app for one month. */
export async function costReport({ db, now }: Deps, actor: Actor, input: z.infer<typeof CostReportInput>): Promise<CostReportResult> {
  requirePlatform(actor, 'billing.view');
  const [y, m] = input.month.split('-').map(Number) as [number, number];
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const first = `${input.month}-01`;
  const last = `${input.month}-${String(daysInMonth).padStart(2, '0')}`;
  const [ratesSnap, appsSnap, plansSnap, accountsSnap, orgsSnap] = await Promise.all([
    db.doc(paths.costRates()).get(),
    db.collection(paths.apps()).get(),
    db.collection(paths.plans()).get(),
    db.collection(paths.accounts()).get(),
    db.collection(paths.orgs()).where('status', 'in', LIVE_STATUSES).get(),
  ]);
  const rates: CostRatesDoc = { ...DEFAULT_COST_RATES, ...(ratesSnap.data() as Partial<CostRatesDoc> | undefined) };
  const catalog = appsSnap.docs.map((d) => d.data() as AppDoc);
  const plans = new Map(plansSnap.docs.map((d) => [d.id, d.data() as Plan]));
  const accounts = new Map(accountsSnap.docs.map((d) => [d.id, d.data() as AccountDoc]));

  const rows: CostReportRow[] = [];
  let daysCovered = 0;
  for (const o of orgsSnap.docs) {
    const org = o.data() as OrgDoc;
    const [days, subSnap] = await Promise.all([
      db.collection(paths.costUsage(o.id)).where(FieldPath.documentId(), '>=', first).where(FieldPath.documentId(), '<=', last).get(),
      db.doc(paths.orgSubscription(o.id)).get(),
    ]);
    const usageDays = days.docs.map((d) => d.data() as CostUsageDoc);
    daysCovered = Math.max(daysCovered, usageDays.length);
    const usage = sumUsage(usageDays);
    const cost = costBreakdown(usage, rates, usageDays.length, daysInMonth);
    const costMinor = Object.values(cost).reduce((s, v) => s + v, 0);
    const sub = subSnap.exists ? normalizeSubscription(subSnap.data() as SubscriptionDoc) : null;
    const dealerBps = sub?.billedTo ? (accounts.get(sub.billedTo)?.dealerDiscountBps ?? 0) : 0;
    const revenue = sub ? monthlyRevenue(sub, plans.get(sub.planId), catalog, dealerBps) : { total: 0, byApp: {} };
    rows.push({
      orgId: o.id,
      name: org.name,
      pricing: sub?.pricing === 'apps' ? 'apps' : 'plan',
      status: sub?.status ?? 'none',
      viaReseller: !!sub?.billedTo,
      revenueMinor: revenue.total,
      revenueByApp: revenue.byApp,
      usage,
      cost,
      costMinor,
      projectedCostMinor: usageDays.length ? Math.round((costMinor * daysInMonth) / usageDays.length) : 0,
      daysCovered: usageDays.length,
    });
  }
  rows.sort((a, b) => b.revenueMinor - b.costMinor - (a.revenueMinor - a.costMinor));

  // Per app: revenue from the bill lines, cost from the drivers each app causes (the rest is the base app).
  const baseId = catalog.find((a) => a.base)?.id ?? 'screen';
  const byAppMap = new Map<string, { revenueMinor: number; costMinor: number }>();
  const add = (id: string, revenue: number, cost: number) => {
    const e = byAppMap.get(id) ?? { revenueMinor: 0, costMinor: 0 };
    e.revenueMinor += revenue;
    e.costMinor += cost;
    byAppMap.set(id, e);
  };
  for (const r of rows) {
    for (const [id, v] of Object.entries(r.revenueByApp)) add(id, v, 0);
    for (const [driver, v] of Object.entries(r.cost) as Array<[CostDriver, number]>) add(r.pricing === 'apps' ? (DRIVER_APP[driver] ?? baseId) : 'plan', 0, v);
  }
  const nameOf = (id: string) => (id === 'plan' ? 'Plan pricing' : (catalog.find((a) => a.id === id)?.name ?? id));
  const byApp = [...byAppMap.entries()].map(([appId, v]) => ({ appId, name: nameOf(appId), ...v })).sort((a, b) => b.revenueMinor - a.revenueMinor);

  // Days of the month that have passed (for "so far" vs projected), never more than the month.
  const elapsed = Math.min(daysInMonth, Math.max(0, Math.floor((now() - Date.UTC(y, m - 1, 1)) / DAY)));
  return { month: input.month, daysInMonth, daysCovered: Math.min(daysCovered, elapsed || daysCovered), rates, rows, byApp };
}
