import { collection, query, where } from 'firebase/firestore';
import { Alert, Button, Dialog, PageHeader, SelectField, TextField } from '@wallx-play/ui';
import { ACCOUNT_ROLES, paths, type AccountInviteDoc, type AccountMemberDoc, type AccountRole } from '@wallx-play/shared';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../auth/AuthProvider';
import { call, errorMessage } from '../../lib/api';
import { db } from '../../lib/firebase';
import { formatDate } from '../../lib/format';
import { useQueryData } from '../../lib/hooks';
import { usePartner } from '../../partner/PartnerProvider';
import './partner.css';

/** The reseller's team (owner: invite and remove). Everyone on it manages every customer. */
export function AccountTeam({ accountId, manage }: { accountId: string; manage: boolean }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const team = useQueryData<AccountMemberDoc>(`accountMembers:${accountId}`, () => query(collection(db, paths.accountMembers(accountId))));
  const invites = useQueryData<AccountInviteDoc>(manage ? `accountInvites:${accountId}` : null, () =>
    query(collection(db, paths.accountInvites(accountId)), where('status', '==', 'pending')),
  );
  const [inviting, setInviting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);

  async function run(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {link ? <Alert tone="info">{t('partner.team.inviteLink', { link })}</Alert> : null}
      <div className="section-head">
        <h2 className="section-title">{t('partner.team.members')}</h2>
        {manage ? (
          <Button size="sm" onClick={() => setInviting(true)}>
            <Plus size={14} aria-hidden /> {t('partner.team.invite')}
          </Button>
        ) : null}
      </div>
      <div className="wxp-table-wrap">
        <table className="wxp-table">
          <thead>
            <tr>
              <th>{t('partner.team.email')}</th>
              <th>{t('partner.team.role')}</th>
              <th>{t('partner.team.joined')}</th>
              <th aria-label={t('common.actions')} />
            </tr>
          </thead>
          <tbody>
            {[...team.data]
              .sort((a, b) => a.email.localeCompare(b.email))
              .map((m) => (
                <tr key={m.uid}>
                  <td>{m.email}</td>
                  <td>{t(`partner.team.roles.${m.role}`)}</td>
                  <td>{formatDate(m.joinedAt)}</td>
                  <td className="wxp-actions">
                    {manage || m.uid === user?.uid ? (
                      <Button size="sm" variant="tertiary" onClick={() => void run(() => call('removeAccountMember', { accountId, uid: m.uid }))}>
                        {m.uid === user?.uid ? t('partner.team.leave') : t('partner.team.remove')}
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      {manage && invites.data.length ? (
        <>
          <h3 className="section-title">{t('partner.team.pending')}</h3>
          <ul className="support-grants">
            {invites.data.map((i) => (
              <li key={i.id} className="support-grant">
                <span>
                  {i.email} <span className="wxp-muted">· {t(`partner.team.roles.${i.role}`)} · {t('partner.team.expires', { date: formatDate(i.expiresAt) })}</span>
                </span>
                <Button size="sm" variant="tertiary" onClick={() => void run(() => call('revokeAccountInvite', { accountId, inviteId: i.id }))}>
                  {t('partner.team.revoke')}
                </Button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {inviting ? (
        <InviteDialog
          accountId={accountId}
          onClose={() => setInviting(false)}
          onSent={(l) => {
            setInviting(false);
            setLink(l);
          }}
        />
      ) : null}
    </>
  );
}

function InviteDialog({ accountId, onClose, onSent }: { accountId: string; onClose: () => void; onSent: (link: string | null) => void }) {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<AccountRole>('staff');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function send() {
    setBusy(true);
    setError(null);
    try {
      const r = await call<{ token: string; emailed: boolean }>('inviteAccountMember', { accountId, email, role });
      onSent(r.emailed ? null : `${window.location.origin}/invite/${r.token}`);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      title={t('partner.team.invite')}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={busy || !email.includes('@')} onClick={() => void send()}>
            {t('partner.team.send')}
          </Button>
        </>
      }
    >
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <TextField label={t('partner.team.email')} type="email" required maxLength={200} value={email} onChange={(e) => setEmail(e.target.value.trim())} />
      <SelectField
        label={t('partner.team.role')}
        hint={t('partner.team.roleHint')}
        options={ACCOUNT_ROLES.map((r) => ({ value: r, label: t(`partner.team.roles.${r}`) }))}
        value={role}
        onChange={(e) => setRole(e.target.value as AccountRole)}
      />
    </Dialog>
  );
}

/** Partner portal → Team. */
export function PartnerTeam() {
  const { t } = useTranslation();
  const { accountId, role } = usePartner();
  return (
    <>
      <PageHeader title={t('partner.team.title')} description={t('partner.team.description')} />
      <AccountTeam accountId={accountId} manage={role === 'owner'} />
    </>
  );
}
