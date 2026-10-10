import { randomUUID } from 'node:crypto';
import type { Bucket } from '@google-cloud/storage';

/**
 * Long-lived download URL for a Storage object using a Firebase download token (a random
 * capability stored in the object's metadata). Needs no URL-signing permission. The token is
 * created on first use; deleting the media deletes the object and with it the URL.
 */
export async function downloadUrl(bucket: Bucket, path: string): Promise<string> {
  const file = bucket.file(path);
  const [meta] = await file.getMetadata();
  let token = String(meta.metadata?.firebaseStorageDownloadTokens ?? '').split(',')[0];
  if (!token) {
    token = randomUUID();
    await file.setMetadata({ metadata: { firebaseStorageDownloadTokens: token } });
  }
  const emulator = process.env.FIREBASE_STORAGE_EMULATOR_HOST;
  const origin = emulator ? `http://${emulator}` : 'https://firebasestorage.googleapis.com';
  return `${origin}/v0/b/${bucket.name}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
}
