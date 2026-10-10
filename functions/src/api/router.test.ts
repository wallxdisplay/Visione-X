import { describe, expect, it } from 'vitest';
import type { Deps } from '../lib/context';
import { findRoute, handle, normalizePath } from './router';

const req = (method: string, path: string) => ({ method, path, headers: {}, body: {}, ip: '127.0.0.1' });

describe('api router', () => {
  it('normalizes the hosting prefix', () => {
    expect(normalizePath('/api/v1/health')).toBe('/v1/health');
    expect(normalizePath('/v1/health')).toBe('/v1/health');
    expect(normalizePath('/api')).toBe('/');
    expect(normalizePath('/apiary')).toBe('/apiary');
  });

  it('serves health without touching any dependency', async () => {
    expect((await handle({} as Deps, req('GET', '/api/v1/health'))).status).toBe(200);
  });

  it('returns 404 for unknown routes and wrong methods', async () => {
    expect((await handle({} as Deps, req('GET', '/api/v1/nope'))).status).toBe(404);
    expect((await handle({} as Deps, req('POST', '/api/v1/health'))).status).toBe(404);
    expect(findRoute('GET', '/api/v1/devices/register')).toBeNull();
    expect(findRoute('POST', '/api/v1/devices/register')).not.toBeNull();
  });
});
