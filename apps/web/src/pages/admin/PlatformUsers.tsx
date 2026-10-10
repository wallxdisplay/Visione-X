import { collection, orderBy, query } from 'firebase/firestore';
import { Alert, Button, Card, PageHeader, SelectField, StatusChip, TextField } from '@visione-x/ui';
import { PLATFORM_ROLES, hasPlatformPermission, type PlatformUserDoc } from '@visione-x/shared';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../auth/AuthProvider';
import { call, errorMessage } from '../../lib/api';
import { db } from '../../lib/firebase';
import { formatDateTime } from '../../lib/format';
import { useQueryData } from '../../lib/hooks';

export function PlatformUsers() {
  const { t } = useTranslation();
  const { user, platformRole } = useAuth();
  const canManage = hasPlatformPermission(platformRole, 'platformUser.manage');
  const staff = useQueryData<PlatformUserDoc>(canManage ? 'platformUsers' : null, () =>
    query(collection(db, 'platformUsers'), orderBy('email')),
  );
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<string>('support');
  const [status, setStatus] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function apply(targetEmail: string, newRole: string | null) {
    setBusy(true);
    setStatus(null);
    try {
      await call('setPlatformRole', { email: targetEmail, role: newRole });
      setStatus({ tone: 'success', text: t('admin.users.saved', { email: targetEmail }) });
      setEmail('');
    } catch (err) {
      setStatus({ tone: 'danger', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void apply(email, role);
  }

  if (!canManage) {
    return (
      <>
        <PageHeader title={t('nav.admin.users')} />
        <Alert tone="info">{t('admin.users.superadminOnly')}</Alert>
      </>
    );
  }

  return (
    <>
      <PageHeader title={t('nav.admin.users')} description={t('admin.users.description')} />
      <div className="vx-stack">
        <Card title={t('admin.users.grant')}>
          <form className="vx-form" onSubmit={onSubmit}>
            {status ? <Alert tone={status.tone}>{status.text}</Alert> : null}
            <div className="vx-form__row">
              <TextField
                label={t('auth.email')}
                type="email"
                required
                hint={t('admin.users.emailHint')}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <SelectField
                label={t('team.role')}
                options={PLATFORM_ROLES.map((r) => ({ value: r, label: t(`platformRoles.${r}`) }))}
                value={role}
                onChange={(e) => setRole(e.target.value)}
              />
            </div>
            <div className="vx-form__actions">
              <Button type="submit" variant="primary" disabled={busy || !email}>
                {t('admin.users.grantAction')}
              </Button>
            </div>
          </form>
        </Card>

        <div className="vx-table-wrap">
          <table className="vx-table">
            <thead>
              <tr>
                <th>{t('auth.email')}</th>
                <th>{t('team.role')}</th>
                <th>{t('admin.approvals.status')}</th>
                <th>{t('admin.users.updated')}</th>
                <th aria-label={t('common.actions')} />
              </tr>
            </thead>
            <tbody>
              {staff.data.map((s) => (
                <tr key={s.uid}>
                  <td>{s.email}</td>
                  <td>{t(`platformRoles.${s.platformRole}`)}</td>
                  <td>
                    <StatusChip tone={s.active ? 'success' : 'neutral'}>
                      {s.active ? t('status.active') : t('admin.users.revoked')}
                    </StatusChip>
                  </td>
                  <td className="vx-tabular">{formatDateTime(s.updatedAt)}</td>
                  <td className="vx-actions">
                    {s.active && s.uid !== user?.uid ? (
                      <Button size="sm" variant="tertiary" disabled={busy} onClick={() => void apply(s.email, null)}>
                        {t('admin.users.revoke')}
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
