/**
 * Player releases: upload (reserve → browser uploads the APK → check), rollout, and what each
 * player is offered. See packages/shared/src/players.ts.
 */
import { createHash } from 'node:crypto';
import { HttpsError } from 'firebase-functions/v2/https';
import type { z } from 'zod';
import {
  PLATFORM_AUDIT_CHAIN,
  PLAYER_PACKAGE,
  paths,
  releaseFor,
  type CreatePlayerReleaseInput,
  type PlayerReleaseDoc,
  type PlayerUpdate,
  type RegisterPlayerReleaseInput,
  type SetPlayerRolloutInput,
} from '@wallx-play/shared';
import { auditedTransaction, platformAudit } from '../lib/audit';
import { requirePlatform } from '../lib/authz';
import type { Actor, Deps } from '../lib/context';
import { downloadUrl } from '../lib/storageUrl';
import { ApkError, inspectApk } from './apk';

/** Fingerprint of the key every release must be signed with (set by the first release). */
interface PlayerSigning {
  playerSignerSha256?: string;
}

/** Reserves an upload slot; the browser then uploads the APK to paths.playerApk(releaseId). */
export async function createPlayerReleaseUpload(
  { db, now }: Deps,
  actor: Actor,
  input: z.infer<typeof CreatePlayerReleaseInput>,
): Promise<{ releaseId: string; path: string }> {
  requirePlatform(actor, 'player.release');
  const at = now();
  const ref = db.collection(paths.playerReleases()).doc();
  const doc: PlayerReleaseDoc = {
    id: ref.id,
    status: 'uploading',
    error: null,
    bytes: input.bytes,
    versionCode: null,
    versionName: null,
    minSdk: null,
    sha256: null,
    signerSha256: null,
    notes: '',
    rollout: 'draft',
    pilotOrgIds: [],
    createdAt: at,
    createdBy: actor.uid,
    updatedAt: at,
    updatedBy: actor.uid,
    publishedAt: null,
  };
  await ref.create(doc);
  return { releaseId: ref.id, path: paths.playerApk(ref.id) };
}

/**
 * Checks the uploaded APK: our package, signed with the WallX Play key, a version newer than
 * every earlier release. A rejected APK is deleted and the release marked failed.
 */
export async function registerPlayerRelease(
  deps: Deps,
  actor: Actor,
  input: z.infer<typeof RegisterPlayerReleaseInput>,
): Promise<{ versionCode: number; versionName: string }> {
  requirePlatform(actor, 'player.release');
  const { db, bucket, now } = deps;
  const ref = db.doc(paths.playerRelease(input.releaseId));
  const release = (await ref.get()).data() as PlayerReleaseDoc | undefined;
  if (!release) throw new HttpsError('not-found', 'Release not found.');
  if (release.status !== 'uploading') throw new HttpsError('failed-precondition', 'This release was already checked.');

  const file = bucket.file(paths.playerApk(input.releaseId));
  const reject = async (message: string): Promise<never> => {
    await file.delete({ ignoreNotFound: true });
    await ref.update({ status: 'failed', error: message, updatedAt: now(), updatedBy: actor.uid });
    throw new HttpsError('invalid-argument', message);
  };

  const [exists] = await file.exists();
  if (!exists) throw new HttpsError('failed-precondition', 'The APK has not been uploaded yet.');
  const [apk] = await file.download();
  if (apk.length > release.bytes) await reject('The uploaded file is larger than announced.');

  let info;
  try {
    info = inspectApk(apk);
  } catch (e) {
    if (e instanceof ApkError) return reject(e.message);
    throw e;
  }
  if (info.packageName !== PLAYER_PACKAGE) await reject(`This APK is “${info.packageName}”, not the WallX Play player (${PLAYER_PACKAGE}).`);
  if (!info.signerSha256) await reject('This APK is not signed with APK Signature Scheme v2 or v3. Build it with ./gradlew assembleRelease.');
  const sha256 = createHash('sha256').update(apk).digest('hex');

  try {
    await auditedTransaction(db, [PLATFORM_AUDIT_CHAIN], async (tx, audit) => {
      const settingsRef = db.doc(paths.platformSettings());
      const [settings, released] = await Promise.all([
        tx.get(settingsRef),
        tx.get(db.collection(paths.playerReleases()).where('status', '==', 'ready')),
      ]);
      const expected = (settings.data() as PlayerSigning | undefined)?.playerSignerSha256;
      if (expected && expected !== info.signerSha256) {
        throw new ApkError('This APK is signed with a different key than earlier releases, so installed players would refuse it.');
      }
      const newest = Math.max(0, ...released.docs.map((d) => (d.data() as PlayerReleaseDoc).versionCode ?? 0));
      if (info.versionCode <= newest) {
        throw new ApkError(`Version code ${info.versionCode} is not newer than the latest release (${newest}). Raise versionCode in build.gradle.kts.`);
      }
      const at = now();
      if (!expected) tx.set(settingsRef, { playerSignerSha256: info.signerSha256 }, { merge: true });
      tx.update(ref, {
        status: 'ready',
        versionCode: info.versionCode,
        versionName: info.versionName,
        minSdk: info.minSdk,
        sha256,
        signerSha256: info.signerSha256,
        bytes: apk.length,
        notes: input.notes ?? '',
        updatedAt: at,
        updatedBy: actor.uid,
      });
      audit(PLATFORM_AUDIT_CHAIN, {
        at,
        ...platformAudit(actor),
        orgId: null,
        action: 'player.release.uploaded',
        target: { type: 'playerRelease', id: input.releaseId },
        data: { versionCode: info.versionCode, versionName: info.versionName, sha256, signerSha256: info.signerSha256, firstSigner: !expected },
      });
    });
  } catch (e) {
    if (e instanceof ApkError) return reject(e.message);
    throw e;
  }
  return { versionCode: info.versionCode, versionName: info.versionName };
}

/** Who gets a release: nobody yet, some organizations, everyone, or nobody any more. */
export async function setPlayerRollout(deps: Deps, actor: Actor, input: z.infer<typeof SetPlayerRolloutInput>): Promise<void> {
  requirePlatform(actor, 'player.release');
  const { db, now } = deps;
  const ref = db.doc(paths.playerRelease(input.releaseId));
  const pilotOrgIds = input.rollout === 'pilot' ? [...new Set(input.pilotOrgIds ?? [])] : [];
  await auditedTransaction(db, [PLATFORM_AUDIT_CHAIN], async (tx, audit) => {
    const release = (await tx.get(ref)).data() as PlayerReleaseDoc | undefined;
    if (!release) throw new HttpsError('not-found', 'Release not found.');
    if (release.status !== 'ready') throw new HttpsError('failed-precondition', 'Only checked releases can be rolled out.');
    const orgs = await Promise.all(pilotOrgIds.map((id) => tx.get(db.doc(paths.org(id)))));
    if (orgs.some((o) => !o.exists)) throw new HttpsError('invalid-argument', 'A selected organization no longer exists.');
    const at = now();
    const live = input.rollout === 'pilot' || input.rollout === 'all';
    tx.update(ref, {
      rollout: input.rollout,
      pilotOrgIds,
      publishedAt: release.publishedAt ?? (live ? at : null),
      updatedAt: at,
      updatedBy: actor.uid,
    });
    audit(PLATFORM_AUDIT_CHAIN, {
      at,
      ...platformAudit(actor),
      orgId: null,
      action: 'player.release.rollout',
      target: { type: 'playerRelease', id: input.releaseId },
      data: { versionName: release.versionName, from: release.rollout, to: input.rollout, pilotOrgIds },
    });
  });
  resetReleaseCache();
}

// ---------------------------------------------------------------- offering updates to players

type Offer = Pick<PlayerReleaseDoc, 'status' | 'rollout' | 'pilotOrgIds' | 'versionCode' | 'minSdk'> & PlayerUpdate;

/** Live releases with their download URLs, refreshed every few minutes per instance (players poll every minute). */
const CACHE_MS = 5 * 60_000;
let cache: { at: number; offers: Offer[] } | null = null;

export function resetReleaseCache(): void {
  cache = null;
}

async function liveReleases({ db, bucket, now }: Deps): Promise<Offer[]> {
  if (cache && now() - cache.at < CACHE_MS) return cache.offers;
  const snap = await db.collection(paths.playerReleases()).where('status', '==', 'ready').where('rollout', 'in', ['pilot', 'all']).get();
  const offers = await Promise.all(
    snap.docs.map(async (d) => {
      const r = d.data() as PlayerReleaseDoc;
      return {
        status: r.status,
        rollout: r.rollout,
        pilotOrgIds: r.pilotOrgIds,
        versionCode: r.versionCode!,
        minSdk: r.minSdk,
        versionName: r.versionName!,
        sha256: r.sha256!,
        bytes: r.bytes,
        url: await downloadUrl(bucket, paths.playerApk(r.id)),
      };
    }),
  );
  cache = { at: now(), offers };
  return offers;
}

/** The update a player in `orgId` should install, if any (the player skips versions it already has). */
export async function updateFor(deps: Deps, orgId: string, sdkInt: number | null): Promise<PlayerUpdate | null> {
  const r = releaseFor(await liveReleases(deps), orgId, sdkInt);
  return r ? { versionCode: r.versionCode!, versionName: r.versionName, url: r.url, sha256: r.sha256, bytes: r.bytes } : null;
}
