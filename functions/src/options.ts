import { setGlobalOptions } from 'firebase-functions/v2';
import { REGION } from '@visione-x/shared';

// Must be imported FIRST in index.ts: ES module imports are evaluated before the importing
// module's body, so options set later would not apply to functions already defined.
// cpu 'gcf_gen1' = fractional vCPU sized to memory (~1/6 vCPU at 256MiB): plenty for these
// request handlers, and it keeps new projects inside the regional Cloud Run CPU quota.
// Raise maxInstances (and request a quota increase) as traffic grows.
setGlobalOptions({ region: REGION, maxInstances: 10, cpu: 'gcf_gen1' });

/**
 * Passed explicitly to each function so the region never depends on import order.
 * `invoker: 'public'` lets browsers, devices and webhooks reach the HTTPS endpoint (Cloud Run
 * IAM); it does NOT skip authorization — every handler checks auth, roles and org status
 * itself. Declaring it explicitly makes every deploy re-apply it, not only the first one.
 * Requires the project to allow `allUsers` (org policy "Domain restricted sharing").
 */
export const BASE_OPTIONS = {
  region: REGION,
  invoker: 'public',
  cpu: 'gcf_gen1',
  maxInstances: 10,
} as const;
