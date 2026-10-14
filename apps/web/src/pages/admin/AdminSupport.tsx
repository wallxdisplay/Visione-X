import { collection, collectionGroup, limit, orderBy, query } from 'firebase/firestore';
import { Alert, Button, Dialog, PageHeader, SelectField, StatusChip, TextField } from '@wallx-play/ui';
import {
  hasPlatformPermission,
  SUPPORT_DURATIONS_HOURS,
  SUPPORT_LEVELS,
  supportGrantActive,
  type OrgDoc,
  type SupportGrantDoc,
  type SupportLevel,
} from '@wallx-play/shared';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { useAuth } from '../../auth/AuthProvider';
import { call, errorMessage } from '../../lib/api';
import { db } from '../../lib/firebase';
import { formatDateTime } from '../../lib/format';
import { useQueryData, type WithId } from '../../lib/hooks';
import { rememberOrg } from '../../org/OrgProvider';
import './admin.css';

/** Super Admin → Support access: request access, open active grants, end them. */
export function AdminSupport() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { platformRole, profile } = useAuth();
  const canRequest = hasPlatformPermission(platformRole, 'support.access.request');
  const canGrant = hasPlatformPermission(platformRole, 'support.access.grant');
  const grants = useQueryData<SupportGrantDoc>('admin:supportGrants', () => query(collectionGroup(db, 'supportGrants'), orderBy('createdAt', 'desc'), limit(100)));
  const orgs = useQueryData<OrgDoc>('admin:orgs', () => query(collection(db, 'orgs'), limit(1000)));
  const orgName = useMemo(() => new Map(orgs.data.map((o) => [o.id, o.name])), [orgs.data]);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Org being opened: go there once the new membership reaches the profile. */
  const [entering, setEntering] = useState<string | null>(null);
  const now = Date.now();

  useEffect(() => {
    if (!entering || !profile?.memberships?.[entering]) return;
    rememberOrg(entering);
    void navigate('/');
  }, [entering, profile, navigate]);

  async function run(action: () => Promise<unknown>, done?: () => void) {
    setBusy(true);
    setError(null);
    try {
      await action();
      done?.();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const state = (g: SupportGrantDoc) => (g.status === 'active' && !supportGrantActive(g, now) ? 'expired' : g.status);

  return (
    <>
      <PageHeader
        title={t('nav.admin.support')}
        description={t('adminSupport.description')}
        actions={canRequest ? <Button variant="primary" onClick={() => setAsking(true)}>{t('adminSupport.request')}</Button> : null}
      />
      {error && !asking ? <Alert tone="danger">{error}</Alert> : null}
      <div className="wxp-table-wrap">
        <table className="wxp-table">
          <thead>
            <tr>
              <th>{t('adminSupport.org')}</th>
              <th>{t('adminSupport.status')}</th>
              <th>{t('adminSupport.access')}</th>
              <th>{t('adminSupport.reason')}</th>
              <th>{t('adminSupport.until')}</th>
              <th aria-label={t('common.actions')} />
            </tr>
          </thead>
          <tbody>
            {grants.data.map((g: WithId<SupportGrantDoc>) => (
              <tr key={`${g.orgId}/${g.id}`}>
                <td>{orgName.get(g.orgId) ?? g.orgId}</td>
                <td>
                  <StatusChip tone={state(g) === 'active' ? 'success' : state(g) === 'requested' ? 'warning' : 'neutral'}>{t(`supportAccess.status.${state(g)}`)}</StatusChip>
                </td>
                <td>
                  {t(`supportAccess.levels.${g.level}`)} · {t(`adminSupport.origins.${g.origin}`, { email: g.requestedBy?.email ?? '' })}
                </td>
                <td className="wxp-muted">{g.reason || '—'}</td>
                <td className="wxp-tabular">{g.expiresAt ? formatDateTime(g.expiresAt) : t('supportAccess.hours', { count: g.hours })}</td>
                <td className="wxp-actions">
                  {canRequest && supportGrantActive(g, now) ? (
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={busy || !!entering}
                      onClick={() =>
                        void run(
                          () => call('openSupportAccess', { orgId: g.orgId, grantId: g.id }),
                          () => setEntering(g.orgId),
                        )
                      }
                    >
                      {t('adminSupport.open')}
                    </Button>
                  ) : null}
                  {canGrant && (supportGrantActive(g, now) || g.status === 'requested') ? (
                    <Button size="sm" variant="tertiary" disabled={busy} onClick={() => void run(() => call('revokeSupportAccess', { orgId: g.orgId, grantId: g.id }))}>
                      {t('supportAccess.end')}
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {grants.data.length === 0 && !grants.loading ? <p className="wxp-muted">{t('adminSupport.none')}</p> : null}
      <p className="wxp-muted" style={{ marginTop: 16 }}>{t('adminSupport.policy')}</p>

      {asking ? <RequestDialog orgs={orgs.data} canGrant={canGrant} onClose={() => setAsking(false)} /> : null}
    </>
  );
}

function RequestDialog({ orgs, canGrant, onClose }: { orgs: Array<WithId<OrgDoc>>; canGrant: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const [orgId, setOrgId] = useState('');
  const [search, setSearch] = useState('');
  const [level, setLevel] = useState<SupportLevel>('view');
  const [hours, setHours] = useState(4);
  const [reason, setReason] = useState('');
  const [emergency, setEmergency] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const q = search.trim().toLowerCase();
  const options = orgs
    .filter((o) => o.status === 'active' && (!q || o.name.toLowerCase().includes(q) || o.id === orgId))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 50);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await call(emergency ? 'emergencySupportAccess' : 'requestSupportAccess', { orgId, level, hours, reason });
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
      title={t('adminSupport.request')}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant={emergency ? 'danger' : 'primary'} disabled={busy || !orgId || reason.trim().length < 5} onClick={() => void submit()}>
            {emergency ? t('adminSupport.grantNow') : t('adminSupport.send')}
          </Button>
        </>
      }
    >
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <TextField label={t('adminSupport.searchOrgs')} value={search} onChange={(e) => setSearch(e.target.value)} />
      <SelectField
        label={t('adminSupport.org')}
        options={[{ value: '', label: t('adminSupport.chooseOrg') }, ...options.map((o) => ({ value: o.id, label: o.name }))]}
        value={orgId}
        onChange={(e) => setOrgId(e.target.value)}
      />
      <div className="wxp-form__row">
        <SelectField
          label={t('supportAccess.level')}
          options={SUPPORT_LEVELS.map((l) => ({ value: l, label: t(`supportAccess.levels.${l}`) }))}
          value={level}
          onChange={(e) => setLevel(e.target.value as SupportLevel)}
        />
        <SelectField
          label={t('supportAccess.duration')}
          options={SUPPORT_DURATIONS_HOURS.map((h) => ({ value: String(h), label: t('supportAccess.hours', { count: h }) }))}
          value={String(hours)}
          onChange={(e) => setHours(Number(e.target.value))}
        />
      </div>
      <TextField label={t('adminSupport.reason')} hint={t('adminSupport.reasonHint')} required maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
      {canGrant ? (
        <label className="checkbox-row">
          <input type="checkbox" checked={emergency} onChange={(e) => setEmergency(e.target.checked)} />
          {t('adminSupport.emergency')}
        </label>
      ) : null}
      {emergency ? <Alert tone="warning">{t('adminSupport.emergencyHint')}</Alert> : null}
    </Dialog>
  );
}
