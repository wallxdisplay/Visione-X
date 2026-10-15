/**
 * White label (feature `branding.whiteLabel`): a reseller's brand applies to all its customers;
 * an organization whose plan includes white label can set its own brand, which wins.
 *
 * - accounts/{id}.brand: the reseller's brand (when WallX switched `whiteLabel` on for it).
 * - orgs/{id}.brand: the organization's own brand (used only while its plan has the feature).
 * - orgs/{id}.partnerBrand: copy of its reseller's brand, kept in sync by Functions, so members
 *   (who cannot read reseller accounts) and players can resolve the brand from the org alone.
 * - brandDomains/{hostname}: public lookup for custom web addresses, so the sign-in page can show
 *   the brand before anyone signs in.
 *
 * Branded pages keep a small "Powered by WallX Play" credit; screens show only the brand.
 */
import { z } from 'zod';
import type { EntitlementsDoc } from './docs';

/** Logos are stored inline (data URL), so players and the sign-in page get them without Storage. */
export const BRAND_LOGO_MAX_BYTES = 100_000;
export const MAX_BRAND_DOMAINS = 5;

const hex = z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Use a colour like #4F46E5');

/** PNG, JPEG or WebP as a base64 data URL, at most BRAND_LOGO_MAX_BYTES. */
export const BrandLogo = z
  .string()
  .regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/, 'Use a PNG, JPEG or WebP image')
  .refine((s) => Math.floor(((s.length - s.indexOf(',') - 1) * 3) / 4) <= BRAND_LOGO_MAX_BYTES, `The logo must be ${BRAND_LOGO_MAX_BYTES / 1000} KB or smaller`);

export const BrandInput = z.object({
  /** Product name shown instead of "WallX Play", e.g. "Deccan Signage". */
  name: z.string().trim().min(2).max(40),
  logo: BrandLogo.nullable(),
  /** Main colour (buttons, links, highlights). */
  primaryColor: hex,
  supportEmail: z.union([z.string().trim().toLowerCase().email().max(200), z.literal('')]).default(''),
  supportPhone: z.string().trim().max(30).default(''),
  website: z.union([z.string().trim().url().max(200), z.literal('')]).default(''),
});
export type BrandInput = z.infer<typeof BrandInput>;

export interface Brand extends BrandInput {
  /** Custom web addresses (managed by WallX staff). */
  domains: string[];
  updatedAt: number;
}

/** The brand as users and screens see it. */
export type BrandPublic = Omit<Brand, 'domains'> & { appUrl: string | null };

/** brandDomains/{hostname} — readable by anyone (the sign-in page needs it). */
export interface BrandDomainDoc {
  hostname: string;
  owner: { kind: 'account' | 'org'; id: string };
  brand: BrandPublic;
  updatedAt: number;
}

/** Lowercase host name without scheme, port or path. */
export const Hostname = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, 'Enter a host name such as signage.example.com');

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
export const BrandTarget = z.discriminatedUnion('kind', [z.object({ kind: z.literal('org'), orgId: id }), z.object({ kind: z.literal('account'), accountId: id })]);
export type BrandTarget = z.infer<typeof BrandTarget>;

/** Set (or remove, with null) a reseller's or an organization's brand. */
export const SaveBrandInput = z.object({ target: BrandTarget, brand: BrandInput.nullable() });
/** WallX staff: the custom web addresses of a brand. */
export const SetBrandDomainsInput = z.object({ target: BrandTarget, domains: z.array(Hostname).max(MAX_BRAND_DOMAINS) });

/** Public view of a stored brand. */
export function publicBrand(b: Brand): BrandPublic {
  const { domains, ...rest } = b;
  return { ...rest, appUrl: domains[0] ? `https://${domains[0]}` : null };
}

/**
 * The brand an organization's members and screens see: its own (while its plan includes white
 * label), else its reseller's, else none (WallX Play).
 */
export function effectiveBrand(
  org: { brand?: Brand | null; partnerBrand?: BrandPublic | null },
  entitlements: Pick<EntitlementsDoc, 'features'> | undefined | null,
): BrandPublic | null {
  if (org.brand && entitlements?.features.includes('branding.whiteLabel')) return publicBrand(org.brand);
  return org.partnerBrand ?? null;
}

// ---------------------------------------------------------------- colours

function rgb(color: string): [number, number, number] {
  const n = parseInt(color.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const toHex = (c: number[]) => `#${c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`.toUpperCase();

/** Mixes `color` with `other` (0 = color, 1 = other). */
export function mixColor(color: string, other: string, amount: number): string {
  const a = rgb(color);
  const b = rgb(other);
  return toHex(a.map((v, i) => v + (b[i]! - v) * amount));
}

/** Relative luminance (WCAG). */
export function luminance(color: string): number {
  const [r, g, b] = rgb(color).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** White or near-black text, whichever reads better on `background`. */
export const textOn = (background: string) => (luminance(background) > 0.45 ? '#111827' : '#FFFFFF');

/** Theme colours derived from the brand's main colour. */
export function brandPalette(primary: string) {
  return {
    primary,
    hover: mixColor(primary, '#000000', 0.12),
    pressed: mixColor(primary, '#000000', 0.24),
    soft: mixColor(primary, '#FFFFFF', 0.88),
    softDark: mixColor(primary, '#000000', 0.7),
    onPrimary: textOn(primary),
  };
}
