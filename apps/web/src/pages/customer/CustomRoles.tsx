import { collection, orderBy, query } from 'firebase/firestore';
import { Alert, Button, Dialog, SelectField, TextField } from '@wallx-play/ui';
import {
  CUSTOM_ROLE_PERMISSIONS,
  MAX_CUSTOM_ROLES,
  paths,
  SYSTEM_ORG_ROLE_PERMISSIONS,
  type MemberDoc,
  type OrgPermission,
  type RoleDoc,
  type SystemOrgRole,
} from '@wallx-play/shared';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { call, errorMessage } from '../../lib/api';
import { db } from '../../lib/firebase';
import { roleLabel } from '../../lib/format';
import { useQueryData, type WithId } from '../../lib/hooks';

/** Custom roles of an org, by name. */
export function useRoles(orgId: string) {
  return useQueryData<RoleDoc>(`roles:${orgId}`, () => query(collection(db, paths.roles(orgId)), orderBy('name')));
}

/** Select value for a role choice: a system role, or "custom:<roleId>". */
export const roleValue = (role: string, customRoleId?: string) => (role === 'custom' ? `custom:${customRoleId ?? ''}` : role);
export function parseRoleValue(v: string): { role: SystemOrgRole | 'custom'; customRoleId?: string } {
  return v.startsWith('custom:') ? { role: 'custom', customRoleId: v.slice(7) } : { role: v as SystemOrgRole };
}

/** Name to show for a member's or invite's role. */
export function roleName(roles: RoleDoc[], role: string, customRoleId?: string): string {
  if (role !== 'custom') return roleLabel(role);
  return roles.find((r) => r.id === customRoleId)?.name ?? roleLabel('custom');
}

/** Permissions grouped the way people think about them. Billing management is owner-only. */
const GROUPS: Array<{ key: string; permissions: OrgPermission[] }> = [
  { key: 'screens', permissions: ['screen.view', 'screen.manage', 'screen.command', 'device.authorize', 'emergency.trigger'] },
  { key: 'content', permissions: ['media.view', 'media.upload', 'media.delete', 'layout.edit', 'playlist.edit', 'schedule.edit', 'content.publish', 'content.approve'] },
  { key: 'sensors', permissions: ['sensor.view', 'sensor.manage', 'integration.manage', 'apikey.manage'] },
  { key: 'organization', permissions: ['org.settings.edit', 'site.manage', 'member.view', 'member.manage', 'report.view', 'billing.view', 'audit.view'] },
];

/** Built-in roles to start a new custom role from. */
const STARTERS: SystemOrgRole[] = ['viewer', 'editor', 'approver', 'admin'];

export function CustomRoles({ orgId, roles, members, manage }: { orgId: string; roles: Array<WithId<RoleDoc>>; members: MemberDoc[]; manage: boolean }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<{ roleId?: string; name: string; description: string; permissions: OrgPermission[] } | null>(null);
  const [deleting, setDeleting] = useState<RoleDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const holders = (id: string) => members.filter((m) => m.customRoleId === id).length;

  async function run(action: () => Promise<unknown>, done: () => void) {
    setBusy(true);
    setError(null);
    try {
      await action();
      done();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const toggle = (p: OrgPermission, on: boolean) =>
    editing && setEditing({ ...editing, permissions: on ? [...editing.permissions, p] : editing.permissions.filter((x) => x !== p) });

  return (
    <>
      <div className="team__section-head">
        <h2 className="section-title">{t('customRoles.title')}</h2>
        {manage ? (
          <Button size="sm" disabled={roles.length >= MAX_CUSTOM_ROLES} onClick={() => { setError(null); setEditing({ name: '', description: '', permissions: [...SYSTEM_ORG_ROLE_PERMISSIONS.viewer] }); }}>
            <Plus size={14} aria-hidden /> {t('customRoles.new')}
          </Button>
        ) : null}
      </div>
      {roles.length === 0 ? (
        <p className="wxp-muted">{t('customRoles.empty')}</p>
      ) : (
        <div className="wxp-table-wrap">
          <table className="wxp-table">
            <thead>
              <tr>
                <th>{t('customRoles.name')}</th>
                <th>{t('customRoles.permissions')}</th>
                <th>{t('customRoles.members')}</th>
                <th aria-label={t('common.actions')} />
              </tr>
            </thead>
            <tbody>
              {roles.map((r) => (
                <tr key={r.id}>
                  <td>
                    <strong>{r.name}</strong>
                    {r.description ? <div className="wxp-muted">{r.description}</div> : null}
                  </td>
                  <td className="wxp-tabular">{t('customRoles.permissionCount', { count: r.permissions.length })}</td>
                  <td className="wxp-tabular">{holders(r.id)}</td>
                  <td className="wxp-actions">
                    {manage ? (
                      <>
                        <Button size="sm" variant="tertiary" onClick={() => { setError(null); setEditing({ roleId: r.id, name: r.name, description: r.description, permissions: [...r.permissions] }); }}>
                          {t('common.edit')}
                        </Button>
                        <Button size="sm" variant="tertiary" onClick={() => { setError(null); setDeleting(r); }}>
                          {t('common.delete')}
                        </Button>
                      </>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Dialog
        open={!!editing}
        size="lg"
        title={editing?.roleId ? t('customRoles.editTitle') : t('customRoles.new')}
        onClose={() => setEditing(null)}
        footer={
          <>
            <Button onClick={() => setEditing(null)}>{t('common.cancel')}</Button>
            <Button
              variant="primary"
              disabled={busy || !editing || editing.name.trim().length < 2 || editing.permissions.length === 0}
              onClick={() => editing && void run(() => call('saveRole', { orgId, ...editing }), () => setEditing(null))}
            >
              {t('common.save')}
            </Button>
          </>
        }
      >
        {error ? <Alert tone="danger">{error}</Alert> : null}
        {editing ? (
          <>
            <TextField label={t('customRoles.name')} required maxLength={40} value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            <TextField label={t('customRoles.description')} maxLength={200} value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
            {!editing.roleId ? (
              <SelectField
                label={t('customRoles.startFrom')}
                hint={t('customRoles.startFromHint')}
                options={[{ value: '', label: '—' }, ...STARTERS.map((r) => ({ value: r, label: roleLabel(r) }))]}
                value=""
                onChange={(e) =>
                  e.target.value &&
                  setEditing({ ...editing, permissions: SYSTEM_ORG_ROLE_PERMISSIONS[e.target.value as SystemOrgRole].filter((p) => CUSTOM_ROLE_PERMISSIONS.includes(p)) })
                }
              />
            ) : null}
            <div className="role-perms">
              {GROUPS.map((g) => (
                <fieldset key={g.key} className="role-perms__group">
                  <legend className="wxp-field__label">{t(`customRoles.groups.${g.key}`)}</legend>
                  {g.permissions.map((p) => (
                    <label key={p} className="checkbox-row">
                      <input type="checkbox" checked={editing.permissions.includes(p)} onChange={(e) => toggle(p, e.target.checked)} />
                      <span>
                        {t(`permissions.${p}`)}
                        {p === 'member.manage' ? <span className="wxp-muted"> — {t('customRoles.memberManageNote')}</span> : null}
                      </span>
                    </label>
                  ))}
                </fieldset>
              ))}
            </div>
            <p className="wxp-field__hint">{t('customRoles.billingNote')}</p>
            {editing.roleId && holders(editing.roleId) > 0 ? <Alert tone="info">{t('customRoles.appliesNow', { count: holders(editing.roleId) })}</Alert> : null}
          </>
        ) : null}
      </Dialog>

      <Dialog
        open={!!deleting}
        title={t('customRoles.deleteTitle')}
        onClose={() => setDeleting(null)}
        footer={
          <>
            <Button onClick={() => setDeleting(null)}>{t('common.cancel')}</Button>
            <Button variant="danger" disabled={busy} onClick={() => deleting && void run(() => call('deleteRole', { orgId, roleId: deleting.id }), () => setDeleting(null))}>
              {t('common.delete')}
            </Button>
          </>
        }
      >
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <p>{t('customRoles.deleteBody', { name: deleting?.name })}</p>
      </Dialog>
    </>
  );
}
