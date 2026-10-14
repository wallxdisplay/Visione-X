import { paths, type PlatformSettingsDoc } from '@wallx-play/shared';
import { useDoc } from './hooks';

/** Platform-wide settings (support contacts, notice banner, signups switch); readable when signed in. */
export function usePlatformSettings() {
  return useDoc<PlatformSettingsDoc>(paths.platformSettings());
}
