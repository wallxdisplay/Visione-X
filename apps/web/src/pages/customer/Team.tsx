import { collection, orderBy, query, where } from 'firebase/firestore';
import { Alert, Button, Dialog, PageHeader, SelectField, TextField } from '@visione-x/ui';
import { paths, SYSTEM_ORG_ROLES, type InviteDoc, type MemberDoc, type SystemOrgRole } from '@visione-x/shared';
import { UserPlus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../auth/AuthProvider';
import { call, errorMessage } from '../../lib/api';
import { db } from '../../lib/firebase';
import { formatDate, roleLabel } from '../../lib/format';
import { useQueryData } from '../../lib/hooks';
import { useOrg } from '../../org/OrgProvider';

export function Team() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { orgId, member: me, can, entitlements } = useOrg();
  const manage = can('member.manage');

  const members = useQueryData<MemberDoc>(`members:${orgId}`, () => query(collection(db, paths.members(orgId))));
  const invites = useQueryData<InviteDoc>(manage ? `invites:${orgId}` : null, () =>
    query(collection(db, paths.invites(orgId)), where('status', '==', 'pending'), orderBy('createdAt', 'desc')),
  );

  const [inviteOpen, setInviteOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<SystemOrgRole>('editor');
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<MemberDoc | null>(null);

  const roleOptions = SYSTEM_ORG_ROLES.filter((r) => r !== 'owner' || me?.role === 'owner').map((r) => ({
    value: r,
    label: roleLabel(r),
  }));

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function sendInvite() {
    await run(async () => {
      const res = await call<{ token: string }>('inviteMember', { orgId, email, role });
      setLink(`${window.location.origin}/invite/${res.token}`);
    });
  }

  function closeInvite() {
    setInviteOpen(false);
    setEmail('');
    setLink(null);
    setError(null);
  }

  const now = Date.now();
  const liveInvites = invites.data.filter((i) => i.expiresAt > now);

  return (
    <>
      <PageHeader
        title={t('nav.team')}
        description={t('team.description', {
          count: members.data.length,
          limit: entitlements?.limits.users ?? '∞',
        })}
        actions={
          manage ? (
            <Button variant="primary" onClick={() => setInviteOpen(true)}>
              <UserPlus size={16} aria-hidden /> {t('team.invite')}
            </Button>
          ) : null
        }
      />
      {error && !inviteOpen ? <Alert tone="danger">{error}</Alert> : null}

      <div className="vx-table-wrap">
        <table className="vx-table">
          <thead>
            <tr>
              <th>{t('team.email')}</th>
              <th>{t('team.role')}</th>
              <th>{t('team.joined')}</th>
              <th aria-label={t('common.actions')} />
            </tr>
          </thead>
          <tbody>
            {members.data.map((m) => {
              const isMe = m.uid === user?.uid;
              const canEditRole = manage && !isMe && (m.role !== 'owner' || me?.role === 'owner');
              return (
                <tr key={m.uid}>
                  <td>
                    {m.email} {isMe ? <span className="vx-muted">({t('team.you')})</span> : null}
                  </td>
                  <td>
                    {canEditRole ? (
                      <select
                        className="vx-input"
                        style={{ width: 160 }}
                        aria-label={t('team.roleFor', { email: m.email })}
                        value={m.role}
                        disabled={busy}
                        onChange={(e) =>
                          void run(() => call('updateMemberRole', { orgId, uid: m.uid, role: e.target.value }))
                        }
                      >
                        {roleOptions.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      roleLabel(m.role)
                    )}
                  </td>
                  <td className="vx-tabular">{formatDate(m.joinedAt)}</td>
                  <td className="vx-actions">
                    {(manage && !isMe) || isMe ? (
                      <Button size="sm" variant="tertiary" onClick={() => setRemoving(m)}>
                        {isMe ? t('team.leave') : t('team.remove')}
                      </Button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {manage && liveInvites.length > 0 ? (
        <>
          <h2 className="section-title">{t('team.pendingInvites')}</h2>
          <div className="vx-table-wrap">
            <table className="vx-table">
              <thead>
                <tr>
                  <th>{t('team.email')}</th>
                  <th>{t('team.role')}</th>
                  <th>{t('team.expires')}</th>
                  <th aria-label={t('common.actions')} />
                </tr>
              </thead>
              <tbody>
                {liveInvites.map((i) => (
                  <tr key={i.id}>
                    <td>{i.email}</td>
                    <td>{roleLabel(i.role)}</td>
                    <td className="vx-tabular">{formatDate(i.expiresAt)}</td>
                    <td className="vx-actions">
                      <Button
                        size="sm"
                        variant="tertiary"
                        disabled={busy}
                        onClick={() => void run(() => call('revokeInvite', { orgId, inviteId: i.id }))}
                      >
                        {t('team.revoke')}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      <Dialog
        open={inviteOpen}
        title={t('team.invite')}
        onClose={closeInvite}
        footer={
          link ? (
            <Button variant="primary" onClick={closeInvite}>
              {t('common.done')}
            </Button>
          ) : (
            <>
              <Button onClick={closeInvite}>{t('common.cancel')}</Button>
              <Button variant="primary" disabled={busy || !email} onClick={() => void sendInvite()}>
                {t('team.createInvite')}
              </Button>
            </>
          )
        }
      >
        {error ? <Alert tone="danger">{error}</Alert> : null}
        {link ? (
          <>
            <Alert tone="success" title={t('team.inviteCreated')}>
              {t('team.inviteLinkHint')}
            </Alert>
            <TextField label={t('team.inviteLink')} readOnly value={link} onFocus={(e) => e.target.select()} />
            <div>
              <Button size="sm" onClick={() => void navigator.clipboard?.writeText(link)}>
                {t('common.copy')}
              </Button>
            </div>
          </>
        ) : (
          <>
            <TextField
              label={t('team.email')}
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <SelectField
              label={t('team.role')}
              options={roleOptions}
              value={role}
              onChange={(e) => setRole(e.target.value as SystemOrgRole)}
              hint={t(`roles.${role}Hint`)}
            />
          </>
        )}
      </Dialog>

      <Dialog
        open={!!removing}
        title={removing?.uid === user?.uid ? t('team.leaveTitle') : t('team.removeTitle')}
        onClose={() => setRemoving(null)}
        footer={
          <>
            <Button onClick={() => setRemoving(null)}>{t('common.cancel')}</Button>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() =>
                void run(() => call('removeMember', { orgId, uid: removing!.uid })).then(
                  (ok) => ok && setRemoving(null),
                )
              }
            >
              {removing?.uid === user?.uid ? t('team.leave') : t('team.remove')}
            </Button>
          </>
        }
      >
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <p>{t('team.removeBody', { email: removing?.email })}</p>
      </Dialog>

      {manage ? (
        <p className="vx-muted" style={{ marginTop: 16 }}>
          {t('team.emailNote')}
        </p>
      ) : null}
    </>
  );
}
