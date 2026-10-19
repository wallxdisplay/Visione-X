/**
 * Cost tracking counters, added to writes that happen anyway: today's counts are incremented and
 * days older than USAGE_KEEP_DAYS are removed from the doc that was already read.
 */
import { FieldValue } from 'firebase-admin/firestore';
import { staleUsageKeys, usageKey, type UsageCounters, type UsageDay } from '@wallx-play/shared';

export function usageFields(existing: UsageCounters | undefined, at: number, add: UsageDay): Record<string, FieldValue> {
  const key = usageKey(at);
  const out: Record<string, FieldValue> = {};
  for (const [k, v] of Object.entries(add)) if (v) out[`usage.${key}.${k}`] = FieldValue.increment(v);
  for (const old of staleUsageKeys(existing, at)) out[`usage.${old}`] = FieldValue.delete();
  return out;
}
