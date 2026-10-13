import { describe, expect, it } from 'vitest';
import { INGEST_RATE } from '@wallx-play/shared';
import { acceptValue, refill } from './ingest';

describe('acceptValue', () => {
  const temp = { valueType: 'number' as const, min: -40, max: 85 };
  const door = { valueType: 'boolean' as const, min: null, max: null };

  it('checks numbers against the valid range', () => {
    expect(acceptValue(temp, 4.5)).toBe(4.5);
    expect(acceptValue(temp, 120)).toBe('out_of_range');
    expect(acceptValue(temp, true)).toBe('wrong_type');
    expect(acceptValue({ ...temp, min: null, max: null }, 1e6)).toBe(1e6);
  });

  it('stores booleans as 1 / 0', () => {
    expect(acceptValue(door, true)).toBe(1);
    expect(acceptValue(door, false)).toBe(0);
    expect(acceptValue(door, 1)).toBe(1);
    expect(acceptValue(door, 2)).toBe('wrong_type');
  });
});

describe('refill', () => {
  it('adds one token per interval up to capacity', () => {
    expect(refill({ tokens: 0, at: 0 }, INGEST_RATE.refillMs)).toBe(1);
    expect(refill({ tokens: 0.5, at: 0 }, INGEST_RATE.refillMs / 2)).toBe(1);
    expect(refill({ tokens: 2, at: 0 }, 3_600_000)).toBe(INGEST_RATE.capacity);
  });
});
