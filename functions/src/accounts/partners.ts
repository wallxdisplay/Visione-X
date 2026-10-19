/**
 * Reseller partner portal (packages/shared/src/accounts.ts): the reseller's team, its customer
 * organizations (created, given a plan and screens, billed wholesale) and the partner member
 * records that let its staff manage those customers.
 */
import { randomBytes } from 'node:crypto';
import { FieldValue, type Firestore, type Transaction } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import type { z } from 'zod';
import {
  INVITE_TTL_DAYS,
  PARTNER_TRIAL_DAYS,
  PLATFORM_AUDIT_CHAIN,
  PRODUCT_NAME,
  SYSTEM_ORG_ROLE_PERMISSIONS,
  accountBillingStatus,
  dealerPriceMinor,
  hasPlatformPermission,
  isScreenOnline,
  billTotalMinor,
  normalizeSubscription,
  paths,
  publicBrand,
  type AppDoc,
  type BillLine,
  type AccountDoc,
  type AccountInviteDoc,
  type AccountInviteRefInput,
  type AccountMemberDoc,
  type AccountMemberRefInput,
  type AccountRole,
  type CreatePartnerOrgInput,
  type InviteAccountMemberInput,
  type InviteDoc,
  type MemberDoc,
  type OrgDoc,
  type PartnerCustomer,
  type PartnerOrgRefInput,
  type PartnerOverview,
  type PartnerOverviewInput,
  type Plan,
  type ScreenDoc,
  type SetPartnerAccessInput,
  type SetPartnerSubscriptionInput,
  type SubscriptionDoc,
  type UserAccountMembership,
} from '@wallx-play/shared';
import { afterSeats, checkLines, notifyStatusChange, priceLines, readAppCatalog, subscriptionAmount, subscriptionLines, trialEntitlements, trialSubscription, writeSubscription } from '../billing/billing';
import { entitlementsForSub } from '../lib/entitlements';
import { auditedTransaction, platformAudit } from '../lib/audit';
import { getOrg, requireOrgPermission, requireVerifiedEmail } from '../lib/authz';
import type { Actor, Deps } from '../lib/context';
import { mailAppUrl, mailProduct, sendMail } from '../lib/email';
import { accountMailBrand } from '../branding/branding';
import { readMembers, setMembership } from '../lib/profiles';
import { hashToken } from '../members/members';

const DAY_MS = 86_400_000;
const userAudit = (actor: Actor) => ({ actorType: 'user' as const, actorId: actor.uid, ...(actor.email ? { actorEmail: actor.email } : {}) });

// ---------------------------------------------------------------- helpers

export async function readAccount(tx: Transaction, db: Firestore, accountId: string): Promise<AccountDoc> {
  const account = (await tx.get(db.doc(paths.account(accountId)))).data() as AccountDoc | undefined;
  if (!account) throw new HttpsError('not-found', 'Reseller account not found.');
  return account;
}

const portalOpen = (a: AccountDoc) => a.status === 'active' && a.portal === true;

/**
 * The caller works for the reseller (an `owner` when `role` is owner). WallX staff who manage
 * accounts may act too (setting up a reseller). Returns the member record (null for staff).
 */
async function requirePartner(tx: Transaction, db: Firestore, actor: Actor, accountId: string, role?: AccountRole): Promise<{ account: AccountDoc; member: AccountMemberDoc | null }> {
  const account = await readAccount(tx, db, accountId);
  const staff = hasPlatformPermission(actor.platformRole, 'account.manage');
  const member = (await tx.get(db.doc(paths.accountMember(accountId, actor.uid)))).data() as AccountMemberDoc | undefined;
  if (!member && !staff) throw new HttpsError('permission-denied', 'You are not on this reseller’s team.');
  if (member && !staff) {
    if (!portalOpen(account)) throw new HttpsError('failed-precondition', 'The partner portal is not available for this reseller. Contact WallX.');
    if (role === 'owner' && member.role !== 'owner') throw new HttpsError('permission-denied', 'Only the reseller’s owners can do this.');
  }
  return { account, member: member ?? null };
}

function setAccountMembership(tx: Transaction, db: Firestore, args: { uid: string; email: string; accountId: string; membership: UserAccountMembership | null; now: number }) {
  tx.set(
    db.doc(paths.userProfile(args.uid)),
    { uid: args.uid, email: args.email, accounts: { [args.accountId]: args.membership ?? FieldValue.delete() }, updatedAt: args.now },
    { merge: true },
  );
}

const accountEntry = (account: AccountDoc, role: AccountRole): UserAccountMembership => ({ name: account.name, role, status: account.status, portal: account.portal === true });

/** Rewrites every member's profile entry for the account (name, status or portal changed). */
export async function fanOutAccountToProfiles({ db, now }: Deps, accountId: string): Promise<void> {
  await db.runTransaction(async (tx) => {
    const account = await readAccount(tx, db, accountId);
    const members = (await tx.get(db.collection(paths.accountMembers(accountId)))).docs.map((d) => d.data() as AccountMemberDoc);
    for (const m of members) setAccountMembership(tx, db, { uid: m.uid, email: m.email, accountId, membership: accountEntry(account, m.role), now: now() });
  });
}

const partnerMember = (m: AccountMemberDoc, accountId: string, at: number): MemberDoc => ({
  uid: m.uid,
  email: m.email,
  role: 'admin',
  permissions: [...SYSTEM_ORG_ROLE_PERMISSIONS.admin],
  siteScope: [],
  status: 'active',
  joinedAt: at,
  invitedBy: null,
  partner: { accountId },
});

/**
 * Makes the organization's partner member records match its reseller's team: every member of
 * an active, portal-enabled account gets one (unless they are a regular member already), and
 * records of anyone else are removed. Nothing to do when the owner switched partner access off.
 */
export async function syncPartnerMembers({ db, now }: Deps, orgId: string): Promise<{ added: number; removed: number }> {
  return auditedTransaction(db, [orgId], async (tx, audit) => {
    const org = await getOrg(tx, db, orgId);
    const members = await readMembers(tx, db, orgId);
    let wanted: AccountMemberDoc[] = [];
    const account = org.parentAccountId ? ((await tx.get(db.doc(paths.account(org.parentAccountId)))).data() as AccountDoc | undefined) : undefined;
    if (account && org.partnerAccess !== false && portalOpen(account)) {
      wanted = (await tx.get(db.collection(paths.accountMembers(account.id)))).docs.map((d) => d.data() as AccountMemberDoc);
    }
    const at = now();
    const partnerName = account?.name ?? null;
    if ((org.partnerName ?? null) !== partnerName) tx.update(db.doc(paths.org(orgId)), { partnerName, updatedAt: at });
    // White label: the reseller's brand reaches its customers (and their screens) through this copy.
    const partnerBrand = account && account.status === 'active' && account.whiteLabel && account.brand ? publicBrand(account.brand) : null;
    if (JSON.stringify(org.partnerBrand ?? null) !== JSON.stringify(partnerBrand)) tx.update(db.doc(paths.org(orgId)), { partnerBrand, updatedAt: at });
    const byUid = new Map(members.map((m) => [m.uid, m]));
    const keep = new Set(wanted.map((m) => m.uid));
    let removed = 0;
    for (const m of members) {
      if (!m.partner || (keep.has(m.uid) && m.partner.accountId === org.parentAccountId)) continue;
      tx.delete(db.doc(paths.member(orgId, m.uid)));
      setMembership(tx, db, { uid: m.uid, email: m.email, orgId, membership: null, now: at });
      removed++;
    }
    let added = 0;
    for (const w of wanted) {
      const existing = byUid.get(w.uid);
      if (existing && (!existing.partner || existing.partner.accountId === org.parentAccountId)) continue;
      tx.set(db.doc(paths.member(orgId, w.uid)), partnerMember(w, org.parentAccountId!, at));
      setMembership(tx, db, { uid: w.uid, email: w.email, orgId, membership: { orgName: org.name, orgStatus: org.status, role: 'admin' }, now: at });
      added++;
    }
    if (added || removed) {
      audit(orgId, { at, actorType: 'system', actorId: 'partner-sync', orgId, action: 'partner.members.synced', target: { type: 'org', id: orgId }, data: { accountId: org.parentAccountId, added, removed } });
    }
    return { added, removed };
  });
}

/** Re-syncs every customer organization of the account (team change, account status or portal switched). */
export async function syncAccountOrgs(deps: Deps, accountId: string): Promise<void> {
  const orgs = await deps.db.collection(paths.orgs()).where('parentAccountId', '==', accountId).get();
  for (const o of orgs.docs) await syncPartnerMembers(deps, o.id);
}

// ---------------------------------------------------------------- reseller team

export async function inviteAccountMember(
  deps: Deps,
  actor: Actor,
  input: z.infer<typeof InviteAccountMemberInput>,
): Promise<{ inviteId: string; token: string; expiresAt: number; emailed: boolean }> {
  const { db, now } = deps;
  const at = now();
  const token = randomBytes(32).toString('base64url');
  const tokenHash = hashToken(token);
  const ref = db.collection(paths.accountInvites(input.accountId)).doc();
  const expiresAt = at + INVITE_TTL_DAYS * DAY_MS;
  let accountName = '';
  let brand: ReturnType<typeof accountMailBrand>;
  await auditedTransaction(db, [PLATFORM_AUDIT_CHAIN], async (tx, audit) => {
    const { account } = await requirePartner(tx, db, actor, input.accountId, 'owner');
    if (account.status !== 'active') throw new HttpsError('failed-precondition', `“${account.name}” is inactive.`);
    accountName = account.name;
    brand = accountMailBrand(account);
    const [existingMember, pending] = await Promise.all([
      tx.get(db.collection(paths.accountMembers(input.accountId)).where('email', '==', input.email).limit(1)),
      tx.get(db.collection(paths.accountInvites(input.accountId)).where('email', '==', input.email).where('status', '==', 'pending')),
    ]);
    if (!existingMember.empty) throw new HttpsError('already-exists', 'This person is already on the team.');
    if (pending.docs.some((d) => (d.data() as AccountInviteDoc).expiresAt > at)) throw new HttpsError('already-exists', 'An invitation is already pending for this email.');
    const invite: AccountInviteDoc = { id: ref.id, email: input.email, role: input.role, tokenHash, status: 'pending', invitedBy: actor.uid, createdAt: at, expiresAt };
    tx.create(ref, invite);
    tx.create(db.doc(paths.inviteToken(tokenHash)), { accountId: input.accountId, inviteId: ref.id });
    audit(PLATFORM_AUDIT_CHAIN, {
      at,
      ...(actor.platformRole ? platformAudit(actor) : userAudit(actor)),
      orgId: null,
      action: 'account.member.invited',
      target: { type: 'account', id: input.accountId },
      data: { email: input.email, role: input.role },
    });
  });
  const emailed = await sendMail(deps, {
    to: [input.email],
    brand,
    subject: `You're invited to the ${accountName} partner portal on ${PRODUCT_NAME}`,
    text: `${actor.email ?? 'WallX'} invited you to join ${accountName} as a reseller partner on ${PRODUCT_NAME}, the digital signage platform by WallX. From the partner portal you create and manage your customers' organizations.

Sign in or create an account with this email address (${input.email}) to accept. The invitation expires in ${INVITE_TTL_DAYS} days.`,
    action: { label: 'Accept invitation', url: `${mailAppUrl(brand)}/invite/${token}` },
    ...(actor.email ? { replyTo: actor.email } : {}),
  });
  return { inviteId: ref.id, token, expiresAt, emailed };
}

/** Called by acceptInvite for a reseller invitation. */
export async function acceptAccountInvite(deps: Deps, actor: Actor, lookup: { accountId: string; inviteId: string }, tokenHash: string): Promise<{ accountId: string }> {
  requireVerifiedEmail(actor);
  const { db, now } = deps;
  const email = actor.email.toLowerCase();
  const tokenRef = db.doc(paths.inviteToken(tokenHash));
  await auditedTransaction(db, [PLATFORM_AUDIT_CHAIN], async (tx, audit) => {
    if (!(await tx.get(tokenRef)).exists) throw new HttpsError('not-found', 'This invitation was already used.');
    const inviteRef = db.doc(paths.accountInvite(lookup.accountId, lookup.inviteId));
    const invite = (await tx.get(inviteRef)).data() as AccountInviteDoc | undefined;
    const at = now();
    if (!invite || invite.status !== 'pending') throw new HttpsError('not-found', 'This invitation is no longer valid.');
    if (invite.expiresAt <= at) throw new HttpsError('deadline-exceeded', 'This invitation has expired.');
    if (invite.email !== email) throw new HttpsError('permission-denied', 'This invitation was sent to a different email address.');
    const account = await readAccount(tx, db, lookup.accountId);
    if (account.status !== 'active') throw new HttpsError('failed-precondition', `“${account.name}” is inactive.`);
    if ((await tx.get(db.doc(paths.accountMember(lookup.accountId, actor.uid)))).exists) throw new HttpsError('already-exists', 'You are already on this team.');
    const member: AccountMemberDoc = { uid: actor.uid, email, role: invite.role, status: 'active', joinedAt: at, invitedBy: invite.invitedBy };
    tx.create(db.doc(paths.accountMember(lookup.accountId, actor.uid)), member);
    tx.update(inviteRef, { status: 'accepted' });
    tx.delete(tokenRef);
    setAccountMembership(tx, db, { uid: actor.uid, email, accountId: lookup.accountId, membership: accountEntry(account, invite.role), now: at });
    audit(PLATFORM_AUDIT_CHAIN, { at, ...userAudit(actor), orgId: null, action: 'account.member.joined', target: { type: 'account', id: lookup.accountId }, data: { email, role: invite.role } });
  });
  await syncAccountOrgs(deps, lookup.accountId);
  return { accountId: lookup.accountId };
}

export async function revokeAccountInvite({ db, now }: Deps, actor: Actor, input: z.infer<typeof AccountInviteRefInput>): Promise<void> {
  await auditedTransaction(db, [PLATFORM_AUDIT_CHAIN], async (tx, audit) => {
    await requirePartner(tx, db, actor, input.accountId, 'owner');
    const ref = db.doc(paths.accountInvite(input.accountId, input.inviteId));
    const invite = (await tx.get(ref)).data() as AccountInviteDoc | undefined;
    if (!invite || invite.status !== 'pending') throw new HttpsError('not-found', 'Invitation not found.');
    tx.update(ref, { status: 'revoked' });
    tx.delete(db.doc(paths.inviteToken(invite.tokenHash)));
    audit(PLATFORM_AUDIT_CHAIN, { at: now(), ...(actor.platformRole ? platformAudit(actor) : userAudit(actor)), orgId: null, action: 'account.member.inviteRevoked', target: { type: 'account', id: input.accountId }, data: { email: invite.email } });
  });
}

/** An owner removes someone (or anyone leaves); their access to every customer ends. */
export async function removeAccountMember(deps: Deps, actor: Actor, input: z.infer<typeof AccountMemberRefInput>): Promise<void> {
  const { db, now } = deps;
  const self = input.uid === actor.uid;
  await auditedTransaction(db, [PLATFORM_AUDIT_CHAIN], async (tx, audit) => {
    if (self) {
      if (!(await tx.get(db.doc(paths.accountMember(input.accountId, actor.uid)))).exists) throw new HttpsError('not-found', 'You are not on this team.');
    } else {
      await requirePartner(tx, db, actor, input.accountId, 'owner');
    }
    const ref = db.doc(paths.accountMember(input.accountId, input.uid));
    const target = (await tx.get(ref)).data() as AccountMemberDoc | undefined;
    if (!target) throw new HttpsError('not-found', 'Team member not found.');
    if (target.role === 'owner') {
      const owners = await tx.get(db.collection(paths.accountMembers(input.accountId)).where('role', '==', 'owner'));
      if (owners.size <= 1) throw new HttpsError('failed-precondition', 'A reseller needs at least one owner. Add another owner first.');
    }
    const at = now();
    tx.delete(ref);
    setAccountMembership(tx, db, { uid: target.uid, email: target.email, accountId: input.accountId, membership: null, now: at });
    audit(PLATFORM_AUDIT_CHAIN, { at, ...(actor.platformRole ? platformAudit(actor) : userAudit(actor)), orgId: null, action: 'account.member.removed', target: { type: 'account', id: input.accountId }, data: { email: target.email, role: target.role } });
  });
  await syncAccountOrgs(deps, input.accountId);
}

// ---------------------------------------------------------------- customers

async function readActivePlan(tx: Transaction, db: Firestore, planId: string): Promise<Plan> {
  const plan = (await tx.get(db.doc(paths.plan(planId)))).data() as Plan | undefined;
  if (!plan || !plan.active || plan.tier === 'trial') throw new HttpsError('invalid-argument', 'Choose one of the available plans.');
  return plan;
}

/** Is the reseller paid up (or in grace)? Required to put customers on paid billing. */
function requirePaidUp(account: AccountDoc, at: number) {
  const s = accountBillingStatus(account.paidThrough, at);
  if (s === 'none' || s === 'restricted') {
    throw new HttpsError('failed-precondition', 'Your reseller account has no paid period. WallX records your payment first; until then customers can only run trials.');
  }
}

/** A reseller creates a customer organization: approved at once, billed to the reseller. */
export async function createPartnerOrg(deps: Deps, actor: Actor, input: z.infer<typeof CreatePartnerOrgInput>): Promise<{ orgId: string; inviteToken: string | null; emailed: boolean }> {
  const { db, now } = deps;
  const orgId = db.collection(paths.orgs()).doc().id;
  const at = now();
  const ownerEmail = input.ownerEmail ?? '';
  const token = ownerEmail ? randomBytes(32).toString('base64url') : null;
  let accountName = '';
  let brand: ReturnType<typeof accountMailBrand>;
  await auditedTransaction(db, [orgId, PLATFORM_AUDIT_CHAIN], async (tx, audit) => {
    const { account } = await requirePartner(tx, db, actor, input.accountId);
    if (account.status !== 'active') throw new HttpsError('failed-precondition', `“${account.name}” is inactive.`);
    accountName = account.name;
    brand = accountMailBrand(account);
    const plan = await readActivePlan(tx, db, input.planId);
    if (plan.limits.screens !== null && plan.limits.screens !== undefined && input.quantity > plan.limits.screens) {
      throw new HttpsError('invalid-argument', `${plan.name} allows at most ${plan.limits.screens} screens.`);
    }
    const trial = input.trial ?? true;
    if (!trial) requirePaidUp(account, at);
    const team = (await tx.get(db.collection(paths.accountMembers(input.accountId)))).docs.map((d) => d.data() as AccountMemberDoc);
    // App pricing when the catalog is set up: the reseller picks the customer's apps.
    const catalog = await readAppCatalog(tx, db);
    const appPricing = catalog.some((a) => a.base);
    const lines = appPricing ? priceLines(input.apps ?? [], [], catalog, at) : [];
    if (appPricing) await checkLines(tx, db, orgId, lines, catalog, input.quantity, []);

    const base = trialSubscription(plan.id, PARTNER_TRIAL_DAYS, input.quantity, at, actor.uid, appPricing ? 'apps' : 'plan');
    const draft: SubscriptionDoc = trial
      ? { ...base, apps: lines, billedTo: input.accountId }
      : { ...base, apps: lines, billedTo: input.accountId, trialEndsAt: null, currentPeriodStart: at, currentPeriodEnd: account.paidThrough ?? null };
    const entitlements = await entitlementsForSub(tx, db, orgId, { ...draft, status: trial ? 'trialing' : 'active' }, at);
    const org: OrgDoc = {
      id: orgId,
      name: input.orgName,
      status: 'active',
      parentAccountId: input.accountId,
      timezone: input.timezone,
      locale: 'en-IN',
      signupRequestId: null,
      createdBy: actor.uid,
      createdAt: at,
      updatedAt: at,
      partnerAccess: true,
      partnerName: account.name,
      partnerBrand: account.whiteLabel && account.brand ? publicBrand(account.brand) : null,
      contact: { name: input.contactName, phone: input.phone, city: input.city, stateCode: input.stateCode },
    };
    tx.create(db.doc(paths.org(orgId)), org);
    // writeSubscription also stores the billing summary on the org.
    writeSubscription(tx, db, orgId, draft, at);
    tx.set(db.doc(paths.orgEntitlements(orgId)), entitlements);
    tx.set(db.doc(paths.orgUsage(orgId)), { screens: 0, users: 0, storageBytes: 0, updatedAt: at });
    for (const m of team) {
      tx.set(db.doc(paths.member(orgId, m.uid)), partnerMember(m, input.accountId, at));
      setMembership(tx, db, { uid: m.uid, email: m.email, orgId, membership: { orgName: org.name, orgStatus: 'active', role: 'admin' }, now: at });
    }
    if (token) {
      const tokenHash = hashToken(token);
      const inviteRef = db.collection(paths.invites(orgId)).doc();
      const invite: InviteDoc = { id: inviteRef.id, email: ownerEmail, role: 'owner', tokenHash, status: 'pending', invitedBy: actor.uid, createdAt: at, expiresAt: at + INVITE_TTL_DAYS * DAY_MS, siteScope: [] };
      tx.create(inviteRef, invite);
      tx.create(db.doc(paths.inviteToken(tokenHash)), { orgId, inviteId: inviteRef.id });
    }
    const entry = {
      at,
      ...(actor.platformRole ? platformAudit(actor) : userAudit(actor)),
      orgId,
      action: 'org.created.partner',
      target: { type: 'org', id: orgId },
      data: { name: input.orgName, accountId: input.accountId, account: account.name, planId: plan.id, quantity: input.quantity, trial, ownerInvited: !!ownerEmail },
    };
    audit(orgId, entry);
    audit(PLATFORM_AUDIT_CHAIN, entry);
  });
  const emailed = token
    ? await sendMail(deps, {
        to: [ownerEmail],
        brand,
        subject: `${input.orgName} is ready on ${mailProduct(brand)}`,
        text: `${accountName} set up ${input.orgName} on ${mailProduct(brand)}${brand ? '' : ', the digital signage platform by WallX,'} and invited you as its owner.

Sign in or create an account with this email address (${ownerEmail}) to accept. ${accountName} can manage your screens and content for you; you can switch that off under Team. The invitation expires in ${INVITE_TTL_DAYS} days.`,
        action: { label: 'Accept invitation', url: `${mailAppUrl(brand)}/invite/${token}` },
      })
    : false;
  return { orgId, inviteToken: token, emailed };
}

async function readPartnerCustomer(tx: Transaction, db: Firestore, accountId: string, orgId: string): Promise<{ org: OrgDoc; sub: SubscriptionDoc }> {
  const org = await getOrg(tx, db, orgId);
  if (org.parentAccountId !== accountId) throw new HttpsError('permission-denied', 'This organization is not one of your customers.');
  const raw = (await tx.get(db.doc(paths.orgSubscription(orgId)))).data() as SubscriptionDoc | undefined;
  if (!raw) throw new HttpsError('failed-precondition', 'This organization has no subscription yet.');
  const sub = normalizeSubscription(raw);
  if (sub.billedTo !== accountId) throw new HttpsError('failed-precondition', 'WallX bills this customer directly; ask WallX to change its plan.');
  return { org, sub };
}

/** The reseller sets a customer's plan and number of screens (its screen limit). */
export async function setPartnerSubscription(deps: Deps, actor: Actor, input: z.infer<typeof SetPartnerSubscriptionInput>): Promise<SubscriptionDoc> {
  const { db, now } = deps;
  return afterSeats(deps, input.orgId, auditedTransaction(db, [input.orgId], async (tx, audit) => {
    await requirePartner(tx, db, actor, input.accountId);
    const { org, sub } = await readPartnerCustomer(tx, db, input.accountId, input.orgId);
    const plan = await readActivePlan(tx, db, input.planId);
    const allowed = plan.limits.screens ?? input.quantity;
    if (plan.limits.screens !== null && plan.limits.screens !== undefined && input.quantity > plan.limits.screens) {
      throw new HttpsError('invalid-argument', `${plan.name} allows at most ${plan.limits.screens} screens.`);
    }
    const authorized = (await tx.get(db.collection(paths.screens(input.orgId)).where('status', '==', 'authorized').count())).data().count;
    if (authorized > allowed) {
      throw new HttpsError('failed-precondition', `${org.name} has ${authorized} screens in use; remove some first or keep at least ${authorized}.`);
    }
    const at = now();
    const catalog = sub.pricing === 'apps' ? await readAppCatalog(tx, db) : [];
    const lines = sub.pricing === 'apps' ? priceLines(input.apps ?? (sub.apps ?? []), sub.apps ?? [], catalog, at) : [];
    if (sub.pricing === 'apps') await checkLines(tx, db, input.orgId, lines, catalog, input.quantity, (sub.apps ?? []).map((l) => l.appId));
    const draft: SubscriptionDoc = { ...sub, planId: plan.id, quantity: input.quantity, apps: lines, updatedAt: at, updatedBy: actor.uid };
    draft.amountPerPeriodMinor = sub.pricing === 'apps' && sub.status !== 'trialing' ? subscriptionAmount(plan, draft, catalog) : sub.amountPerPeriodMinor;
    const entitlements = await entitlementsForSub(tx, db, input.orgId, draft, at);
    const next = writeSubscription(tx, db, input.orgId, draft, at);
    tx.set(db.doc(paths.orgEntitlements(input.orgId)), entitlements);
    audit(input.orgId, {
      at,
      ...(actor.platformRole ? platformAudit(actor) : userAudit(actor)),
      orgId: input.orgId,
      action: 'billing.partner.subscriptionChanged',
      target: { type: 'subscription', id: input.orgId },
      data: { accountId: input.accountId, from: { planId: sub.planId, quantity: sub.quantity, apps: sub.apps }, to: { planId: plan.id, quantity: input.quantity, apps: lines } },
    });
    return next;
  }));
}

/** Ends a customer's trial: from now on the reseller pays for it (its paid period applies). */
export async function startPartnerBilling(deps: Deps, actor: Actor, input: z.infer<typeof PartnerOrgRefInput>): Promise<SubscriptionDoc> {
  const { db, now } = deps;
  return afterSeats(deps, input.orgId, auditedTransaction(db, [input.orgId], async (tx, audit) => {
    const { account } = await requirePartner(tx, db, actor, input.accountId);
    const { sub } = await readPartnerCustomer(tx, db, input.accountId, input.orgId);
    if (sub.trialEndsAt === null) throw new HttpsError('failed-precondition', 'Billing has already started for this customer.');
    const at = now();
    requirePaidUp(account, at);
    const started: SubscriptionDoc = { ...sub, trialEndsAt: null, currentPeriodStart: at, currentPeriodEnd: account.paidThrough ?? null, updatedAt: at, updatedBy: actor.uid };
    const entitlements = await trialEntitlements(tx, db, input.orgId, sub, started, at);
    const next = writeSubscription(tx, db, input.orgId, started, at);
    if (entitlements) tx.set(db.doc(paths.orgEntitlements(input.orgId)), entitlements);
    notifyStatusChange(tx, db, input.orgId, sub.status, next.status, at);
    audit(input.orgId, {
      at,
      ...(actor.platformRole ? platformAudit(actor) : userAudit(actor)),
      orgId: input.orgId,
      action: 'billing.partner.started',
      target: { type: 'subscription', id: input.orgId },
      data: { accountId: input.accountId, paidThrough: account.paidThrough ?? null, status: next.status },
    });
    return next;
  }));
}

/** Customers, plans with dealer prices and the monthly total, for the portal (and WallX staff). */
export async function partnerOverview({ db, now }: Deps, actor: Actor, input: z.infer<typeof PartnerOverviewInput>): Promise<PartnerOverview> {
  const at = now();
  const staff = hasPlatformPermission(actor.platformRole, 'account.manage') || hasPlatformPermission(actor.platformRole, 'billing.view');
  const [accountSnap, memberSnap] = await Promise.all([db.doc(paths.account(input.accountId)).get(), db.doc(paths.accountMember(input.accountId, actor.uid)).get()]);
  const account = accountSnap.data() as AccountDoc | undefined;
  if (!account) throw new HttpsError('not-found', 'Reseller account not found.');
  if (!staff) {
    if (!memberSnap.exists) throw new HttpsError('permission-denied', 'You are not on this reseller’s team.');
    if (!portalOpen(account)) throw new HttpsError('failed-precondition', 'The partner portal is not available for this reseller. Contact WallX.');
  }
  const [planSnaps, orgSnaps, appSnaps] = await Promise.all([
    db.collection(paths.plans()).get(),
    db.collection(paths.orgs()).where('parentAccountId', '==', input.accountId).get(),
    db.collection(paths.apps()).get(),
  ]);
  const plans = new Map(planSnaps.docs.map((d) => [d.id, d.data() as Plan]));
  const catalog = appSnaps.docs.map((d) => d.data() as AppDoc);
  const discount = account.dealerDiscountBps ?? 0;
  const dealer = (minor: number) => Math.round((minor * (10_000 - discount)) / 10_000);

  const customers: PartnerCustomer[] = [];
  for (const o of orgSnaps.docs) {
    const org = o.data() as OrgDoc;
    const [subSnap, screenSnap] = await Promise.all([db.doc(paths.orgSubscription(org.id)).get(), db.collection(paths.screens(org.id)).where('status', '==', 'authorized').get()]);
    if (!subSnap.exists) continue;
    const sub = normalizeSubscription(subSnap.data() as SubscriptionDoc);
    const plan = plans.get(sub.planId);
    const resellerBilled = sub.billedTo === input.accountId;
    const trialing = sub.trialEndsAt !== null && sub.currentPeriodEnd === null;
    const screens = screenSnap.docs.map((d) => d.data() as ScreenDoc);
    // App pricing: the bill lines at dealer prices (a fixed dealer price per app, else the discount).
    const lines: BillLine[] =
      plan && sub.pricing === 'apps' && resellerBilled
        ? subscriptionLines(plan, sub, catalog).map((l) => {
            const app = catalog.find((a) => a.id === l.appId);
            const unit = l.kind === 'app' && app?.dealerPriceMinor != null ? app.dealerPriceMinor : l.kind === 'adjustment' ? l.unitPriceMinor : dealer(l.unitPriceMinor);
            return { ...l, unitPriceMinor: unit, totalMinor: unit * l.quantity };
          })
        : [];
    const price = !plan || !resellerBilled ? null : sub.pricing === 'apps' ? (lines[0]?.unitPriceMinor ?? null) : dealerPriceMinor(plan, account);
    const linesTotal = billTotalMinor(lines);
    customers.push({
      orgId: org.id,
      name: org.name,
      status: org.status,
      planId: sub.planId,
      planName: plan?.name ?? sub.planId,
      quantity: sub.quantity,
      screensUsed: screens.length,
      screensOnline: screens.filter((s) => isScreenOnline(s, at)).length,
      billing: { status: sub.status, trialEndsAt: sub.trialEndsAt, currentPeriodEnd: sub.currentPeriodEnd },
      resellerBilled,
      trialing,
      dealerPriceMinor: price,
      monthlyMinor: !resellerBilled ? null : trialing ? 0 : sub.pricing === 'apps' ? linesTotal : price === null ? null : price * sub.quantity,
      partnerAccess: org.partnerAccess !== false,
      createdAt: org.createdAt,
      lines,
      apps: (sub.apps ?? []).map((l) => ({ appId: l.appId, quantity: l.quantity })),
      pricing: sub.pricing === 'apps' ? 'apps' : 'plan',
    });
  }
  customers.sort((a, b) => a.name.localeCompare(b.name));
  const billed = customers.filter((c) => c.resellerBilled && !c.trialing);
  const monthlyTotalMinor = billed.some((c) => c.monthlyMinor === null) ? null : billed.reduce((s, c) => s + (c.monthlyMinor ?? 0), 0);
  return {
    account: {
      id: account.id,
      name: account.name,
      status: account.status,
      portal: account.portal === true,
      paidThrough: account.paidThrough ?? null,
      billingStatus: accountBillingStatus(account.paidThrough, at),
      dealerDiscountBps: account.dealerDiscountBps ?? 0,
    },
    customers,
    apps: catalog
      .filter((a) => a.active && !a.base)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((a) => ({ id: a.id, name: a.name, unit: a.unit, listPriceMinor: a.priceMinor, dealerPriceMinor: a.dealerPriceMinor ?? dealer(a.priceMinor), requires: a.requires })),
    plans: [...plans.values()]
      .filter((p) => p.active && p.tier !== 'trial')
      .sort((a, b) => (a.pricePerScreenMonthlyMinor ?? Infinity) - (b.pricePerScreenMonthlyMinor ?? Infinity))
      .map((p) => ({ id: p.id, name: p.name, listPriceMinor: p.pricePerScreenMonthlyMinor, dealerPriceMinor: dealerPriceMinor(p, account), screenLimit: p.limits.screens ?? null })),
    monthlyTotalMinor,
    serverTime: at,
  };
}

/** The customer's owner switches the reseller's access on or off. */
export async function setPartnerAccess(deps: Deps, actor: Actor, input: z.infer<typeof SetPartnerAccessInput>): Promise<void> {
  const { db, now } = deps;
  await auditedTransaction(db, [input.orgId], async (tx, audit) => {
    const me = await requireOrgPermission(tx, db, actor, input.orgId, 'member.manage');
    if (me.role !== 'owner') throw new HttpsError('permission-denied', 'Only owners can change the reseller’s access.');
    const org = await getOrg(tx, db, input.orgId);
    if (!org.parentAccountId) throw new HttpsError('failed-precondition', 'This organization has no reseller.');
    if ((org.partnerAccess !== false) === input.enabled) return;
    const at = now();
    tx.update(db.doc(paths.org(input.orgId)), { partnerAccess: input.enabled, updatedAt: at });
    audit(input.orgId, { at, ...userAudit(actor), orgId: input.orgId, action: input.enabled ? 'partner.access.enabled' : 'partner.access.disabled', target: { type: 'org', id: input.orgId }, data: { accountId: org.parentAccountId } });
  });
  await syncPartnerMembers(deps, input.orgId);
}

/** Partner records are managed by the reseller's team, not on the customer's Team page. */
export const PARTNER_MANAGED = 'This person manages the organization for your reseller. Switch reseller access off under Team instead.';

