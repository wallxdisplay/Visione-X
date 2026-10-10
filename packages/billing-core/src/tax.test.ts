import { describe, expect, it } from 'vitest';
import { computeGst, subscriptionAmountMinor } from './tax';

describe('computeGst', () => {
  it('splits intra-state into CGST + SGST', () => {
    const r = computeGst({
      taxableMinor: 29_900,
      rateBps: 1800,
      supplierStateCode: '27',
      placeOfSupplyStateCode: '27',
    });
    expect(r.cgstMinor).toBe(2691);
    expect(r.sgstMinor).toBe(2691);
    expect(r.igstMinor).toBe(0);
    expect(r.grandTotalMinor).toBe(35_282);
  });

  it('uses IGST inter-state', () => {
    const r = computeGst({
      taxableMinor: 29_900,
      rateBps: 1800,
      supplierStateCode: '27',
      placeOfSupplyStateCode: '29',
    });
    expect(r.igstMinor).toBe(5382);
    expect(r.cgstMinor + r.sgstMinor).toBe(0);
  });

  it('rejects fractional paise', () => {
    expect(() =>
      computeGst({ taxableMinor: 1.5, rateBps: 1800, supplierStateCode: '27', placeOfSupplyStateCode: '27' }),
    ).toThrow();
  });
});

describe('subscriptionAmountMinor', () => {
  it('applies 15% annual discount', () => {
    // ₹299 × 10 screens × 12 months = ₹35,880 → −15% = ₹30,498
    expect(
      subscriptionAmountMinor({
        pricePerScreenMonthlyMinor: 29_900,
        screens: 10,
        interval: 'annual',
        annualDiscountBps: 1500,
      }),
    ).toBe(3_049_800);
  });

  it('ignores annual discount for monthly billing', () => {
    expect(
      subscriptionAmountMinor({
        pricePerScreenMonthlyMinor: 59_900,
        screens: 2,
        interval: 'monthly',
        annualDiscountBps: 1500,
      }),
    ).toBe(119_800);
  });
});
