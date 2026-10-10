/**
 * GST split. Rates are configuration (taxRates collection), not constants — confirm the
 * applicable treatment with the accountant before production.
 *
 * Intra-state supply (supplier state == place of supply): CGST + SGST, half each.
 * Inter-state supply: IGST.
 * All amounts are integer paise; rounding is half-up per component.
 */

export interface GstBreakdown {
  taxableMinor: number;
  cgstMinor: number;
  sgstMinor: number;
  igstMinor: number;
  totalTaxMinor: number;
  grandTotalMinor: number;
}

function percentOf(amountMinor: number, rateBps: number): number {
  return Math.round((amountMinor * rateBps) / 10_000);
}

export function computeGst(input: {
  taxableMinor: number;
  rateBps: number;
  supplierStateCode: string;
  placeOfSupplyStateCode: string;
}): GstBreakdown {
  const { taxableMinor, rateBps, supplierStateCode, placeOfSupplyStateCode } = input;
  if (!Number.isInteger(taxableMinor) || taxableMinor < 0) {
    throw new Error('taxableMinor must be a non-negative integer (paise)');
  }

  if (supplierStateCode === placeOfSupplyStateCode) {
    const half = percentOf(taxableMinor, rateBps / 2);
    return {
      taxableMinor,
      cgstMinor: half,
      sgstMinor: half,
      igstMinor: 0,
      totalTaxMinor: half * 2,
      grandTotalMinor: taxableMinor + half * 2,
    };
  }

  const igst = percentOf(taxableMinor, rateBps);
  return {
    taxableMinor,
    cgstMinor: 0,
    sgstMinor: 0,
    igstMinor: igst,
    totalTaxMinor: igst,
    grandTotalMinor: taxableMinor + igst,
  };
}

/** Subscription price for a period, before tax. */
export function subscriptionAmountMinor(input: {
  pricePerScreenMonthlyMinor: number;
  screens: number;
  interval: 'monthly' | 'annual';
  annualDiscountBps: number;
  extraDiscountBps?: number;
}): number {
  const { pricePerScreenMonthlyMinor, screens, interval, annualDiscountBps, extraDiscountBps = 0 } =
    input;
  const months = interval === 'annual' ? 12 : 1;
  const gross = pricePerScreenMonthlyMinor * screens * months;
  const afterAnnual = interval === 'annual' ? gross - percentOf(gross, annualDiscountBps) : gross;
  return afterAnnual - percentOf(afterAnnual, extraDiscountBps);
}
