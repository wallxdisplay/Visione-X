import { PRODUCT_NAME, REGION } from '@visione-x/shared';
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
import { deviceData } from '../integrations/dataSources';

export type RouteResult = ApiResult;

/** Strips the Hosting prefix so routes work both via /api/** and when called directly. */
export function normalizePath(path: string): string {
  const withoutPrefix = path.replace(/^\/api(?=\/|$)/, '');
  return withoutPrefix === '' ? '/' : withoutPrefix;
}

type Handler = (deps: Deps, req: ApiRequest) => Promise<ApiResult>;

const ROUTES: Record<string, Handler> = {
  'GET /v1/health': async () => ({ status: 200, body: { ok: true, service: PRODUCT_NAME, region: REGION } }),
  'POST /v1/devices/register': registerDevice,
  'GET /v1/devices/me': deviceState,
  'GET /v1/devices/manifest': deviceManifest,
  'POST /v1/devices/heartbeat': deviceHeartbeat,
  'GET /v1/devices/commands': deviceCommands,
  'POST /v1/devices/commands/result': deviceCommandResult,
  'GET /v1/devices/live': deviceLive,
  'GET /v1/devices/live/history': deviceLiveHistory,
  'GET /v1/devices/data': deviceData,
  'POST /v1/ingest': ingest,
};

export function findRoute(method: string, rawPath: string): Handler | null {
  return ROUTES[`${method} ${normalizePath(rawPath)}`] ?? null;
}

export async function handle(deps: Deps, req: ApiRequest): Promise<ApiResult> {
  const handler = findRoute(req.method, req.path);
  if (!handler) return { status: 404, body: { error: 'not_found' } };
  return handler(deps, req);
}
