import { Alert, Button, Dialog, SelectField } from '@wallx-play/ui';
import type { AppDoc, ScreenDoc } from '@wallx-play/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { call, errorMessage } from '../../lib/api';

/** App store: names of the screen apps a screen holds ("" when it holds none). */
export function screenAppNames(screen: ScreenDoc, catalog: AppDoc[]): string {
  return (screen.apps ?? []).map((id) => catalog.find((a) => a.id === id)?.name ?? id).join(', ');
}

/** Choose which screens run each screen app bought (up to the screens bought for it). */
export function AppScreensDialog({
  orgId,
  seats,
  catalog,
  screens,
  onClose,
}: {
  orgId: string;
  /** Screens bought per screen app. */
  seats: Record<string, number>;
  catalog: AppDoc[];
  screens: ScreenDoc[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const apps = catalog.filter((a) => seats[a.id]);
  const authorized = screens.filter((s) => s.status === 'authorized');
  const [appId, setAppId] = useState(apps[0]?.id ?? '');
  const holders = (id: string) => authorized.filter((s) => (s.apps ?? []).includes(id)).map((s) => s.id);
  const [ids, setIds] = useState<string[]>(() => holders(apps[0]?.id ?? ''));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const total = seats[appId] ?? 0;

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      const { republished } = await call<{ republished: number }>('setAppScreens', { orgId, appId, screenIds: ids });
      setMessage({ tone: 'success', text: t('screenApps.saved', { count: republished }) });
    } catch (err) {
      setMessage({ tone: 'danger', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      title={t('screenApps.title')}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t('common.close')}</Button>
          <Button variant="primary" disabled={busy || !appId || ids.length > total} onClick={() => void save()}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}
      <p className="wxp-muted">{t('screenApps.intro')}</p>
      {apps.length === 0 ? (
        <Alert tone="info">{t('screenApps.noneBought')}</Alert>
      ) : (
        <>
          <SelectField
            label={t('screenApps.app')}
            options={apps.map((a) => ({ value: a.id, label: a.name }))}
            value={appId}
            onChange={(e) => {
              setAppId(e.target.value);
              setIds(holders(e.target.value));
              setMessage(null);
            }}
          />
          <fieldset className="check-group check-group--row">
            <legend className="wxp-field__label">{t('screenApps.seats', { used: ids.length, total })}</legend>
            {authorized.map((s) => (
              <label key={s.id} className="day-chip">
                <input
                  type="checkbox"
                  checked={ids.includes(s.id)}
                  disabled={!ids.includes(s.id) && ids.length >= total}
                  onChange={(e) => setIds(e.target.checked ? [...ids, s.id] : ids.filter((x) => x !== s.id))}
                />
                <span>{s.name}</span>
              </label>
            ))}
          </fieldset>
          <p className="wxp-muted">{t('screenApps.autoFill')}</p>
        </>
      )}
    </Dialog>
  );
}
