/**
 * White label (packages/shared/src/branding.ts): resellers' and organizations' brands, their
 * custom web addresses (public brandDomains lookup) and the brand players fetch.
 */
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import type { z } from 'zod';
import {
  PLATFORM_AUDIT_CHAIN,
  effectiveBrand,
  hasPlatformPermission,
  paths,
  publicBrand,
  type AccountDoc,
  type AccountMemberDoc,
  type Brand,
  type BrandDomainDoc,
  type BrandPublic,
  type BrandTarget,
  type DeviceDoc,
  type EntitlementsDoc,
  type OrgDoc,
  type SaveBrandInput,
  type SetBrandDomainsInput,
} from '@wallx-play/shared';
import { syncAccountOrgs } from '../accounts/partners';
import type { ApiRequest, ApiResult } from '../devices/deviceApi';
import { authenticate } from '../devices/deviceApi';
import { auditedTransaction, platformAudit } from '../lib/audit';
import { requireOrgPermission, requirePlatform } from '../lib/authz';
import type { Actor, Deps } from '../lib/context';
import { readEntitlements, requireFeature } from '../lib/entitlements';
import type { MailBrand } from '../lib/email';

const userAudit = (actor: Actor) => ({ actorType: 'user' as const, actorId: actor.uid, ...(actor.email ? { actorEmail: actor.email } : {}) });

const targetRef = (db: Firestore, t: BrandTarget) => db.doc(t.kind === 'org' ? paths.org(t.orgId) : paths.account(t.accountId));
const targetId = (t: BrandTarget) => (t.kind === 'org' ? t.orgId : t.accountId);

/** Rewrites (or removes) the public lookup docs of a brand's domains. Reads must come first. */
function writeDomainDocs(tx: Transaction, db: Firestore, target: BrandTarget, brand: Brand | null, before: string[], at: number) {
  const next = brand?.domains ?? [];
  for (const host of before) if (!next.includes(host)) tx.delete(db.doc(paths.brandDomain(host)));
  if (!brand) return;
  for (const host of next) {
    const doc: BrandDomainDoc = { hostname: host, owner: { kind: target.kind, id: targetId(target) }, brand: publicBrand(brand), updatedAt: at };
    tx.set(db.doc(paths.brandDomain(host)), doc);
  }
}

/** A reseller's owner (or WallX staff) sets the reseller's brand; an org's owner/admin its own. */
export async function saveBrand(deps: Deps, actor: Actor, input: z.infer<typeof SaveBrandInput>): Promise<void> {
  const { db, now } = deps;
  const t = input.target;
  const chain = t.kind === 'org' ? t.orgId : PLATFORM_AUDIT_CHAIN;
  await auditedTransaction(db, [chain], async (tx, audit) => {
    const ref = targetRef(db, t);
    let before: Brand | null = null;
    if (t.kind === 'org') {
      await requireOrgPermission(tx, db, actor, t.orgId, 'org.settings.edit');
      const org = (await tx.get(ref)).data() as OrgDoc | undefined;
      if (!org) throw new HttpsError('not-found', 'Organization not found.');
      if (input.brand) requireFeature(await readEntitlements(tx, db, t.orgId), 'branding.whiteLabel', 'White label');
      before = org.brand ?? null;
    } else {
      const account = (await tx.get(ref)).data() as AccountDoc | undefined;
      if (!account) throw new HttpsError('not-found', 'Reseller account not found.');
      if (!hasPlatformPermission(actor.platformRole, 'account.manage')) {
        const member = (await tx.get(db.doc(paths.accountMember(t.accountId, actor.uid)))).data() as AccountMemberDoc | undefined;
        if (member?.role !== 'owner' || account.status !== 'active' || account.portal !== true) {
          throw new HttpsError('permission-denied', 'Only the reseller’s owners can change its brand.');
        }
      }
      if (input.brand && !account.whiteLabel) throw new HttpsError('failed-precondition', 'White label is not switched on for this reseller. Contact WallX.');
      before = account.brand ?? null;
    }
    const at = now();
    const brand: Brand | null = input.brand ? { ...input.brand, supportEmail: input.brand.supportEmail ?? '', supportPhone: input.brand.supportPhone ?? '', website: input.brand.website ?? '', domains: before?.domains ?? [], updatedAt: at } : null;
    tx.update(ref, { brand, updatedAt: at });
    writeDomainDocs(tx, db, t, brand, before?.domains ?? [], at);
    audit(chain, {
      at,
      ...(actor.platformRole ? platformAudit(actor) : userAudit(actor)),
      orgId: t.kind === 'org' ? t.orgId : null,
      action: brand ? 'brand.saved' : 'brand.removed',
      target: { type: t.kind === 'org' ? 'org' : 'account', id: targetId(t) },
      // Not the logo itself (large); whether there is one.
      data: brand ? { name: brand.name, primaryColor: brand.primaryColor, logo: !!brand.logo } : {},
    });
  });
  // A reseller's brand reaches its customers through their partnerBrand copy.
  if (t.kind === 'account') await syncAccountOrgs(deps, t.accountId);
}

/** WallX staff: the custom web addresses of a brand (they also add them in Firebase Hosting). */
export async function setBrandDomains(deps: Deps, actor: Actor, input: z.infer<typeof SetBrandDomainsInput>): Promise<void> {
  const { db, now } = deps;
  const t = input.target;
  requirePlatform(actor, t.kind === 'org' ? 'org.limits.edit' : 'account.manage');
  const domains = [...new Set(input.domains)];
  await auditedTransaction(db, [PLATFORM_AUDIT_CHAIN], async (tx, audit) => {
    const ref = targetRef(db, t);
    const doc = (await tx.get(ref)).data() as { brand?: Brand | null } | undefined;
    if (!doc) throw new HttpsError('not-found', t.kind === 'org' ? 'Organization not found.' : 'Reseller account not found.');
    if (!doc.brand) throw new HttpsError('failed-precondition', 'Set up the brand first.');
    const taken = await Promise.all(domains.map((h) => tx.get(db.doc(paths.brandDomain(h)))));
    for (const s of taken) {
      const owner = (s.data() as BrandDomainDoc | undefined)?.owner;
      if (owner && (owner.kind !== t.kind || owner.id !== targetId(t))) throw new HttpsError('already-exists', `${s.id} is already used by another brand.`);
    }
    const at = now();
    const brand: Brand = { ...doc.brand, domains };
    tx.update(ref, { brand, updatedAt: at });
    writeDomainDocs(tx, db, t, brand, doc.brand.domains ?? [], at);
    audit(PLATFORM_AUDIT_CHAIN, {
      at,
      ...platformAudit(actor),
      orgId: t.kind === 'org' ? t.orgId : null,
      action: 'brand.domains.set',
      target: { type: t.kind === 'org' ? 'org' : 'account', id: targetId(t) },
      data: { from: doc.brand.domains ?? [], to: domains },
    });
  });
  // Customers' copies carry the address (links in their emails).
  if (t.kind === 'account') await syncAccountOrgs(deps, t.accountId);
}

/** The brand an organization's screens and members see (null = WallX Play). */
export async function orgBrand(db: Firestore, orgId: string): Promise<BrandPublic | null> {
  const [org, ent] = await db.getAll(db.doc(paths.org(orgId)), db.doc(paths.orgEntitlements(orgId)));
  const o = org?.data() as OrgDoc | undefined;
  return o ? effectiveBrand(o, ent?.data() as EntitlementsDoc | undefined) : null;
}

/** For emails about an organization: its brand's name, colour and web address. */
export async function orgMailBrand(db: Firestore, orgId: string): Promise<MailBrand | undefined> {
  const b = await orgBrand(db, orgId);
  return b ? { name: b.name, color: b.primaryColor, appUrl: b.appUrl } : undefined;
}

/** For emails from a reseller (team invitations, its customers' owner invitations). */
export function accountMailBrand(account: AccountDoc): MailBrand | undefined {
  if (!account.whiteLabel || !account.brand) return undefined;
  const b = publicBrand(account.brand);
  return { name: b.name, color: b.primaryColor, appUrl: b.appUrl };
}

/** GET /api/v1/devices/brand — the screen's brand (null: WallX Play). */
export async function deviceBrand(deps: Deps, req: ApiRequest): Promise<ApiResult> {
  const auth = await authenticate(deps, req);
  if ('status' in auth && 'body' in auth) return auth;
  const device = auth as DeviceDoc;
  if (device.status !== 'authorized' || !device.orgId) return { status: 403, body: { error: 'not_authorized', message: 'This player is not authorized yet.' } };
  return { status: 200, body: { brand: await orgBrand(deps.db, device.orgId), serverTime: deps.now() } };
}
