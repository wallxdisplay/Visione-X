/**
 * Public API (v1.1, Enterprise): organization API keys for the REST API under /api/v1, and
 * signed webhooks that tell a customer's systems about events. Keys are shown once; only their
 * SHA-256 is stored. Webhook signing secrets live in a server-only collection.
 */
import { z } from 'zod';
import type { NotificationType } from './ops';
import type { OrgPermission } from './permissions';

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);

/** What a key may do. Each scope grants one organization permission, nothing more. */
export const API_SCOPES = ['screens:read', 'screens:command', 'content:publish', 'emergency:write', 'reports:read'] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export const API_SCOPE_PERMISSIONS: Record<ApiScope, OrgPermission> = {
  'screens:read': 'screen.view',
  'screens:command': 'screen.command',
  'content:publish': 'content.publish',
  'emergency:write': 'emergency.trigger',
  'reports:read': 'report.view',
};

/** Keys look like `wxp_<keyId>_<secret>`; the first characters are shown to tell them apart. */
export const API_KEY_PREFIX = 'wxp_';
export const MAX_API_KEYS = 20;

/** orgs/{orgId}/apiKeys/{keyId} — visible to members with apikey.manage; never the secret. */
export interface ApiKeyDoc {
  id: string;
  name: string;
  /** e.g. "wxp_Ab12Cd34…" */
  hint: string;
  scopes: ApiScope[];
  createdBy: string;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
  revokedBy: string | null;
}

/** apiKeyHashes/{sha256(key)} — server-only lookup from a presented key. */
export interface ApiKeyLookupDoc {
  orgId: string;
  keyId: string;
  name: string;
  scopes: ApiScope[];
  revoked: boolean;
}

export const CreateApiKeyInput = z.object({
  orgId: id,
  name: z.string().trim().min(2).max(60),
  scopes: z.array(z.enum(API_SCOPES)).min(1).max(API_SCOPES.length),
});
export const ApiKeyRefInput = z.object({ orgId: id, keyId: id });

// ---------------------------------------------------------------- webhooks

export const WEBHOOK_EVENTS = [
  'screen.offline',
  'screen.online',
  'emergency.started',
  'emergency.ended',
  'approval.requested',
  'approval.decided',
  'sensor.alert',
  'sensor.recovered',
  'sensor.offline',
  'sensor.online',
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/** In-app notification → webhook event (other notifications are not sent to webhooks). */
export const NOTIFICATION_WEBHOOK_EVENTS: Partial<Record<NotificationType, WebhookEvent>> = {
  screen_offline: 'screen.offline',
  screen_online: 'screen.online',
  emergency_started: 'emergency.started',
  emergency_ended: 'emergency.ended',
  approval_requested: 'approval.requested',
  approval_decided: 'approval.decided',
  sensor_alert: 'sensor.alert',
  sensor_recovered: 'sensor.recovered',
  sensor_offline: 'sensor.offline',
  sensor_online: 'sensor.online',
};

export const MAX_WEBHOOKS = 10;
/** A webhook is switched off after this many failed deliveries in a row. */
export const WEBHOOK_DISABLE_AFTER = 20;
/** Delivery log entries are kept this long. */
export const WEBHOOK_DELIVERY_DAYS = 14;

export interface WebhookDelivery {
  at: number;
  ok: boolean;
  /** HTTP status, or null when the address could not be reached. */
  status: number | null;
  error: string | null;
}

/** orgs/{orgId}/webhooks/{webhookId} — visible to members with apikey.manage. */
export interface WebhookDoc {
  id: string;
  url: string;
  events: WebhookEvent[];
  active: boolean;
  /** Set when WallX switched it off (too many failures). */
  disabledReason: string | null;
  failures: number;
  lastDelivery: WebhookDelivery | null;
  secretHint: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

/** orgs/{orgId}/webhooks/{webhookId}/deliveries/{id} (TTL). */
export interface WebhookDeliveryDoc extends WebhookDelivery {
  event: WebhookEvent | 'ping';
  attempts: number;
  durationMs: number;
  expiresAt: Date;
}

const httpsUrl = z
  .string()
  .trim()
  .max(500)
  .url()
  .refine((u) => u.startsWith('https://'), 'Use an https:// address.');

export const SaveWebhookInput = z.object({
  orgId: id,
  webhookId: id.optional(),
  url: httpsUrl,
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).max(WEBHOOK_EVENTS.length),
  active: z.boolean().default(true),
});
export const WebhookRefInput = z.object({ orgId: id, webhookId: id });

/** Body of every webhook POST. */
export interface WebhookPayload {
  id: string;
  event: WebhookEvent | 'ping';
  createdAt: number;
  organization: { id: string; name: string };
  data: Record<string, string | number>;
  link: string | null;
}

/** Super Admin → Integrations & API: per-organization usage (counts only, no keys or addresses). */
export interface ApiOverviewRow {
  orgId: string;
  name: string;
  /** Plan includes the API / webhooks. */
  apiInPlan: boolean;
  webhooksInPlan: boolean;
  activeKeys: number;
  callsToday: number;
  limitPerDay: number | null;
  webhooks: number;
  webhooksOff: number;
}
export const ApiOverviewInput = z.object({});
