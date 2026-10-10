import { PRODUCT_NAME, REGION } from '@visione-x/shared';

export interface RouteResult {
  status: number;
  body: unknown;
}

/** Strips the Hosting prefix so routes work both via /api/** and when called directly. */
export function normalizePath(path: string): string {
  const withoutPrefix = path.replace(/^\/api(?=\/|$)/, '');
  return withoutPrefix === '' ? '/' : withoutPrefix;
}

export function route(method: string, rawPath: string): RouteResult {
  const path = normalizePath(rawPath);

  if (method === 'GET' && path === '/v1/health') {
    return { status: 200, body: { ok: true, service: PRODUCT_NAME, region: REGION } };
  }

  return { status: 404, body: { error: 'not_found' } };
}
