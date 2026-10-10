import { describe, expect, it } from 'vitest';
import { normalizePath, route } from './router';

describe('api router', () => {
  it('normalizes the hosting prefix', () => {
    expect(normalizePath('/api/v1/health')).toBe('/v1/health');
    expect(normalizePath('/v1/health')).toBe('/v1/health');
    expect(normalizePath('/api')).toBe('/');
    expect(normalizePath('/apiary')).toBe('/apiary');
  });

  it('serves health', () => {
    expect(route('GET', '/api/v1/health').status).toBe(200);
  });

  it('returns 404 for unknown routes and wrong methods', () => {
    expect(route('GET', '/api/v1/nope').status).toBe(404);
    expect(route('POST', '/api/v1/health').status).toBe(404);
  });
});
