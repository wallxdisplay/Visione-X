/**
 * Operations: emergency override, remote commands, notifications and publish approvals.
 */
import { z } from 'zod';

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const ids = z.array(id).min(1).max(500);

// ---------------------------------------------------------------- emergency override

export const EmergencyTarget = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all') }),
  z.object({ kind: z.literal('sites'), ids }),
  z.object({ kind: z.literal('groups'), ids }),
  z.object({ kind: z.literal('screens'), ids }),
]);
export type EmergencyTarget = z.infer<typeof EmergencyTarget>;

const Color = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const EmergencyContent = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('playlist'), playlistId: id }),
  z.object({
    kind: z.literal('message'),
    text: z.string().trim().min(1).max(500),
    background: Color.default('#B91C1C'),
    color: Color.default('#FFFFFF'),
  }),
]);
export type EmergencyContent = z.infer<typeof EmergencyContent>;

/** The words a user must type to start an override (guards against accidental clicks). */
export const EMERGENCY_CONFIRM_PHRASE = 'START EMERGENCY';

export const TriggerEmergencyInput = z.object({
  orgId: id,
  name: z.string().trim().min(3).max(80),
  content: EmergencyContent,
  target: EmergencyTarget,
  /** Minutes until it ends by itself; null = until ended manually. */
  durationMinutes: z.number().int().min(1).max(7 * 24 * 60).nullable(),
  confirm: z.literal(EMERGENCY_CONFIRM_PHRASE),
});
export const EndEmergencyInput = z.object({ orgId: id, emergencyId: id });

/** orgs/{orgId}/emergencies/{id} */
export interface EmergencyDoc {
  id: string;
  name: string;
  content: EmergencyContent;
  target: EmergencyTarget;
  active: boolean;
  startedAt: number;
  expiresAt: number | null;
  endedAt: number | null;
  startedBy: string;
  startedByEmail: string | null;
  endedBy: string | null;
  screenCount: number;
}

/** Synthetic playlist id used in manifests for message-type overrides. */
export const emergencyPlaylistId = (emergencyId: string) => `emergency-${emergencyId}`;

// ---------------------------------------------------------------- remote commands

/** install_update: shows Android's install prompt for a downloaded player update (someone must tap Install). */
export const SCREEN_COMMANDS = ['refresh', 'restart_app', 'reboot', 'clear_cache', 'screenshot', 'diagnostics', 'install_update'] as const;
export type ScreenCommandType = (typeof SCREEN_COMMANDS)[number];
/** Commands that interrupt playback and need an explicit confirmation in the UI. */
export const DISRUPTIVE_COMMANDS: readonly ScreenCommandType[] = ['restart_app', 'reboot', 'clear_cache', 'install_update'];

export const SendScreenCommandInput = z.object({ orgId: id, screenId: id, type: z.enum(SCREEN_COMMANDS) });

/** orgs/{orgId}/screens/{screenId}/commands/{commandId} */
export interface ScreenCommandDoc {
  id: string;
  type: ScreenCommandType;
  status: 'pending' | 'delivered' | 'done' | 'failed' | 'expired';
  createdBy: string;
  createdAt: number;
  deliveredAt: number | null;
  completedAt: number | null;
  /** Free-form result (diagnostics data, error text) — never secrets. */
  result: Record<string, unknown> | null;
  screenshotPath: string | null;
}

/** Device → server: result of a command. Screenshot is a base64 JPEG (≤ ~1.5 MB). */
export const CommandResultBody = z.object({
  id,
  status: z.enum(['done', 'failed']),
  // Missing = null: players leave out null fields (see nullish in devices.ts).
  result: z.record(z.unknown()).nullable().default(null),
  screenshotJpegBase64: z.string().max(2_000_000).nullable().default(null),
});

export const COMMAND_EXPIRY_MS = 30 * 60_000;

// ---------------------------------------------------------------- notifications

export const NOTIFICATION_TYPES = [
  'screen_offline',
  'screen_online',
  'emergency_started',
  'emergency_ended',
  'approval_requested',
  'approval_decided',
  'sensor_alert',
  'sensor_recovered',
  'sensor_stale',
  'sensor_offline',
  'sensor_online',
  'billing_trial_ending',
  'billing_due_soon',
  'billing_past_due',
  'billing_restricted',
  'billing_payment_recorded',
  'billing_request_resolved',
  'support_access_requested',
  'support_access_granted',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** orgs/{orgId}/notifications/{id} — text is rendered client-side from type + params (i18n). */
export interface NotificationDoc {
  id: string;
  type: NotificationType;
  params: Record<string, string | number>;
  link: string | null;
  createdAt: number;
  readBy: string[];
}

export const MarkNotificationsReadInput = z.object({ orgId: id, notificationIds: z.array(id).min(1).max(100) });

// ---------------------------------------------------------------- publish approvals

/** orgs/{orgId}/approvals/{id} */
export interface PublishApprovalDoc {
  id: string;
  screenIds: string[];
  note: string | null;
  status: 'pending' | 'approved' | 'rejected';
  requestedBy: string;
  requestedByEmail: string | null;
  requestedAt: number;
  decidedBy: string | null;
  decidedAt: number | null;
  decisionNote: string | null;
}

export const ReviewPublishInput = z
  .object({
    orgId: id,
    approvalId: id,
    decision: z.enum(['approve', 'reject']),
    note: z.string().trim().max(500).optional(),
  })
  .refine((v) => v.decision === 'approve' || (v.note && v.note.length >= 3), {
    message: 'Add a short reason for rejecting',
    path: ['note'],
  });
