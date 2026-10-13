/**
 * Screens (org-side) and devices (the Android players), plus the device HTTP API contract.
 * Devices never use Firebase Auth: they hold a random secret issued at registration and call
 * /api/v1/devices/* with `Authorization: Device <deviceId>:<secret>`. Only its hash is stored.
 */
import { PlayerUpdateStatus, type PlayerUpdate } from './players';
import { z } from 'zod';
import { RESOLUTION_PRESETS } from '@wallx-play/layout-spec';

export const DEVICE_STATUSES = ['unpaired', 'pending_authorization', 'authorized', 'revoked'] as const;
export type DeviceStatus = (typeof DEVICE_STATUSES)[number];

export const PAIRING_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; // no 0/O, 1/I/L
export const PAIRING_CODE_LENGTH = 6;
export const PAIRING_TTL_MS = 24 * 3_600_000;
/** Device polls /me this often; heartbeats are sent less often. */
export const DEVICE_POLL_SEC = 30;
export const DEVICE_HEARTBEAT_SEC = 300;
/** A screen is shown as offline when no heartbeat arrived for this long. */
export const OFFLINE_AFTER_MS = 2.5 * DEVICE_HEARTBEAT_SEC * 1000;

export const DeviceHardware = z.object({
  manufacturer: z.string().max(80),
  model: z.string().max(80),
  androidVersion: z.string().max(20),
  sdkInt: z.number().int().min(1).max(100),
  appVersion: z.string().max(40),
  display: z.object({ width: z.number().int().min(1).max(16384), height: z.number().int().min(1).max(16384) }),
});
export type DeviceHardware = z.infer<typeof DeviceHardware>;

/** devices/{deviceId} — server-only (rules deny all client access). */
export interface DeviceDoc {
  id: string;
  status: DeviceStatus;
  secretHash: string;
  pairingCode: string | null;
  pairingExpiresAt: number | null;
  orgId: string | null;
  screenId: string | null;
  hardware: DeviceHardware;
  lastSeen: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface ScreenHealth {
  appVersion: string;
  display: { width: number; height: number };
  storageFreeMb: number | null;
  playing: { playlistId: string | null; itemId: string | null; source: string } | null;
  manifestVersion: number | null;
  errors: string[];
  /** A player update in progress, as last reported. */
  update?: PlayerUpdateStatus | null;
  reportedAt: number;
}

/** orgs/{orgId}/screens/{screenId} — readable by org members. */
export interface ScreenDoc {
  id: string;
  name: string;
  siteId: string | null;
  groupIds: string[];
  orientation: 'landscape' | 'portrait';
  resolution: { width: number; height: number };
  /** Degrees the player rotates its output (portrait LED walls on a landscape HDMI output). */
  rotation?: ScreenRotation;
  deviceId: string | null;
  status: Exclude<DeviceStatus, 'unpaired'>;
  defaultPlaylistId: string | null;
  manifestVersion: number;
  publishedAt: number | null;
  lastSeen: number | null;
  device: { manufacturer: string; model: string; androidVersion: string } | null;
  health: ScreenHealth | null;
  /** Commands queued for the player (it fetches them when this is > 0). */
  pendingCommands: number;
  /** Set when the monitor raised an offline alert; cleared by the next heartbeat. */
  offlineAlertedAt: number | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------- request schemas (callables)

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
export const PairingCode = z
  .string()
  .trim()
  .toUpperCase()
  .transform((s) => s.replace(/[\s-]/g, ''))
  .pipe(z.string().length(PAIRING_CODE_LENGTH).regex(new RegExp(`^[${PAIRING_CODE_ALPHABET}]+$`), 'Invalid pairing code'));

export const SCREEN_ROTATIONS = [0, 90, 180, 270] as const;
export type ScreenRotation = (typeof SCREEN_ROTATIONS)[number];

const ScreenFields = {
  name: z.string().trim().min(1).max(80),
  siteId: id.nullable(),
  groupIds: z.array(id).max(20),
  orientation: z.enum(['landscape', 'portrait']),
  resolution: z.object({ width: z.number().int().min(320).max(7680), height: z.number().int().min(320).max(7680) }),
  rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).default(0),
};

export const ClaimDeviceInput = z.object({ orgId: id, pairingCode: PairingCode, ...ScreenFields });
export const UpdateScreenInput = z.object({
  orgId: id,
  screenId: id,
  ...ScreenFields,
  defaultPlaylistId: id.nullable(),
});
export const ScreenRefInput = z.object({ orgId: id, screenId: id });
export const PublishScreensInput = z.object({
  orgId: id,
  /** Empty = every authorized screen of the org. */
  screenIds: z.array(id).max(500),
});

export const DEFAULT_SCREEN_RESOLUTION = { width: RESOLUTION_PRESETS[0]!.width, height: RESOLUTION_PRESETS[0]!.height };

// ---------------------------------------------------------------- device API payloads

export const RegisterDeviceBody = z.object({ hardware: DeviceHardware });

/**
 * Players serialize with explicitNulls = false, so a null field is left out of the JSON.
 * Device payloads therefore accept a missing nullable field as null.
 */
export const nullish = <T extends z.ZodTypeAny>(schema: T) => schema.nullable().default(null);

export const HeartbeatBody = z.object({
  appVersion: z.string().max(40),
  display: z.object({ width: z.number().int().min(1).max(16384), height: z.number().int().min(1).max(16384) }),
  storageFreeMb: nullish(z.number().int().min(0)),
  playing: nullish(z.object({ playlistId: nullish(z.string().max(128)), itemId: nullish(z.string().max(128)), source: z.string().max(20) })),
  manifestVersion: nullish(z.number().int().min(0)),
  errors: z.array(z.string().max(300)).max(20),
  /** A player update in progress (absent from players before 0.9.0). */
  update: PlayerUpdateStatus.nullable().optional(),
});

export interface DeviceStateResponse {
  deviceId: string;
  status: DeviceStatus;
  pairingCode: string | null;
  pairingExpiresAt: number | null;
  /** Web address encoded in the pairing QR code. */
  pairingUrl: string | null;
  orgName: string | null;
  screen: {
    id: string;
    name: string;
    orientation: 'landscape' | 'portrait';
    resolution: { width: number; height: number };
    manifestVersion: number;
  } | null;
  /** Number of remote commands waiting; fetch them from /devices/commands. */
  commandsPending: number;
  config: { pollSec: number; heartbeatSec: number };
  /** A newer player release rolled out to this screen's organization, if any. */
  update: PlayerUpdate | null;
  serverTime: number;
}

export function isScreenOnline(screen: Pick<ScreenDoc, 'lastSeen'>, now = Date.now()): boolean {
  return !!screen.lastSeen && now - screen.lastSeen < OFFLINE_AFTER_MS;
}
