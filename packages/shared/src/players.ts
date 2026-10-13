/**
 * Player app releases (in-app updates). Platform staff upload a signed APK; the server reads
 * its package, version and signing certificate, and a rollout decides which players get it:
 * nobody (draft), some organizations (pilot), everyone (all) or nobody again (withdrawn).
 * Players learn about it from GET /devices/me and report progress in heartbeats.
 */
import { z } from 'zod';

export const PLAYER_PACKAGE = 'com.wallx.play';
export const PLAYER_APK_MIME = 'application/vnd.android.package-archive';
export const MAX_PLAYER_APK_BYTES = 150 * 1024 * 1024;

export const PLAYER_ROLLOUTS = ['draft', 'pilot', 'all', 'withdrawn'] as const;
export type PlayerRollout = (typeof PLAYER_ROLLOUTS)[number];
export const MAX_PILOT_ORGS = 50;

/** playerReleases/{id}; the APK is at paths.playerApk(id). */
export interface PlayerReleaseDoc {
  id: string;
  /** "uploading" until the APK is checked; "failed" keeps the reason. */
  status: 'uploading' | 'ready' | 'failed';
  error: string | null;
  /** Size the uploader declared (the upload may not be larger). */
  bytes: number;
  versionCode: number | null;
  versionName: string | null;
  minSdk: number | null;
  sha256: string | null;
  signerSha256: string | null;
  notes: string;
  rollout: PlayerRollout;
  pilotOrgIds: string[];
  createdAt: number;
  createdBy: string;
  updatedAt: number;
  updatedBy: string;
  publishedAt: number | null;
}

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);

export const CreatePlayerReleaseInput = z.object({ bytes: z.number().int().positive().max(MAX_PLAYER_APK_BYTES) });
export const RegisterPlayerReleaseInput = z.object({ releaseId: id, notes: z.string().trim().max(500).default('') });
export const SetPlayerRolloutInput = z
  .object({ releaseId: id, rollout: z.enum(PLAYER_ROLLOUTS), pilotOrgIds: z.array(id).max(MAX_PILOT_ORGS).default([]) })
  .refine((v) => v.rollout !== 'pilot' || v.pilotOrgIds.length > 0, { path: ['pilotOrgIds'], message: 'Choose at least one organization' });

/** Sent to a player (GET /devices/me) when a newer release is rolled out to it. */
export interface PlayerUpdate {
  versionCode: number;
  versionName: string;
  url: string;
  sha256: string;
  bytes: number;
}

/** What the player reports about an update in progress (heartbeat → screen health). */
export const PLAYER_UPDATE_STATES = ['downloading', 'installing', 'waiting_user', 'failed'] as const;
export const PlayerUpdateStatus = z.object({
  versionCode: z.number().int().positive(),
  versionName: z.string().max(40),
  state: z.enum(PLAYER_UPDATE_STATES),
  /** Players leave out empty fields, so a missing error is null. */
  error: z.string().max(200).nullable().default(null),
  at: z.number().int(),
});
export type PlayerUpdateStatus = z.infer<typeof PlayerUpdateStatus>;

type Rollable = Pick<PlayerReleaseDoc, 'status' | 'rollout' | 'pilotOrgIds' | 'versionCode' | 'minSdk'>;

/** The newest release rolled out to this org that the box's Android version can run. */
export function releaseFor<T extends Rollable>(releases: readonly T[], orgId: string, sdkInt: number | null): T | null {
  let best: T | null = null;
  for (const r of releases) {
    if (r.status !== 'ready' || !r.versionCode) continue;
    if (!(r.rollout === 'all' || (r.rollout === 'pilot' && r.pilotOrgIds.includes(orgId)))) continue;
    if (r.minSdk && sdkInt && sdkInt < r.minSdk) continue;
    if (!best || r.versionCode > best.versionCode!) best = r;
  }
  return best;
}
