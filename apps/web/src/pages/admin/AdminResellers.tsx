import { collection, limit, query } from 'firebase/firestore';
import { Alert, Button, Dialog, PageHeader, SelectField, StatusChip, TextAreaField, TextField } from '@wallx-play/ui';
import { ACCOUNT_STATUSES, hasPlatformPermission, type AccountDoc, type AccountStatus, type OrgDoc } from '@wallx-play/shared';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../auth/AuthProvider';
import { call, errorMessage } from '../../lib/api';
import { db } from '../../lib/firebase';
import { useQueryData, type WithId } from '../../lib/hooks';
import './admin.css';

type Draft = Omit<AccountDoc, 'id' | 'type' | 'createdAt' | 'createdBy' | 'updatedAt' | 'updatedBy' | 'gstin'> & { accountId?: string; gstin: string };
const EMPTY: Draft = { name: '', contactName: '', email: '', phone: '', city: '', gstin: '', status: 'active', notes: '' };

/** Super Admin → Resellers: partner accounts and the organizations they brought (groundwork). */
export function AdminResellers() {
  const { t } = useTranslation();
  const { platformRole } = useAuth();
  const canManage = hasPlatformPermission(platformRole, 'account.manage');
  const accounts = useQueryData<AccountDoc>('admin:accounts', () => query(collection(db, 'accounts'), limit(500)));
  const orgs = useQueryData<OrgDoc>('admin:orgs', () => query(collection(db, 'orgs'), limit(1000)));
  const [editing, setEditing] = useState<Draft | null>(null);
  const [managing, setManaging] = useState<WithId<AccountDoc> | null>(null);
  const count = (id: string) => orgs.data.filter((o) => o.parentAccountId === id).length;
  const sorted = useMemo(() => [...accounts.data].sort((a, b) => a.name.localeCompare(b.name)), [accounts.data]);

  return (
    <>
      <PageHeader
        title={t('nav.admin.resellers')}
        description={t('adminResellers.description')}
        actions={canManage ? <Button variant="primary" onClick={() => setEditing({ ...EMPTY })}>{t('adminResellers.new')}</Button> : null}
      />
      <div className="wxp-table-wrap">
        <table className="wxp-table">
          <thead>
            <tr>
              <th>{t('adminResellers.name')}</th>
              <th>{t('adminResellers.contact')}</th>
              <th>{t('adminResellers.city')}</th>
              <th>{t('adminResellers.status')}</th>
              <th>{t('adminResellers.orgs')}</th>
              <th aria-label={t('common.actions')} />
            </tr>
          </thead>
          <tbody>
            {sorted.map((a) => (
              <tr key={a.id}>
                <td>
                  <strong>{a.name}</strong>
                  {a.gstin ? <div className="wxp-muted wxp-tabular">GSTIN {a.gstin}</div> : null}
                </td>
                <td>
                  {a.contactName || '—'}
                  <div className="wxp-muted">{[a.email, a.phone].filter(Boolean).join(' · ')}</div>
                </td>
                <td>{a.city || '—'}</td>
                <td>
                  <StatusChip tone={a.status === 'active' ? 'success' : 'neutral'}>{t(`adminResellers.statuses.${a.status}`)}</StatusChip>
                </td>
                <td className="wxp-tabular">{count(a.id)}</td>
                <td className="wxp-actions">
                  {canManage ? (
                    <>
                      <Button size="sm" variant="tertiary" onClick={() => setManaging(a)}>{t('adminResellers.manageOrgs')}</Button>
                      <Button size="sm" variant="tertiary" onClick={() => setEditing({ ...a, accountId: a.id, gstin: a.gstin ?? '' })}>{t('common.edit')}</Button>
                    </>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {sorted.length === 0 && !accounts.loading ? <p className="wxp-muted">{t('adminResellers.none')}</p> : null}
      <p className="wxp-muted" style={{ marginTop: 16 }}>{t('adminResellers.later')}</p>

      {editing ? <AccountDialog draft={editing} onClose={() => setEditing(null)} /> : null}
      {managing ? <OrgsDialog account={managing} orgs={orgs.data} onClose={() => setManaging(null)} /> : null}
    </>
  );
}

function AccountDialog({ draft: initial, onClose }: { draft: Draft; onClose: () => void }) {
  const { t } = useTranslation();
  const [d, setD] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof Draft, v: string) => setD({ ...d, [k]: v });

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await call('saveAccount', { ...d, gstin: d.gstin.trim() ? d.gstin.trim().toUpperCase() : null });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      title={d.accountId ? t('adminResellers.edit') : t('adminResellers.new')}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={busy || d.name.trim().length < 2} onClick={() => void save()}>{t('common.save')}</Button>
        </>
      }
    >
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <TextField label={t('adminResellers.name')} required maxLength={120} value={d.name} onChange={(e) => set('name', e.target.value)} />
      <div className="wxp-form__row">
        <TextField label={t('adminResellers.contactName')} maxLength={120} value={d.contactName} onChange={(e) => set('contactName', e.target.value)} />
        <TextField label={t('adminResellers.city')} maxLength={80} value={d.city} onChange={(e) => set('city', e.target.value)} />
      </div>
      <div className="wxp-form__row">
        <TextField label={t('adminResellers.email')} type="email" maxLength={200} value={d.email} onChange={(e) => set('email', e.target.value)} />
        <TextField label={t('adminResellers.phone')} type="tel" maxLength={30} value={d.phone} onChange={(e) => set('phone', e.target.value)} />
      </div>
      <div className="wxp-form__row">
        <TextField label={t('adminResellers.gstin')} maxLength={15} value={d.gstin} onChange={(e) => set('gstin', e.target.value)} />
        <SelectField
          label={t('adminResellers.status')}
          options={ACCOUNT_STATUSES.map((s) => ({ value: s, label: t(`adminResellers.statuses.${s}`) }))}
          value={d.status}
          onChange={(e) => setD({ ...d, status: e.target.value as AccountStatus })}
        />
      </div>
      <TextAreaField label={t('adminResellers.notes')} maxLength={1000} rows={3} value={d.notes} onChange={(e) => set('notes', e.target.value)} />
    </Dialog>
  );
}

function OrgsDialog({ account, orgs, onClose }: { account: WithId<AccountDoc>; orgs: Array<WithId<OrgDoc>>; onClose: () => void }) {
  const { t } = useTranslation();
  const [adding, setAdding] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const assigned = orgs.filter((o) => o.parentAccountId === account.id).sort((a, b) => a.name.localeCompare(b.name));
  const direct = orgs.filter((o) => !o.parentAccountId && o.status !== 'rejected').sort((a, b) => a.name.localeCompare(b.name));

  async function assign(orgId: string, accountId: string | null) {
    setBusy(true);
    setError(null);
    try {
      await call('setOrgAccount', { orgId, accountId, reason });
      setAdding('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const reasonOk = reason.trim().length >= 3;
  return (
    <Dialog open size="lg" title={t('adminResellers.orgsOf', { name: account.name })} onClose={onClose} footer={<Button onClick={onClose}>{t('common.close')}</Button>}>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <TextField label={t('adminResellers.reason')} hint={t('adminResellers.reasonHint')} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
      {assigned.length ? (
        <ul className="support-grants">
          {assigned.map((o) => (
            <li key={o.id} className="support-grant">
              <span>
                <strong>{o.name}</strong> <span className="wxp-muted">· {t(`status.${o.status}`)}</span>
              </span>
              <Button size="sm" variant="tertiary" disabled={busy || !reasonOk} onClick={() => void assign(o.id, null)}>
                {t('adminResellers.makeDirect')}
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="wxp-muted">{t('adminResellers.noOrgs')}</p>
      )}
      {account.status === 'active' ? (
        <div className="wxp-form__row" style={{ alignItems: 'end' }}>
          <SelectField
            label={t('adminResellers.addOrg')}
            options={[{ value: '', label: t('adminResellers.chooseOrg') }, ...direct.map((o) => ({ value: o.id, label: o.name }))]}
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
          />
          <Button variant="primary" disabled={busy || !adding || !reasonOk} onClick={() => void assign(adding, account.id)}>
            {t('adminResellers.assign')}
          </Button>
        </div>
      ) : (
        <Alert tone="info">{t('adminResellers.inactiveHint')}</Alert>
      )}
    </Dialog>
  );
}
