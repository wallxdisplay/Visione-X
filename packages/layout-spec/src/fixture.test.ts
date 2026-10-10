import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Manifest } from './schema';

// The same file is parsed by the Android player's unit tests (ManifestFixtureTest.kt), so the
// TypeScript schema and the Kotlin models cannot drift apart unnoticed.
describe('shared manifest fixture', () => {
  it('is a valid manifest', () => {
    const raw = JSON.parse(readFileSync(new URL('../fixtures/manifest.sample.json', import.meta.url), 'utf8'));
    const result = Manifest.safeParse(raw);
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
  });
});
