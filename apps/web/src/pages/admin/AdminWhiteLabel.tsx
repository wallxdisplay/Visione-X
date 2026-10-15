import { collection, limit, query, where } from 'firebase/firestore';
import { Alert, Button, Dialog, PageHeader, TextAreaField } from '@wallx-play/ui';
import { Hostname, hasPlatformPermission, type AccountDoc, type Brand, type BrandTarget, type OrgDoc } from '@wallx-play/shared';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../auth/AuthProvider';
import { call, errorMessage } from '../../lib/api';
import { db } from '../../lib/firebase';
import { useQueryData } from '../../lib/hooks';
import './admin.css';

interface Row {
  key: string;
  target: BrandTarget;
  owner: string;
  kind: 'reseller' | 'org';
  brand: Brand | null;
  enabled: boolean;
}

/** Super Admin → White label: every brand and its custom web addresses. */
export function AdminWhiteLabel() {
  const { t } = useTranslation();
  const { platformRole } = useAuth();
  const accounts = useQueryData<AccountDoc>('admin:whiteLabelAccounts', () => query(collection(db, 'accounts'), where('whiteLabel', '==', true), limit(500)));
  const orgs = useQueryData<OrgDoc>('admin:brandedOrgs', () => query(collection(db, 'orgs'), where('brand', '!=', null), limit(500)));
  const [editing, setEditing] = useState<Row | null>(null);

  const rows = useMemo<Row[]>(
    () =>
      [
        ...accounts.data.map((a) => ({ key: `a:${a.id}`, target: { kind: 'account' as const, accountId: a.id }, owner: a.name, kind: 'reseller' as const, brand: a.brand ?? null, enabled: !!a.whiteLabel })),
        ...orgs.data.map((o) => ({ key: `o:${o.id}`, target: { kind: 'org' as const, orgId: o.id }, owner: o.name, kind: 'org' as const, brand: o.brand ?? null, enabled: true })),
      ].sort((a, b) => a.owner.localeCompare(b.owner)),
    [accounts.data, orgs.data],
  );
  const canEdit = (r: Row) => hasPlatformPermission(platformRole, r.kind === 'org' ? 'org.limits.edit' : 'account.manage');

  return (
    <>
      <PageHeader title={t('nav.admin.whiteLabel')} description={t('adminWhiteLabel.description')} />
      <div className="wxp-table-wrap">
        <table className="wxp-table">
          <thead>
            <tr>
              <th>{t('adminWhiteLabel.brand')}</th>
              <th>{t('adminWhiteLabel.owner')}</th>
              <th>{t('adminWhiteLabel.domains')}</th>
              <th aria-label={t('common.actions')} />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <td>
                  <span className="brand-cell">
                    {r.brand?.logo ? <img src={r.brand.logo} alt="" /> : <span className="brand-cell__swatch" style={{ background: r.brand?.primaryColor ?? 'transparent' }} />}
                    <strong>{r.brand?.name ?? t('adminWhiteLabel.notSetUp')}</strong>
                  </span>
                </td>
                <td>
                  {r.owner}
                  <div className="wxp-muted">{t(`adminWhiteLabel.kinds.${r.kind}`)}</div>
                </td>
                <td>{r.brand?.domains.length ? r.brand.domains.map((d) => <div key={d}><code>{d}</code></div>) : '—'}</td>
                <td className="wxp-actions">
                  {canEdit(r) && r.brand ? (
                    <Button size="sm" variant="tertiary" onClick={() => setEditing(r)}>
                      {t('adminWhiteLabel.editDomains')}
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && !accounts.loading && !orgs.loading ? <p className="wxp-muted">{t('adminWhiteLabel.none')}</p> : null}
      <section className="wxp-card help__section" style={{ marginTop: 24 }}>
        <h2 className="section-title">{t('adminWhiteLabel.stepsTitle')}</h2>
        <ol className="steps">
          <li>{t('adminWhiteLabel.step1')}</li>
          <li>{t('adminWhiteLabel.step2')}</li>
          <li>{t('adminWhiteLabel.step3')}</li>
          <li>{t('adminWhiteLabel.step4')}</li>
        </ol>
        <p className="wxp-muted">{t('adminWhiteLabel.limits')}</p>
      </section>
      {editing ? <DomainsDialog row={editing} onClose={() => setEditing(null)} /> : null}
    </>
  );
}

function DomainsDialog({ row, onClose }: { row: Row; onClose: () => void }) {
  const { t } = useTranslation();
  const [text, setText] = useState((row.brand?.domains ?? []).join('\n'));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const domains = text
    .split(/[\s,]+/)
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  const bad = domains.filter((d) => !Hostname.safeParse(d).success);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await call('setBrandDomains', { target: row.target, domains });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      title={t('adminWhiteLabel.domainsFor', { name: row.brand?.name ?? row.owner })}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={busy || bad.length > 0 || domains.length > 5} onClick={() => void save()}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <TextAreaField
        label={t('adminWhiteLabel.domains')}
        hint={t('adminWhiteLabel.domainsHint')}
        rows={4}
        value={text}
        error={bad.length ? t('adminWhiteLabel.badDomain', { domain: bad[0] }) : domains.length > 5 ? t('adminWhiteLabel.tooMany') : undefined}
        onChange={(e) => setText(e.target.value)}
      />
      <Alert tone="info">{t('adminWhiteLabel.firebaseReminder')}</Alert>
    </Dialog>
  );
}
