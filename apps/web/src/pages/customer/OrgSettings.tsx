import { Alert, Button, Card, PageHeader, SelectField, TextField } from '@wallx-play/ui';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { call, errorMessage } from '../../lib/api';
import { timezoneOptions } from '../../lib/format';
import { useOrg } from '../../org/OrgProvider';
import { BrandEditor } from '../../brand/BrandEditor';

export function OrgSettings() {
  const { t } = useTranslation();
  const { orgId, org, can, entitlements } = useOrg();
  const editable = can('org.settings.edit');
  const approvalsInPlan = entitlements?.features.includes('content.approvals') ?? false;
  const timezones = useMemo(timezoneOptions, []);
  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState('Asia/Kolkata');
  const [requireApproval, setRequireApproval] = useState(false);
  const [emailAlerts, setEmailAlerts] = useState(true);
  const [status, setStatus] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (org) {
      setName(org.name);
      setTimezone(org.timezone);
      setRequireApproval(org.settings?.requirePublishApproval ?? false);
      setEmailAlerts(org.settings?.emailNotifications ?? true);
    }
  }, [org]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setStatus(null);
    try {
      await call('updateOrgSettings', {
        orgId,
        name,
        timezone,
        ...(approvalsInPlan ? { requirePublishApproval: requireApproval } : {}),
        emailNotifications: emailAlerts,
      });
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
          <form className="wxp-form" onSubmit={save}>
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
            <div className="wxp-field">
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  disabled={!editable || !approvalsInPlan}
                  checked={requireApproval}
                  onChange={(e) => setRequireApproval(e.target.checked)}
                />
                {t('settings.requireApproval')}
              </label>
              <p className="wxp-field__hint">
                {approvalsInPlan ? t('settings.requireApprovalHint') : t('settings.requireApprovalNotInPlan')}
              </p>
            </div>
            <div className="wxp-field">
              <label className="checkbox-row">
                <input type="checkbox" disabled={!editable} checked={emailAlerts} onChange={(e) => setEmailAlerts(e.target.checked)} />
                {t('settings.emailNotifications')}
              </label>
              <p className="wxp-field__hint">{t('settings.emailNotificationsHint')}</p>
            </div>
            {editable ? (
              <div className="wxp-form__actions">
                <Button type="submit" variant="primary" disabled={busy || name.trim().length < 2}>
                  {t('common.save')}
                </Button>
              </div>
            ) : null}
          </form>
        </Card>
      </div>
      {editable && (entitlements?.features.includes('branding.whiteLabel') || org?.brand) ? (
        <Card title={t('brand.orgTitle')}>
          <p className="wxp-muted">{org?.partnerBrand ? t('brand.orgOverPartner', { name: org.partnerBrand.name }) : t('brand.orgDescription')}</p>
          {entitlements?.features.includes('branding.whiteLabel') ? null : <Alert tone="warning">{t('brand.notInPlan')}</Alert>}
          <BrandEditor key={org?.brand?.updatedAt ?? 0} target={{ kind: 'org', orgId }} current={org?.brand ?? null} />
          {org?.brand?.domains.length ? <p className="wxp-muted">{t('brand.domains', { list: org.brand.domains.join(', ') })}</p> : <p className="wxp-muted">{t('brand.domainHint')}</p>}
        </Card>
      ) : null}
    </>
  );
}
