/**
 * Outgoing email through Gmail / Google Workspace SMTP (smtp.gmail.com) with an App Password.
 * Sender: SMTP_USER (functions/.env.wallx-play, e.g. wallxdisplay@gmail.com). Password: the
 * secret SMTP_PASSWORD (`npx firebase functions:secrets:set SMTP_PASSWORD`; bound through MAIL_SECRETS
 * in options.ts). Without both, mail
 * is skipped with a log line, so features keep working before email is set up. Tests inject
 * Deps.mailer. Gmail allows about 500 recipients a day (@gmail.com) or 2,000 (Workspace).
 */
import nodemailer, { type Transporter } from 'nodemailer';
import { logger } from 'firebase-functions/v2';
import { PRODUCT_NAME } from '@wallx-play/shared';
import type { Deps } from './context';

export const APP_URL = process.env.APP_URL ?? 'https://wallx-play.web.app';

export interface Mail {
  to: string[];
  subject: string;
  /** Plain-text body; the HTML version is generated from it. */
  text: string;
  /** Optional call-to-action button. */
  action?: { label: string; url: string };
  replyTo?: string;
}

export type Mailer = (mail: Mail) => Promise<boolean>;

let transporter: Transporter | null = null;

function smtp(): Transporter | null {
  const user = process.env.SMTP_USER?.trim();
  // Google shows App Passwords in groups of four; spaces copied with it are not part of it.
  const pass = process.env.SMTP_PASSWORD?.replace(/\s+/g, '');
  if (!user || !pass) return null;
  transporter ??= nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user, pass } });
  return transporter;
}

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Simple, readable HTML version of a plain-text email (paragraphs, optional button, footer). */
export function renderHtml(mail: Mail): string {
  const paragraphs = mail.text
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px">${escape(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
  const button = mail.action
    ? `<p style="margin:20px 0"><a href="${escape(mail.action.url)}" style="background:#4F46E5;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block">${escape(mail.action.label)}</a></p>`
    : '';
  return `<!doctype html><html><body style="margin:0;background:#F5F6FA;font-family:Segoe UI,Roboto,Arial,sans-serif;color:#1F2433">
<div style="max-width:560px;margin:0 auto;padding:24px">
<div style="font-weight:700;font-size:18px;margin-bottom:16px">${escape(PRODUCT_NAME)}</div>
<div style="background:#fff;border-radius:12px;padding:24px;font-size:15px;line-height:1.5">${paragraphs}${button}</div>
<p style="font-size:12px;color:#6B7180;margin-top:16px">${escape(PRODUCT_NAME)} by WallX · ${escape(APP_URL)}</p>
</div></body></html>`;
}

/** Sends one email; returns false (and logs) when mail is not configured or sending fails. */
export async function sendMail(deps: Pick<Deps, 'mailer'>, mail: Mail): Promise<boolean> {
  if (mail.to.length === 0) return false;
  if (deps.mailer) return deps.mailer(mail);
  const t = smtp();
  if (!t) {
    logger.info('Email skipped: SMTP_USER / SMTP_PASSWORD not configured', { subject: mail.subject, recipients: mail.to.length });
    return false;
  }
  const text = mail.action ? `${mail.text}\n\n${mail.action.label}: ${mail.action.url}` : mail.text;
  const sender = process.env.SMTP_USER!.trim();
  try {
    await t.sendMail({
      from: { name: PRODUCT_NAME, address: sender },
      // One person (invitations, signup decisions): addressed to them. Several (alert emails):
      // one message with everyone in Bcc, so members do not see each other's addresses.
      ...(mail.to.length === 1 ? { to: mail.to[0] } : { to: sender, bcc: mail.to }),
      replyTo: mail.replyTo,
      subject: mail.subject,
      text,
      html: renderHtml(mail),
    });
    return true;
  } catch (err) {
    logger.error('Email failed', { subject: mail.subject, error: (err as Error).message });
    return false;
  }
}
