import { setGlobalOptions } from 'firebase-functions/v2';
import { REGION } from '@wallx-play/shared';

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

/**
 * App Check on callables (the web app; players use the device API instead). Off until
 * APP_CHECK_ENFORCE=true is set in functions/.env.wallx-play and functions are redeployed.
 * Before that, callables log requests without a valid App Check token ("appCheck.missing"),
 * so enforcing can wait until real traffic shows tokens (docs/DEVELOPMENT.md).
 */
export const ENFORCE_APP_CHECK = process.env.APP_CHECK_ENFORCE === 'true';

/**
 * Secrets are bound only once they exist: deploying a function that names a missing secret
 * fails. After `npx firebase functions:secrets:set NAME`, the matching switch goes into
 * functions/.env.wallx-play and functions are redeployed (docs/DEVELOPMENT.md).
 *  - SMTP_USER=<sender address>  → SMTP_PASSWORD is mounted for functions that send email.
 *  - WEATHER_PROVIDER=google      → GOOGLE_MAPS_API_KEY is mounted for weather and air quality functions.
 */
export const MAIL_SECRETS: string[] = process.env.SMTP_USER?.trim() ? ['SMTP_PASSWORD'] : [];
export const WEATHER_SECRETS: string[] = process.env.WEATHER_PROVIDER === 'google' ? ['GOOGLE_MAPS_API_KEY'] : [];
