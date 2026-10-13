import { initializeApp, type FirebaseApp } from 'firebase/app';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'firebase/app-check';
import { connectAuthEmulator, getAuth } from 'firebase/auth';
import { connectFirestoreEmulator, getFirestore } from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions } from 'firebase/functions';
import { connectStorageEmulator, getStorage } from 'firebase/storage';
import { REGION } from '@wallx-play/shared';

const env = import.meta.env;
// Dev server defaults to the local emulators; production builds never use them unless told to.
export const useEmulators = env.VITE_USE_EMULATORS ? env.VITE_USE_EMULATORS === 'true' : env.DEV;

const app: FirebaseApp = initializeApp({
  apiKey: env.VITE_FIREBASE_API_KEY || 'demo-key',
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: env.VITE_FIREBASE_PROJECT_ID || 'demo-wallx-play',
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET || 'demo-wallx-play.appspot.com',
  appId: env.VITE_FIREBASE_APP_ID,
});

// App Check (reCAPTCHA Enterprise) shows Firebase that requests come from this web app, before
// any other service starts. Off without a site key and with the emulators (docs/DEVELOPMENT.md).
if (env.VITE_APPCHECK_SITE_KEY && !useEmulators) {
  initializeAppCheck(app, { provider: new ReCaptchaEnterpriseProvider(env.VITE_APPCHECK_SITE_KEY), isTokenAutoRefreshEnabled: true });
}

export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);
export const functions = getFunctions(app, REGION);

if (useEmulators) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
  connectStorageEmulator(storage, '127.0.0.1', 9199);
  connectFunctionsEmulator(functions, '127.0.0.1', 5001);
}
