import { FirebaseError } from 'firebase/app';
import { httpsCallable } from 'firebase/functions';
import { CALLABLES } from '@wallx-play/shared';
import i18n from '../i18n';
import { functions, useEmulators } from './firebase';

/** Calls a Cloud Function by its shared name. Server re-validates and authorizes everything. */
export async function call<TOut = void>(name: keyof typeof CALLABLES, data: unknown): Promise<TOut> {
  const fn = httpsCallable<unknown, TOut>(functions, CALLABLES[name]);
  // The callable encoder turns `undefined` fields into `null`, which optional schema fields
  // reject; drop them here (explicit nulls are kept).
  const result = await fn(data === undefined ? data : JSON.parse(JSON.stringify(data)));
  return result.data;
}

const AUTH_ERRORS: Record<string, string> = {
  'auth/invalid-credential': 'errors.auth.invalidCredential',
  'auth/wrong-password': 'errors.auth.invalidCredential',
  'auth/user-not-found': 'errors.auth.invalidCredential',
  'auth/email-already-in-use': 'errors.auth.emailInUse',
  'auth/weak-password': 'errors.auth.weakPassword',
  'auth/too-many-requests': 'errors.auth.tooManyRequests',
  'auth/popup-closed-by-user': 'errors.auth.popupClosed',
  'auth/invalid-verification-code': 'errors.auth.invalidCode',
  'auth/invalid-multi-factor-session': 'errors.auth.mfaSessionExpired',
  'auth/missing-multi-factor-session': 'errors.auth.mfaSessionExpired',
  'auth/operation-not-allowed': 'errors.auth.notEnabled',
  'auth/maximum-second-factor-count-exceeded': 'errors.auth.tooManyFactors',
  'auth/network-request-failed': 'errors.network',
};

/** User-facing message for any error thrown by Firebase or our callables. */
export function errorMessage(err: unknown): string {
  if (err instanceof FirebaseError) {
    if (useEmulators && (err.code === 'auth/network-request-failed' || err.code === 'functions/unavailable')) {
      return i18n.t('errors.emulatorsDown');
    }
    const authKey = AUTH_ERRORS[err.code];
    if (authKey) return i18n.t(authKey);
    // Callable errors carry messages written for end users by our functions.
    if (err.code.startsWith('functions/') && err.code !== 'functions/internal' && err.message) {
      return err.message;
    }
    if (err.code === 'permission-denied' || err.code === 'functions/permission-denied') {
      return i18n.t('errors.permissionDenied');
    }
  }
  return i18n.t('errors.generic');
}
