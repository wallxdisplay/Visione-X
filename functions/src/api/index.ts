import { logger } from 'firebase-functions/v2';
import { onRequest } from 'firebase-functions/v2/https';
import { getDeps } from '../lib/admin';
import { BASE_OPTIONS, WEATHER_SECRETS } from '../options';
import { handle } from './router';

/**
 * Public HTTPS API, served at /api/** through the Hosting rewrite and directly.
 * Device endpoints authenticate with device credentials; later phases add ESP32 ingest and
 * billing webhooks, each with their own authentication.
 */
export const api = onRequest({ ...BASE_OPTIONS, cors: false, memory: '256MiB', secrets: WEATHER_SECRETS }, async (req, res) => {
  try {
    const result = await handle(getDeps(), {
      method: req.method,
      path: req.path,
      headers: req.headers,
      body: req.body,
      ip: String(req.headers['x-forwarded-for'] ?? req.ip ?? '').split(',')[0]!.trim(),
    });
    res.set('Cache-Control', 'no-store');
    res.status(result.status).json(result.body);
  } catch (err) {
    logger.error('API error', err);
    res.status(500).json({ error: 'internal', message: 'Something went wrong.' });
  }
});
