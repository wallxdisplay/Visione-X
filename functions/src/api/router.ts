import { PRODUCT_NAME, REGION } from '@wallx-play/shared';
import type { Deps } from '../lib/context';
import {
  deviceCommandResult,
  deviceCommands,
  deviceHeartbeat,
  deviceManifest,
  deviceState,
  registerDevice,
  type ApiRequest,
  type ApiResult,
} from '../devices/deviceApi';
import { ingest } from '../sensors/ingest';
import { deviceLive, deviceLiveHistory } from '../sensors/live';
import { deviceMqtt, deviceMqttReadings } from '../sensors/mqtt';
import { deviceBrand } from '../branding/branding';
import { deviceData } from '../integrations/dataSources';
import { devicePlays } from '../reports/plays';
import { handlePublicApi, isPublicApiPath } from '../publicApi/router';

export type RouteResult = ApiResult;

/** Strips the Hosting prefix so routes work both via /api/** and when called directly. */
export function normalizePath(path: string): string {
  const withoutPrefix = path.replace(/^\/api(?=\/|$)/, '');
  return withoutPrefix === '' ? '/' : withoutPrefix;
}

type Handler = (deps: Deps, req: ApiRequest) => Promise<ApiResult>;

const ROUTES: Record<string, Handler> = {
  'GET /v1/health': async () => ({ status: 200, body: { ok: true, service: PRODUCT_NAME, region: REGION } }),
  // Clock for multi-screen sync: players sample it several times and keep the fastest answer.
  'GET /v1/devices/time': async (deps) => ({ status: 200, body: { serverTime: deps.now() } }),
  'POST /v1/devices/register': registerDevice,
  'GET /v1/devices/me': deviceState,
  'GET /v1/devices/manifest': deviceManifest,
  'POST /v1/devices/heartbeat': deviceHeartbeat,
  'GET /v1/devices/commands': deviceCommands,
  'POST /v1/devices/commands/result': deviceCommandResult,
  'GET /v1/devices/live': deviceLive,
  'GET /v1/devices/live/history': deviceLiveHistory,
  'GET /v1/devices/data': deviceData,
  'POST /v1/devices/plays': devicePlays,
  'GET /v1/devices/mqtt': deviceMqtt,
  'GET /v1/devices/brand': deviceBrand,
  'POST /v1/devices/mqtt/readings': deviceMqttReadings,
  'POST /v1/ingest': ingest,
};

export function findRoute(method: string, rawPath: string): Handler | null {
  return ROUTES[`${method} ${normalizePath(rawPath)}`] ?? null;
}

export async function handle(deps: Deps, req: ApiRequest): Promise<ApiResult> {
  const handler = findRoute(req.method, req.path);
  if (!handler) {
    // Organization API (API keys): screens, publish, emergencies, reports.
    const path = normalizePath(req.path);
    if (isPublicApiPath(path)) return handlePublicApi(deps, req, path);
    return { status: 404, body: { error: 'not_found' } };
  }
  return handler(deps, req);
}
