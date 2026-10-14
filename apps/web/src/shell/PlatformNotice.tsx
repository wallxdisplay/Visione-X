import { activeBanner } from '@wallx-play/shared';
import { Megaphone, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePlatformSettings } from '../lib/platformSettings';

const DISMISSED_KEY = 'wxp:dismissedNotice';

function readDismissed(): string | null {
  try {
    return localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}

/** WallX-wide notice (Super Admin → Platform settings), e.g. planned maintenance. Dismissible per message. */
export function PlatformNotice() {
  const { t } = useTranslation();
  const settings = usePlatformSettings();
  const [dismissed, setDismissed] = useState(readDismissed);
  const banner = activeBanner(settings.data, Date.now());
  if (!banner || dismissed === banner.message) return null;

  const dismiss = () => {
    setDismissed(banner.message);
    try {
      localStorage.setItem(DISMISSED_KEY, banner.message);
    } catch {
      // Private mode: dismissed for this page view only.
    }
  };

  return (
    <div className={`billing-banner billing-banner--${banner.tone}`} role="status">
      <Megaphone size={18} aria-hidden />
      <span>{banner.message}</span>
      <button type="button" className="platform-notice__close" aria-label={t('common.dismiss')} onClick={dismiss}>
        <X size={16} aria-hidden />
      </button>
    </div>
  );
}
