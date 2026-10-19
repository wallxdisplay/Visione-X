/**
 * Platform-wide settings (platform/settings), edited by superadmins in Super Admin → Platform
 * settings and readable by every signed-in user: support contacts for the Help page, a notice
 * banner for everyone (e.g. planned maintenance) and whether new organizations may sign up.
 * The player signing-key fingerprint is kept here too (set by the first player release).
 */
import { z } from 'zod';
import type { OnlinePaymentSettings } from './payments';

export const SupportContacts = z.object({
  email: z.union([z.string().trim().toLowerCase().email().max(200), z.literal('')]),
  phone: z.string().trim().max(30),
  whatsapp: z.string().trim().max(30),
  /** e.g. "Mon–Sat, 9:30–18:30 IST" */
  hours: z.string().trim().max(120),
});
export type SupportContacts = z.infer<typeof SupportContacts>;

export const PlatformBanner = z.object({
  message: z.string().trim().min(1).max(300),
  tone: z.enum(['info', 'warning']),
  /** Hidden automatically after this time (epoch ms); null = until removed. */
  until: z.number().int().nullable(),
});
export type PlatformBanner = z.infer<typeof PlatformBanner>;

export interface PlatformSettingsDoc {
  support?: SupportContacts;
  banner?: PlatformBanner | null;
  /** New organization signups (default: open). */
  signupsOpen?: boolean;
  /** Online payments (Razorpay): off until WallX switches them on. */
  payments?: OnlinePaymentSettings;
  playerSignerSha256?: string;
  updatedAt?: number;
  updatedBy?: string;
}

export const UpdatePlatformSettingsInput = z.object({
  support: SupportContacts,
  banner: PlatformBanner.nullable(),
  signupsOpen: z.boolean(),
});

export const EMPTY_SUPPORT_CONTACTS: SupportContacts = { email: '', phone: '', whatsapp: '', hours: '' };

/** The banner to show now, if any. */
export function activeBanner(settings: PlatformSettingsDoc | undefined, now: number): PlatformBanner | null {
  const b = settings?.banner;
  return b && (b.until === null || b.until > now) ? b : null;
}

export const signupsOpen = (settings: PlatformSettingsDoc | undefined) => settings?.signupsOpen !== false;
