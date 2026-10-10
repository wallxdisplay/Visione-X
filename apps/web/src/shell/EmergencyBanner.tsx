import { Button } from '@visione-x/ui';
import { Siren } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useActiveEmergencies } from '../content/ops';
import { call, errorMessage } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { useOrg } from '../org/OrgProvider';

/** Persistent red banner on every page while an emergency override is running. */
export function EmergencyBanner() {
  const { t } = useTranslation();
  const { orgId, can } = useOrg();
  const active = useActiveEmergencies(orgId);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!active.data.length) return null;

  async function end(id: string) {
    setBusy(id);
    setError(null);
    try {
      await call('endEmergency', { orgId, emergencyId: id });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="emergency-banner" role="alert">
      {active.data.map((e) => (
        <div key={e.id} className="emergency-banner__row">
          <Siren size={18} aria-hidden />
          <span>
            <strong>{t('emergency.activeTitle', { name: e.name })}</strong>{' '}
            {t('emergency.activeBody', {
              screens: e.screenCount,
              by: e.startedByEmail ?? '',
              until: e.expiresAt ? t('emergency.endsAt', { at: formatDateTime(e.expiresAt) }) : t('emergency.untilEnded'),
            })}
          </span>
          {can('emergency.trigger') ? (
            <Button size="sm" disabled={busy === e.id} onClick={() => void end(e.id)}>
              {t('emergency.end')}
            </Button>
          ) : null}
        </div>
      ))}
      {error ? <div className="emergency-banner__error">{error}</div> : null}
    </div>
  );
}
