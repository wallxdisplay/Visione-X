import { Alert, Button, Card, PageHeader, SelectField, TextField } from '@visione-x/ui';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { call, errorMessage } from '../../lib/api';
import { timezoneOptions } from '../../lib/format';
import { useOrg } from '../../org/OrgProvider';

export function OrgSettings() {
  const { t } = useTranslation();
  const { orgId, org, can } = useOrg();
  const editable = can('org.settings.edit');
  const timezones = useMemo(timezoneOptions, []);
  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState('Asia/Kolkata');
  const [status, setStatus] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (org) {
      setName(org.name);
      setTimezone(org.timezone);
    }
  }, [org]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setStatus(null);
    try {
      await call('updateOrgSettings', { orgId, name, timezone });
      setStatus({ tone: 'success', text: t('settings.saved') });
    } catch (err) {
      setStatus({ tone: 'danger', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader title={t('nav.settings')} description={t('settings.description')} />
      <div style={{ maxWidth: 640 }}>
        <Card title={t('settings.general')}>
          <form className="vx-form" onSubmit={save}>
            {status ? <Alert tone={status.tone}>{status.text}</Alert> : null}
            {!editable ? <Alert tone="info">{t('settings.readOnly')}</Alert> : null}
            <TextField
              label={t('settings.orgName')}
              required
              disabled={!editable}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <SelectField
              label={t('settings.timezone')}
              hint={t('settings.timezoneHint')}
              disabled={!editable}
              options={timezones}
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
            />
            {editable ? (
              <div className="vx-form__actions">
                <Button type="submit" variant="primary" disabled={busy || name.trim().length < 2}>
                  {t('common.save')}
                </Button>
              </div>
            ) : null}
          </form>
        </Card>
      </div>
    </>
  );
}
