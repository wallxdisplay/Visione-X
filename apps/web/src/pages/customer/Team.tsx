import { collection, orderBy, query, where } from 'firebase/firestore';
import { Alert, Button, Dialog, PageHeader, SelectField, TextField } from '@wallx-play/ui';
import { MAX_SITE_SCOPE, paths, SYSTEM_ORG_ROLES, type InviteDoc, type MemberDoc, type SystemOrgRole } from '@wallx-play/shared';
import { UserPlus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../auth/AuthProvider';
import { call, errorMessage } from '../../lib/api';
import { db } from '../../lib/firebase';
import { formatDate, roleLabel } from '../../lib/format';
import { useQueryData } from '../../lib/hooks';
import { useOrg } from '../../org/OrgProvider';
import { useSites } from '../../content/data';

/** "All sites" or a chosen subset (empty array = all sites). */
function SitePicker({ sites, value, onChange }: { sites: Array<{ id: string; name: string }>; value: string[]; onChange: (v: string[]) => void }) {
  const { t } = useTranslation();
  const limited = value.length > 0;
  return (
    <fieldset className="site-picker">
      <legend className="wxp-field__label">{t('team.sites')}</legend>
      <label className="checkbox-row">
        <input type="radio" checked={!limited} onChange={() => onChange([])} /> {t('team.allSites')}
      </label>
      <label className="checkbox-row">
        <input type="radio" checked={limited} disabled={sites.length === 0} onChange={() => sites[0] && onChange([sites[0].id])} /> {t('team.someSites')}
      </label>
      {limited ? (
        <div className="site-picker__list">
          {sites.map((s) => (
            <label key={s.id} className="checkbox-row">
              <input
                type="checkbox"
                checked={value.includes(s.id)}
                disabled={!value.includes(s.id) && value.length >= MAX_SITE_SCOPE}
                onChange={(e) => {
                  const next = e.target.checked ? [...value, s.id] : value.filter((id) => id !== s.id);
                  if (next.length) onChange(next);
                }}
              />
              {s.name}
            </label>
          ))}
        </div>
      ) : null}
      <p className="wxp-field__hint">{limited ? t('team.someSitesHint') : t('team.allSitesHint')}</p>
    </fieldset>
  );
}

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
  const [siteScope, setSiteScope] = useState<string[]>([]);
  const [scoping, setScoping] = useState<{ member: MemberDoc; sites: string[] } | null>(null);
  const sites = useSites(orgId);
  const siteNames = (ids: string[] | undefined) =>
    ids?.length ? ids.map((id) => sites.data.find((s) => s.id === id)?.name ?? id).join(', ') : t('team.allSites');

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
      const res = await call<{ token: string }>('inviteMember', { orgId, email, role, siteScope: role === 'owner' ? [] : siteScope });
      setLink(`${window.location.origin}/invite/${res.token}`);
    });
  }

  function closeInvite() {
    setInviteOpen(false);
    setEmail('');
    setSiteScope([]);
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

      <div className="wxp-table-wrap">
        <table className="wxp-table">
          <thead>
            <tr>
              <th>{t('team.email')}</th>
              <th>{t('team.role')}</th>
              <th>{t('team.sites')}</th>
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
                    {m.email} {isMe ? <span className="wxp-muted">({t('team.you')})</span> : null}
                  </td>
                  <td>
                    {canEditRole ? (
                      <select
                        className="wxp-input"
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
                  <td>
                    {siteNames(m.siteScope)}
                    {manage && !isMe && m.role !== 'owner' ? (
                      <Button size="sm" variant="tertiary" onClick={() => setScoping({ member: m, sites: m.siteScope ?? [] })}>
                        {t('common.edit')}
                      </Button>
                    ) : null}
                  </td>
                  <td className="wxp-tabular">{formatDate(m.joinedAt)}</td>
                  <td className="wxp-actions">
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
          <div className="wxp-table-wrap">
            <table className="wxp-table">
              <thead>
                <tr>
                  <th>{t('team.email')}</th>
                  <th>{t('team.role')}</th>
                  <th>{t('team.sites')}</th>
                  <th>{t('team.expires')}</th>
                  <th aria-label={t('common.actions')} />
                </tr>
              </thead>
              <tbody>
                {liveInvites.map((i) => (
                  <tr key={i.id}>
                    <td>{i.email}</td>
                    <td>{roleLabel(i.role)}</td>
                    <td>{siteNames(i.siteScope)}</td>
                    <td className="wxp-tabular">{formatDate(i.expiresAt)}</td>
                    <td className="wxp-actions">
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
            {role !== 'owner' ? <SitePicker sites={sites.data} value={siteScope} onChange={setSiteScope} /> : null}
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

      <Dialog
        open={!!scoping}
        title={t('team.sitesFor', { email: scoping?.member.email })}
        onClose={() => setScoping(null)}
        footer={
          <>
            <Button onClick={() => setScoping(null)}>{t('common.cancel')}</Button>
            <Button
              variant="primary"
              disabled={busy}
              onClick={() =>
                scoping &&
                void run(() => call('setMemberSites', { orgId, uid: scoping.member.uid, siteScope: scoping.sites })).then((ok) => ok && setScoping(null))
              }
            >
              {t('common.save')}
            </Button>
          </>
        }
      >
        {error ? <Alert tone="danger">{error}</Alert> : null}
        {scoping ? <SitePicker sites={sites.data} value={scoping.sites} onChange={(v) => setScoping({ ...scoping, sites: v })} /> : null}
      </Dialog>

      {manage ? (
        <p className="wxp-muted" style={{ marginTop: 16 }}>
          {t('team.emailNote')}
        </p>
      ) : null}
    </>
  );
}
