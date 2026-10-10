import { setGlobalOptions } from 'firebase-functions/v2';
import { REGION } from '@visione-x/shared';

// Must be imported FIRST in index.ts: ES module imports are evaluated before the importing
// module's body, so options set later would not apply to functions already defined.
setGlobalOptions({ region: REGION, maxInstances: 20 });

/**
 * Passed explicitly to each function so the region never depends on import order.
 * `invoker: 'public'` lets browsers, devices and webhooks reach the HTTPS endpoint (Cloud Run
 * IAM); it does NOT skip authorization — every handler checks auth, roles and org status
 * itself. Declaring it explicitly makes every deploy re-apply it, not only the first one.
 * Requires the project to allow `allUsers` (org policy "Domain restricted sharing").
 */
export const BASE_OPTIONS = { region: REGION, invoker: 'public' } as const;
