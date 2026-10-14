/**
 * Two-step verification (TOTP authenticator apps) on a REAL Firebase project.
 * Needs Firebase Authentication with Identity Platform (Authentication → Settings in the console).
 *
 * Usage (after `gcloud auth application-default login` with an owner of the project):
 *   npx tsx functions/scripts/mfa.ts --project <project-id>                 shows the current setting
 *   npx tsx functions/scripts/mfa.ts --project <project-id> --enable        turns TOTP on
 *   npx tsx functions/scripts/mfa.ts --project <project-id> --reset <email> removes a lost authenticator
 *
 * Phone (SMS) settings are left as they are. After --reset the person signs in with their
 * password alone and enrolls a new authenticator under Account security (staff are sent there).
 */
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

const USAGE = 'Usage: npx tsx functions/scripts/mfa.ts --project <id> [--enable | --reset <email>]';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const value = process.argv[i + 1];
  if (!value || value.startsWith('--')) {
    console.error(USAGE);
    process.exit(1);
  }
  return value;
}

const projectId = arg('project');
if (!projectId) {
  console.error(USAGE);
  process.exit(1);
}
if (projectId.startsWith('demo-')) {
  console.error('The emulators cannot do TOTP; staff two-step verification is off there. This script is for real projects.');
  process.exit(1);
}

const auth = getAuth(initializeApp({ projectId }));
const fail = (what: string) => (err: { code?: string; message?: string }) => {
  console.error(`Could not ${what}: ${err.code ?? ''} ${err.message ?? err}`);
  if (/identity platform|not.*enabled|CONFIGURATION_NOT_FOUND/i.test(String(err.message))) {
    console.error('Upgrade to Firebase Authentication with Identity Platform first (Firebase console → Authentication → Settings).');
  }
  process.exit(1);
};

const resetEmail = arg('reset')?.toLowerCase();
if (resetEmail) {
  const user = await auth.getUserByEmail(resetEmail).catch(fail(`find ${resetEmail}`));
  const factors = user.multiFactor?.enrolledFactors ?? [];
  if (!factors.length) {
    console.log(`${resetEmail} has no second factor.`);
    process.exit(0);
  }
  await auth.updateUser(user.uid, { multiFactor: { enrolledFactors: null } }).catch(fail('remove the second factors'));
  // Sessions signed in with the old authenticator end too.
  await auth.revokeRefreshTokens(user.uid).catch(fail('end existing sessions'));
  console.log(`Removed ${factors.length} second factor(s) from ${resetEmail} and signed them out everywhere.`);
  process.exit(0);
}

const manager = auth.projectConfigManager();
const before = await manager.getProjectConfig().catch(fail('read the project settings'));
const totpOn = (config: typeof before) =>
  !!config.multiFactorConfig?.providerConfigs?.some((p) => p.state === 'ENABLED' && p.totpProviderConfig);

if (!process.argv.includes('--enable')) {
  console.log(`TOTP two-step verification is ${totpOn(before) ? 'ON' : 'OFF'} for ${projectId}.`);
  if (!totpOn(before)) console.log('Turn it on with --enable.');
  process.exit(0);
}

const after = await manager
  .updateProjectConfig({
    multiFactorConfig: {
      // Keep the phone (SMS) setting as it is; only add the TOTP provider.
      state: before.multiFactorConfig?.state ?? 'DISABLED',
      ...(before.multiFactorConfig?.factorIds ? { factorIds: before.multiFactorConfig.factorIds } : {}),
      // Accept codes up to 5 × 30 s either side, for phones whose clock drifts.
      providerConfigs: [{ state: 'ENABLED', totpProviderConfig: { adjacentIntervals: 5 } }],
    },
  })
  .catch(fail('turn TOTP on'));
console.log(`TOTP two-step verification is ${totpOn(after) ? 'ON' : 'still OFF'} for ${projectId}.`);
