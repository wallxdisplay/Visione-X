import { setGlobalOptions } from 'firebase-functions/v2';
import { REGION } from '@visione-x/shared';

// Must be imported FIRST in index.ts: ES module imports are evaluated before the importing
// module's body, so options set later would not apply to functions already defined.
setGlobalOptions({ region: REGION, maxInstances: 20 });

/** Also passed explicitly to each function so the region never depends on import order. */
export const BASE_OPTIONS = { region: REGION } as const;
