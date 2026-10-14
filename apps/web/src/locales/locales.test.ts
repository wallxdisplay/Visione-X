/**
 * Every translation must have exactly the English keys and keep each {{placeholder}}, so no
 * screen shows a raw key or loses a value. (Wording is reviewed by people, not by this test.)
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = __dirname;
const files = readdirSync(join(dir, 'en')).filter((f) => f.endsWith('.json'));

function flatten(obj: Record<string, unknown>, prefix = '', out: Record<string, string> = {}): Record<string, string> {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') out[key] = v;
    else flatten(v as Record<string, unknown>, key, out);
  }
  return out;
}

const read = (lng: string, file: string) => flatten(JSON.parse(readFileSync(join(dir, lng, file), 'utf8')) as Record<string, unknown>);
const placeholders = (s: string) => [...s.matchAll(/\{\{\s*([\w.]+)[^}]*\}\}/g)].map((m) => m[1]).sort();

describe.each(['hi', 'mr'])('%s translation', (lng) => {
  it.each(files)('%s has the English keys and placeholders', (file) => {
    const en = read('en', file);
    const tr = read(lng, file);
    expect(Object.keys(tr).sort()).toEqual(Object.keys(en).sort());
    for (const [key, text] of Object.entries(en)) {
      expect(placeholders(tr[key]!), `${file}: ${key}`).toEqual(placeholders(text));
      expect(tr[key]!.trim(), `${file}: ${key} is empty`).not.toBe('');
    }
  });
});
