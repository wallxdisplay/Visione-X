import { onObjectFinalized } from 'firebase-functions/v2/storage';
import { getDeps } from '../lib/admin';
import { REGION } from '@wallx-play/shared';
import { processUploadedMedia } from './process';

/**
 * Runs when a file lands in the media bucket. Video conversion needs more memory and time
 * than request handlers, and gets its own small instance cap to stay within CPU quota.
 * Uploads are capped at 500 MB (MEDIA_LIMITS) so a run fits in the 9-minute event limit.
 */
export const processMedia = onObjectFinalized(
  { region: REGION, memory: '2GiB', cpu: 1, timeoutSeconds: 540, maxInstances: 3, retry: false },
  async (event) => {
    const { name, size, contentType } = event.data;
    if (!name?.endsWith('/original')) return;
    await processUploadedMedia(getDeps(), { name, size: Number(size), contentType });
  },
);
