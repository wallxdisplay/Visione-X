import { setGlobalOptions } from 'firebase-functions/v2';
import { REGION } from '@visione-x/shared';

// Every function runs in Mumbai next to Firestore and Storage.
setGlobalOptions({ region: REGION, maxInstances: 20 });

export { api } from './api/index';
