import { useEmulators } from '../lib/firebase';

/**
 * WallX staff must sign in with an authenticator app (TOTP); customers may choose to.
 * Cloud Functions refuse staff sessions without one (functions/src/lib/authz.ts). Off with the
 * emulators, which cannot do TOTP.
 */
export const staffMfaRequired = !useEmulators;

/** Where people set up or remove two-step verification. */
export const SECURITY_PATH = '/account/security';

/** Name shown in authenticator apps next to the account email. */
export const TOTP_ISSUER = 'WallX Play';
