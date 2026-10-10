import { onRequest } from 'firebase-functions/v2/https';
import { BASE_OPTIONS } from '../options';
import { route } from './router';

/**
 * Public HTTPS API, served at /api/** through the Hosting rewrite.
 * Later phases add device, ingest (ESP32) and billing-webhook routes here, each with its own
 * authentication (device token, sensor API key, gateway signature).
 */
export const api = onRequest({ ...BASE_OPTIONS, cors: false, memory: '256MiB' }, async (req, res) => {
  const result = route(req.method, req.path);
  res.status(result.status).json(result.body);
});
