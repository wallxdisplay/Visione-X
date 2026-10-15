import { collection, limit, query } from 'firebase/firestore';
import {
  Alert,
  Button,
  Dialog,
  PageHeader,
  SelectField,
  StatusChip,
  TextAreaField,
  TextField,
} from '@wallx-play/ui';
import {
  ACCOUNT_STATUSES,
  formatInr,
  hasPlatformPermission,
  type AccountDoc,
  type AccountStatus,
  type OrgDoc,
} from '@wallx-play/shared';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../auth/AuthProvider';
import { parseRupees, rupees, usePlans } from '../../content/billing';
import { AccountDetailsDialog } from './AdminResellerDetails';
import { call, errorMessage } from '../../lib/api';
import { db } from '../../lib/firebase';
import { useQueryData, type WithId } from '../../lib/hooks';
import './admin.css';

type Draft = Pick<
  AccountDoc,
  'name' | 'contactName' | 'email' | 'phone' | 'city' | 'status' | 'notes'
> & {
  accountId?: string;
  gstin: string;
  portal: boolean;
  /** Dealer discount in percent, and fixed dealer prices in rupees per plan (text inputs). */
  discountPct: string;
  prices: Record<string, string>;
};
const EMPTY: Draft = {
  name: '',
  contactName: '',
  email: '',
  phone: '',
  city: '',
  gstin: '',
  status: 'active',
  notes: '',
  portal: true,
  discountPct: '0',
  prices: {},
};

const draftOf = (a: WithId<AccountDoc>): Draft => ({
  accountId: a.id,
  name: a.name,
  contactName: a.contactName,
  email: a.email,
  phone: a.phone,
  city: a.city,
  status: a.status,
  notes: a.notes,
  gstin: a.gstin ?? '',
  portal: a.portal === true,
  discountPct: String((a.dealerDiscountBps ?? 0) / 100),
  prices: Object.fromEntries(
    Object.entries(a.dealerPricesMinor ?? {}).map(([k, v]) => [k, rupees(v)]),
  ),
});

/** Super Admin → Resellers: partner accounts and the organizations they brought (groundwork). */
export function AdminResellers() {
  const { t } = useTranslation();
  const { platformRole } = useAuth();
  const canManage = hasPlatformPermission(platformRole, 'account.manage');
  const accounts = useQueryData<AccountDoc>('admin:accounts', () =>
    query(collection(db, 'accounts'), limit(500)),
  );
  const orgs = useQueryData<OrgDoc>('admin:orgs', () => query(collection(db, 'orgs'), limit(1000)));
  const [editing, setEditing] = useState<Draft | null>(null);
  const [managing, setManaging] = useState<WithId<AccountDoc> | null>(null);
  const [details, setDetails] = useState<WithId<AccountDoc> | null>(null);
  const count = (id: string) => orgs.data.filter((o) => o.parentAccountId === id).length;
  const sorted = useMemo(
    () => [...accounts.data].sort((a, b) => a.name.localeCompare(b.name)),
    [accounts.data],
  );

  return (
    <>
      <PageHeader
        title={t('nav.admin.resellers')}
        description={t('adminResellers.description')}
        actions={
          canManage ? (
            <Button variant="primary" onClick={() => setEditing({ ...EMPTY })}>
              {t('adminResellers.new')}
            </Button>
          ) : null
        }
      />
      <div className="wxp-table-wrap">
        <table className="wxp-table">
          <thead>
            <tr>
              <th>{t('adminResellers.name')}</th>
              <th>{t('adminResellers.contact')}</th>
              <th>{t('adminResellers.city')}</th>
              <th>{t('adminResellers.status')}</th>
              <th>{t('adminResellers.paidThrough')}</th>
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
                  <StatusChip tone={a.status === 'active' ? 'success' : 'neutral'}>
                    {t(`adminResellers.statuses.${a.status}`)}
                  </StatusChip>
                  <div className="wxp-muted">
                    {a.portal ? t('adminResellers.portalOn') : t('adminResellers.portalOff')}
                  </div>
                </td>
                <td>{a.paidThrough ? new Date(a.paidThrough).toLocaleDateString() : '—'}</td>
                <td className="wxp-tabular">{count(a.id)}</td>
                <td className="wxp-actions">
                  {canManage ? (
                    <>
                      <Button size="sm" variant="tertiary" onClick={() => setDetails(a)}>
                        {t('adminResellers.details')}
                      </Button>
                      <Button size="sm" variant="tertiary" onClick={() => setManaging(a)}>
                        {t('adminResellers.manageOrgs')}
                      </Button>
                      <Button size="sm" variant="tertiary" onClick={() => setEditing(draftOf(a))}>
                        {t('common.edit')}
                      </Button>
                    </>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {sorted.length === 0 && !accounts.loading ? (
        <p className="wxp-muted">{t('adminResellers.none')}</p>
      ) : null}
      <p className="wxp-muted" style={{ marginTop: 16 }}>
        {t('adminResellers.howItWorks')}
      </p>

      {editing ? <AccountDialog draft={editing} onClose={() => setEditing(null)} /> : null}
      {managing ? (
        <OrgsDialog account={managing} orgs={orgs.data} onClose={() => setManaging(null)} />
      ) : null}
      {details ? <AccountDetailsDialog account={details} onClose={() => setDetails(null)} /> : null}
    </>
  );
}

function AccountDialog({ draft: initial, onClose }: { draft: Draft; onClose: () => void }) {
  const { t } = useTranslation();
  const [d, setD] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const plans = usePlans();
  const set = (k: keyof Draft, v: string) => setD((p) => ({ ...p, [k]: v }));
  const sellable = plans.data
    .filter((p) => p.tier !== 'trial')
    .sort(
      (a, b) =>
        (a.pricePerScreenMonthlyMinor ?? Infinity) - (b.pricePerScreenMonthlyMinor ?? Infinity),
    );
  const pct = Number(d.discountPct);
  const pctOk = Number.isFinite(pct) && pct >= 0 && pct <= 90;
  const badPrice = Object.values(d.prices).some((v) => v.trim() !== '' && parseRupees(v) === null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const { discountPct, prices, ...rest } = d;
      const dealerPricesMinor = Object.fromEntries(
        Object.entries(prices)
          .filter(([, v]) => v.trim() !== '')
          .map(([k, v]) => [k, parseRupees(v)!]),
      );
      await call('saveAccount', {
        ...rest,
        gstin: d.gstin.trim() ? d.gstin.trim().toUpperCase() : null,
        dealerDiscountBps: Math.round(Number(discountPct) * 100),
        dealerPricesMinor,
      });
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
          <Button
            variant="primary"
            disabled={busy || d.name.trim().length < 2 || !pctOk || badPrice}
            onClick={() => void save()}
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <TextField
        label={t('adminResellers.name')}
        required
        maxLength={120}
        value={d.name}
        onChange={(e) => set('name', e.target.value)}
      />
      <div className="wxp-form__row">
        <TextField
          label={t('adminResellers.contactName')}
          maxLength={120}
          value={d.contactName}
          onChange={(e) => set('contactName', e.target.value)}
        />
        <TextField
          label={t('adminResellers.city')}
          maxLength={80}
          value={d.city}
          onChange={(e) => set('city', e.target.value)}
        />
      </div>
      <div className="wxp-form__row">
        <TextField
          label={t('adminResellers.email')}
          type="email"
          maxLength={200}
          value={d.email}
          onChange={(e) => set('email', e.target.value)}
        />
        <TextField
          label={t('adminResellers.phone')}
          type="tel"
          maxLength={30}
          value={d.phone}
          onChange={(e) => set('phone', e.target.value)}
        />
      </div>
      <div className="wxp-form__row">
        <TextField
          label={t('adminResellers.gstin')}
          maxLength={15}
          value={d.gstin}
          onChange={(e) => set('gstin', e.target.value)}
        />
        <SelectField
          label={t('adminResellers.status')}
          options={ACCOUNT_STATUSES.map((s) => ({
            value: s,
            label: t(`adminResellers.statuses.${s}`),
          }))}
          value={d.status}
          onChange={(e) => setD({ ...d, status: e.target.value as AccountStatus })}
        />
      </div>
      <TextAreaField
        label={t('adminResellers.notes')}
        maxLength={1000}
        rows={3}
        value={d.notes}
        onChange={(e) => set('notes', e.target.value)}
      />
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={d.portal}
          onChange={(e) => setD((p) => ({ ...p, portal: e.target.checked }))}
        />
        {t('adminResellers.portalLabel')}
      </label>
      <fieldset className="dealer-prices">
        <legend className="wxp-field__label">{t('adminResellers.dealerPricing')}</legend>
        <TextField
          label={t('adminResellers.discount')}
          hint={t('adminResellers.discountHint')}
          type="number"
          min={0}
          max={90}
          step="0.5"
          value={d.discountPct}
          error={pctOk ? undefined : t('adminResellers.discountError')}
          onChange={(e) => set('discountPct', e.target.value)}
        />
        {sellable.map((p) => {
          const list = p.pricePerScreenMonthlyMinor;
          const auto = list === null || !pctOk ? null : Math.round(list * (1 - pct / 100));
          return (
            <TextField
              key={p.id}
              label={t('adminResellers.fixedPrice', { plan: p.name })}
              hint={
                list === null
                  ? t('adminResellers.noListPrice')
                  : t('adminResellers.fixedPriceHint', {
                      list: formatInr(list),
                      auto: auto === null ? '—' : formatInr(auto),
                    })
              }
              inputMode="decimal"
              placeholder={auto === null ? '' : rupees(auto)}
              value={d.prices[p.id] ?? ''}
              error={
                d.prices[p.id] && parseRupees(d.prices[p.id]!) === null
                  ? t('adminResellers.priceError')
                  : undefined
              }
              onChange={(e) =>
                setD((prev) => ({ ...prev, prices: { ...prev.prices, [p.id]: e.target.value } }))
              }
            />
          );
        })}
      </fieldset>
    </Dialog>
  );
}

function OrgsDialog({
  account,
  orgs,
  onClose,
}: {
  account: WithId<AccountDoc>;
  orgs: Array<WithId<OrgDoc>>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [adding, setAdding] = useState('');
  const [wholesale, setWholesale] = useState(true);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const assigned = orgs
    .filter((o) => o.parentAccountId === account.id)
    .sort((a, b) => a.name.localeCompare(b.name));
  const direct = orgs
    .filter((o) => !o.parentAccountId && o.status !== 'rejected')
    .sort((a, b) => a.name.localeCompare(b.name));

  async function assign(orgId: string, accountId: string | null, resellerBilled = false) {
    setBusy(true);
    setError(null);
    try {
      await call('setOrgAccount', { orgId, accountId, resellerBilled, reason });
      setAdding('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const reasonOk = reason.trim().length >= 3;
  return (
    <Dialog
      open
      size="lg"
      title={t('adminResellers.orgsOf', { name: account.name })}
      onClose={onClose}
      footer={<Button onClick={onClose}>{t('common.close')}</Button>}
    >
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <TextField
        label={t('adminResellers.reason')}
        hint={t('adminResellers.reasonHint')}
        maxLength={300}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      {assigned.length ? (
        <ul className="support-grants">
          {assigned.map((o) => (
            <li key={o.id} className="support-grant">
              <span>
                <strong>{o.name}</strong>{' '}
                <span className="wxp-muted">
                  · {t(`status.${o.status}`)} ·{' '}
                  {o.billing?.resellerBilled
                    ? t('adminResellers.wholesale')
                    : t('partner.customers.billedByWallx')}
                </span>
              </span>
              <span>
                <Button
                  size="sm"
                  variant="tertiary"
                  disabled={busy || !reasonOk}
                  onClick={() => void assign(o.id, account.id, !o.billing?.resellerBilled)}
                >
                  {o.billing?.resellerBilled
                    ? t('adminResellers.billDirect')
                    : t('adminResellers.billWholesale')}
                </Button>
                <Button
                  size="sm"
                  variant="tertiary"
                  disabled={busy || !reasonOk}
                  onClick={() => void assign(o.id, null)}
                >
                  {t('adminResellers.makeDirect')}
                </Button>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="wxp-muted">{t('adminResellers.noOrgs')}</p>
      )}
      {account.status === 'active' ? (
        <>
          <div className="wxp-form__row" style={{ alignItems: 'end' }}>
            <SelectField
              label={t('adminResellers.addOrg')}
              options={[
                { value: '', label: t('adminResellers.chooseOrg') },
                ...direct.map((o) => ({ value: o.id, label: o.name })),
              ]}
              value={adding}
              onChange={(e) => setAdding(e.target.value)}
            />
            <Button
              variant="primary"
              disabled={busy || !adding || !reasonOk}
              onClick={() => void assign(adding, account.id, wholesale)}
            >
              {t('adminResellers.assign')}
            </Button>
          </div>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={wholesale}
              onChange={(e) => setWholesale(e.target.checked)}
            />
            {t('adminResellers.wholesaleLabel')}
          </label>
        </>
      ) : (
        <Alert tone="info">{t('adminResellers.inactiveHint')}</Alert>
      )}
    </Dialog>
  );
}
