import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FieldValue } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { mediaStoragePath, paths, type MediaDoc, type MediaVariant } from '@wallx-play/shared';
import type { Deps } from '../lib/context';
import {
  THUMB_SIDE,
  MAX_IMAGE_SIDE,
  friendlyProcessingError,
  parseProbe,
  planImage,
  planVideo,
  posterArgs,
  transcodeArgs,
} from './plan';

const ORIGINAL = /^orgs\/([A-Za-z0-9_-]+)\/media\/([A-Za-z0-9_-]+)\/original$/;

export function parseOriginalPath(path: string): { orgId: string; mediaId: string } | null {
  const m = ORIGINAL.exec(path);
  return m ? { orgId: m[1]!, mediaId: m[2]! } : null;
}

async function binaries() {
  const [{ default: ffmpeg }, { default: ffprobe }] = await Promise.all([
    import('@ffmpeg-installer/ffmpeg'),
    import('@ffprobe-installer/ffprobe'),
  ]);
  return { ffmpeg: ffmpeg.path, ffprobe: ffprobe.path };
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err = (err + d).slice(-4000)));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err || `${cmd} exited ${code}`))));
  });
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/**
 * Processes an uploaded original: validates it, extracts metadata, makes a display variant
 * screens can play and a thumbnail, records checksums, and corrects the storage quota.
 * Idempotent: only acts on media still in `uploading` state.
 */
export async function processUploadedMedia(
  deps: Deps,
  object: { name: string; size: number; contentType?: string | undefined },
): Promise<'processed' | 'failed' | 'ignored'> {
  const ids = parseOriginalPath(object.name);
  if (!ids) return 'ignored';
  const { db, bucket, now } = deps;
  const ref = db.doc(paths.media(ids.orgId, ids.mediaId));

  // Claim the item (uploading → processing) so retried events do not process twice.
  const media = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const doc = snap.data() as MediaDoc;
    if (doc.status !== 'uploading') return undefined;
    tx.update(ref, { status: 'processing', processingStartedAt: now(), updatedAt: now() });
    return doc;
  });
  if (media === null) {
    // Upload for a media item that was deleted meanwhile: remove the orphan.
    await bucket.file(object.name).delete({ ignoreNotFound: true });
    return 'ignored';
  }
  if (media === undefined) return 'ignored';

  const dir = await mkdtemp(join(tmpdir(), 'media-'));
  const uploaded: string[] = [];
  try {
    if (object.size > media.bytes) throw new Error('The uploaded file is larger than declared.');
    if (object.contentType !== media.mimeType) throw new Error('The uploaded file type does not match.');

    const original = join(dir, 'original');
    await bucket.file(object.name).download({ destination: original });
    const originalSha = await sha256File(original);

    const update: Partial<MediaDoc> = {};
    let display: MediaVariant = {
      path: media.originalPath,
      mimeType: media.mimeType,
      bytes: object.size,
      sha256: originalSha,
    };
    let thumbFile: string | null = null;

    if (media.type === 'image') {
      const { default: sharp } = await import('sharp');
      const meta = await sharp(original, { animated: true }).metadata();
      const width = meta.width ?? 0;
      const height = meta.pageHeight ?? meta.height ?? 0;
      update.width = width;
      update.height = height;
      const plan = planImage({ format: meta.format, width, height });
      if (plan.action === 'convert') {
        const out = join(dir, `display.${plan.to === 'png' ? 'png' : 'jpg'}`);
        const img = sharp(original).rotate().resize(MAX_IMAGE_SIDE, MAX_IMAGE_SIDE, { fit: 'inside', withoutEnlargement: true });
        const info = await (plan.to === 'png' ? img.png() : img.jpeg({ quality: 85 })).toFile(out);
        const path = mediaStoragePath(ids.orgId, ids.mediaId, plan.to === 'png' ? 'display.png' : 'display.jpg');
        display = {
          path,
          mimeType: plan.to === 'png' ? 'image/png' : 'image/jpeg',
          bytes: info.size,
          width: info.width,
          height: info.height,
          sha256: await sha256File(out),
        };
        await bucket.upload(out, { destination: path, metadata: { contentType: display.mimeType } });
        uploaded.push(path);
      } else {
        display = { ...display, width, height };
      }
      thumbFile = join(dir, 'thumb.jpg');
      await sharp(original).rotate().resize(THUMB_SIDE, THUMB_SIDE, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 75 }).toFile(thumbFile);
    } else {
      const { ffmpeg, ffprobe } = await binaries();
      const probe = parseProbe(
        JSON.parse(await run(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', original])),
      );
      if (probe.durationSec) update.durationSec = Math.round(probe.durationSec * 10) / 10;

      if (media.type === 'video') {
        if (!probe.video) throw new Error('Invalid data found: no video stream.');
        const plan = planVideo(probe);
        if (plan.action === 'transcode') {
          logger.info('Transcoding', { mediaId: ids.mediaId, reasons: plan.reasons });
          const out = join(dir, 'display.mp4');
          await run(ffmpeg, transcodeArgs(original, out, !!probe.audio));
          const after = parseProbe(
            JSON.parse(await run(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', out])),
          );
          const path = mediaStoragePath(ids.orgId, ids.mediaId, 'display.mp4');
          display = {
            path,
            mimeType: 'video/mp4',
            bytes: (await stat(out)).size,
            width: after.video?.width ?? 0,
            height: after.video?.height ?? 0,
            sha256: await sha256File(out),
          };
          await bucket.upload(out, { destination: path, metadata: { contentType: 'video/mp4' } });
          uploaded.push(path);
        } else {
          display = { ...display, width: probe.video.width, height: probe.video.height };
        }
        update.width = display.width ?? probe.video.width;
        update.height = display.height ?? probe.video.height;
        thumbFile = join(dir, 'thumb.jpg');
        await run(ffmpeg, posterArgs(original, thumbFile, probe.durationSec));
      } else if (!probe.audio) {
        throw new Error('Invalid data found: no audio stream.');
      }
    }

    let thumb: MediaVariant | undefined;
    if (thumbFile) {
      const path = mediaStoragePath(ids.orgId, ids.mediaId, 'thumb.jpg');
      await bucket.upload(thumbFile, { destination: path, metadata: { contentType: 'image/jpeg' } });
      uploaded.push(path);
      thumb = { path, mimeType: 'image/jpeg', bytes: (await stat(thumbFile)).size };
    }

    const storedBytes =
      object.size + (display.path !== media.originalPath ? display.bytes : 0) + (thumb?.bytes ?? 0);
    const batch = db.batch();
    batch.update(ref, {
      ...update,
      status: 'ready',
      display,
      ...(thumb ? { thumb } : {}),
      storedBytes,
      updatedAt: now(),
    });
    batch.set(
      db.doc(paths.orgUsage(ids.orgId)),
      { storageBytes: FieldValue.increment(storedBytes - media.storedBytes), updatedAt: now() },
      { merge: true },
    );
    await batch.commit();
    return 'processed';
  } catch (err) {
    logger.warn('Media processing failed', { mediaId: ids.mediaId, error: String(err) });
    // Free everything: the original and any variants, and release the reserved quota.
    await Promise.all(
      [object.name, ...uploaded].map((p) => bucket.file(p).delete({ ignoreNotFound: true }).catch(() => undefined)),
    );
    const batch = db.batch();
    batch.update(ref, { status: 'failed', error: friendlyProcessingError(err), storedBytes: 0, updatedAt: now() });
    batch.set(
      db.doc(paths.orgUsage(ids.orgId)),
      { storageBytes: FieldValue.increment(-media.storedBytes), updatedAt: now() },
      { merge: true },
    );
    await batch.commit();
    return 'failed';
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
