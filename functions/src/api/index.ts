import { logger } from 'firebase-functions/v2';
import { onRequest } from 'firebase-functions/v2/https';
import { getDeps } from '../lib/admin';
import { BASE_OPTIONS, WEATHER_SECRETS } from '../options';
import { handle } from './router';

/**
 * Public HTTPS API, served at /api/** through the Hosting rewrite and directly.
 * Device endpoints authenticate with device credentials, ESP32 ingest with sensor keys, and the
 * public REST API with organization API keys (publicApi/router.ts).
 */
export const api = onRequest({ ...BASE_OPTIONS, cors: false, memory: '256MiB', secrets: WEATHER_SECRETS }, async (req, res) => {
  try {
    const result = await handle(getDeps(), {
      method: req.method,
      path: req.path,
      headers: req.headers,
      body: req.body,
      query: req.query as Record<string, unknown>,
      ip: String(req.headers['x-forwarded-for'] ?? req.ip ?? '').split(',')[0]!.trim(),
    });
    res.set('Cache-Control', 'no-store');
    res.status(result.status).json(result.body);
  } catch (err) {
    logger.error('API error', err);
    res.status(500).json({ error: 'internal', message: 'Something went wrong.' });
  }
});
