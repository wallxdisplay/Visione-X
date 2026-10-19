/**
 * Email copies of important in-app notifications. Each notification type that needs action goes
 * to the active members holding the permission that handles it (screen offline → screen.manage,
 * …). Informational types (back online, emergency ended, request decided) stay in-app only.
 * Support staff and site-scoped members are skipped: a notification is not tied to a site, so a
 * scoped member could otherwise learn about screens outside their sites. Emails are English
 * (members' language preference lives in their browser). Orgs can turn this off in
 * Organization settings (settings.emailNotifications, default on).
 */
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { logger } from 'firebase-functions/v2';
import {
  PRODUCT_NAME,
  REGION,
  paths,
  type MemberDoc,
  type NotificationDoc,
  type NotificationType,
  type OrgDoc,
  type OrgPermission,
} from '@wallx-play/shared';
import { getDeps } from '../lib/admin';
import type { Deps } from '../lib/context';
import { sendMail, mailAppUrl, mailProduct } from '../lib/email';
import { orgMailBrand } from '../branding/branding';
import { MAIL_SECRETS } from '../options';

type Params = Record<string, string | number>;

interface Template {
  permission: OrgPermission;
  subject: (p: Params, date: (v: unknown) => string) => string;
  body: (p: Params, date: (v: unknown) => string) => string;
}

const s = (v: unknown) => (v === undefined || v === null ? '' : String(v));

/** Types that are emailed; any type missing here stays in-app only. */
export const EMAIL_TEMPLATES: Partial<Record<NotificationType, Template>> = {
  screen_offline: {
    permission: 'screen.manage',
    subject: (p) => `Screen offline: ${s(p.screen)}`,
    body: (p, date) =>
      `${s(p.screen)} went offline${p.lastSeen ? ` (last seen ${date(p.lastSeen)})` : ''}.\n\nCheck its power and network connection. You will see it back online in ${PRODUCT_NAME} as soon as it reconnects.`,
  },
  emergency_started: {
    permission: 'screen.manage',
    subject: (p) => `Emergency started: ${s(p.name)}`,
    body: (p) =>
      `Emergency “${s(p.name)}” was started by ${s(p.by)} on ${s(p.screens)} screen(s).\n\nScreens show the emergency message until it is ended.`,
  },
  approval_requested: {
    permission: 'content.approve',
    subject: (p) => `Publish request from ${s(p.by)}`,
    body: (p) =>
      `${s(p.by)} asked to publish content to ${s(p.screens)} screen(s). Review the request to approve or reject it.`,
  },
  sensor_alert: {
    permission: 'sensor.manage',
    subject: (p) => `Sensor alert: ${s(p.sensor)} · ${s(p.channel)}`,
    body: (p) =>
      `${s(p.sensor)} · ${s(p.channel)}: ${s(p.rule)}${s(p.value) ? ` (${[s(p.value), s(p.unit)].filter(Boolean).join(' ')})` : ''}.`,
  },
  sensor_stale: {
    permission: 'sensor.manage',
    subject: (p) => `Sensor not updating: ${s(p.sensor)} · ${s(p.channel)}`,
    body: (p) => `${s(p.sensor)} · ${s(p.channel)} stopped sending new data.`,
  },
  sensor_offline: {
    permission: 'sensor.manage',
    subject: (p) => `Sensor offline: ${s(p.sensor)}`,
    body: (p) => `Sensor ${s(p.sensor)} is offline. Check its power and network connection.`,
  },
  billing_trial_ending: {
    permission: 'billing.manage',
    subject: (p, date) => `Your free trial ends on ${date(p.until)}`,
    body: (p, date) =>
      `Your ${PRODUCT_NAME} free trial ends on ${date(p.until)}. Choose a plan to keep your screens running.`,
  },
  billing_due_soon: {
    permission: 'billing.manage',
    subject: (p, date) => `Payment due: renews on ${date(p.until)}`,
    body: (p, date) => `Your subscription renews on ${date(p.until)}, and payment is due.`,
  },
  billing_past_due: {
    permission: 'billing.manage',
    subject: () => 'Payment overdue',
    body: () => 'Your payment is overdue. Renew within the grace period to avoid interruption.',
  },
  billing_restricted: {
    permission: 'billing.manage',
    subject: () => 'Subscription lapsed: editing and publishing paused',
    body: () =>
      'Your subscription has lapsed, so editing and publishing are paused. Screens keep showing their last content. Renew to continue.',
  },
  billing_payment_recorded: {
    permission: 'billing.manage',
    subject: () => 'Payment received',
    body: (p, date) =>
      `We received your payment. Your subscription is paid through ${date(p.until)}. Thank you!`,
  },
  billing_apps_changed: {
    permission: 'billing.manage',
    subject: () => 'Your apps were changed',
    body: (p, date) =>
      [
        'The screens and apps of your subscription were changed in the App store.',
        Number(p.charge) > 0 ? `₹${(Number(p.charge) / 100).toFixed(2)} (plus GST) for the rest of the current period is added to your next payment.` : '',
        p.from ? `Removals take effect on ${date(p.from)}.` : '',
      ].filter(Boolean).join(' '),
  },
  billing_request_resolved: {
    permission: 'billing.manage',
    subject: () => 'Your billing request was handled',
    body: (p) => `WallX handled your billing request (${s(p.status)}).`,
  },
  support_access_requested: {
    permission: 'member.manage',
    subject: () => 'WallX support asks for access',
    body: (p) =>
      `WallX support asks for access to your organization for ${s(p.hours)} hours.\n\nReason: ${s(p.reason)}\n\nYou can approve or decline the request in Team.`,
  },
  support_access_granted: {
    permission: 'member.manage',
    subject: () => 'WallX support has emergency access',
    body: (p) =>
      `WallX gave its support team emergency access to your organization for ${s(p.hours)} hours.\n\nReason: ${s(p.reason)}\n\nYou can end the access at any time in Team.`,
  },
};

/** Members who receive emails needing `permission` (active, not support staff, all sites). */
export function emailRecipients(members: MemberDoc[], permission: OrgPermission): string[] {
  const emails = members
    .filter(
      (m) =>
        m.status === 'active' &&
        !m.support &&
        m.siteScope.length === 0 &&
        m.permissions.includes(permission) &&
        m.email,
    )
    .map((m) => m.email.toLowerCase());
  return [...new Set(emails)];
}

const MAIL_LOG_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Emails one notification (at most once: a mailLog doc is created first, so a retried event
 * finds it and stops). Returns the number of recipients, 0 when nothing was sent.
 */
export async function deliverNotificationEmail(
  deps: Deps,
  orgId: string,
  notificationId: string,
): Promise<number> {
  const { db, now } = deps;
  const snap = await db.doc(`${paths.notifications(orgId)}/${notificationId}`).get();
  if (!snap.exists) return 0;
  const n = snap.data() as NotificationDoc;
  const template = EMAIL_TEMPLATES[n.type];
  if (!template) return 0;
  const orgSnap = await db.doc(paths.org(orgId)).get();
  if (!orgSnap.exists) return 0;
  const org = orgSnap.data() as OrgDoc;
  if (org.settings?.emailNotifications === false) return 0;
  const members = (await db.collection(paths.members(orgId)).get()).docs.map(
    (d) => d.data() as MemberDoc,
  );
  const to = emailRecipients(members, template.permission);
  if (to.length === 0) return 0;

  try {
    await db
      .doc(paths.mailLog(`${orgId}_${notificationId}`))
      .create({
        orgId,
        notificationId,
        type: n.type,
        recipients: to.length,
        at: now(),
        expiresAt: new Date(now() + MAIL_LOG_TTL_MS),
      });
  } catch {
    return 0; // already sent (event delivered twice)
  }

  const fmt = new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeZone: org.timezone || 'Asia/Kolkata',
  });
  const fmtTime = new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: org.timezone || 'Asia/Kolkata',
  });
  const date = (v: unknown) =>
    typeof v === 'number' && Number.isFinite(v)
      ? (n.type === 'screen_offline' ? fmtTime : fmt).format(new Date(v))
      : s(v);
  const brand = await orgMailBrand(db, orgId);
  const subject = `${template.subject(n.params, date)} · ${org.name}`;
  const text = `${template.body(n.params, date)}\n\nOrganization: ${org.name}\n\nYou receive this because you manage this in ${mailProduct(brand)}. An admin can turn off alert emails in Organization settings.`;
  const sent = await sendMail(deps, {
    to,
    brand,
    subject,
    text,
    action: { label: `Open ${mailProduct(brand)}`, url: `${mailAppUrl(brand)}${n.link ?? '/'}` },
  });
  return sent ? to.length : 0;
}

export const emailNotification = onDocumentCreated(
  {
    region: REGION,
    document: 'orgs/{orgId}/notifications/{notificationId}',
    memory: '256MiB',
    cpu: 'gcf_gen1',
    maxInstances: 5,
    secrets: MAIL_SECRETS,
  },
  async (event) => {
    try {
      await deliverNotificationEmail(getDeps(), event.params.orgId, event.params.notificationId);
    } catch (err) {
      logger.error('Notification email failed', {
        orgId: event.params.orgId,
        error: (err as Error).message,
      });
    }
  },
);
