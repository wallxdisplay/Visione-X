import { Alert, Button, Dialog, SelectField, TextField } from '@visione-x/ui';
import type { ScreenGroupDoc } from '@visione-x/shared';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useScreenGroups, useSites } from '../../content/data';
import { call, errorMessage } from '../../lib/api';
import { useOrg } from '../../org/OrgProvider';

/** Screen groups section of the Sites & Groups page. */
export function ScreenGroups() {
  const { t } = useTranslation();
  const { orgId, can } = useOrg();
  const groups = useScreenGroups(orgId);
  const sites = useSites(orgId);
  const manage = can('screen.manage');
  const [draft, setDraft] = useState<{ groupId?: string; name: string; siteId: string; description: string } | null>(null);
  const [deleting, setDeleting] = useState<ScreenGroupDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  return (
    <section>
      <div className="section-head">
        <h2 className="section-title">{t('groups.title')}</h2>
        {manage ? (
          <Button size="sm" onClick={() => setDraft({ name: '', siteId: '', description: '' })}>
            <Plus size={14} aria-hidden /> {t('groups.add')}
          </Button>
        ) : null}
      </div>
      <p className="vx-muted">{t('groups.description')}</p>
      {groups.data.length === 0 && !groups.loading ? (
        <p className="vx-muted">{t('groups.empty')}</p>
      ) : (
        <div className="vx-table-wrap">
          <table className="vx-table">
            <thead>
              <tr>
                <th>{t('groups.name')}</th>
                <th>{t('groups.site')}</th>
                <th>{t('groups.notes')}</th>
                <th aria-label={t('common.actions')} />
              </tr>
            </thead>
            <tbody>
              {groups.data.map((g) => (
                <tr key={g.id}>
                  <td>{g.name}</td>
                  <td>{sites.data.find((s) => s.id === g.siteId)?.name ?? t('groups.anySite')}</td>
                  <td className="vx-muted">{g.description ?? '—'}</td>
                  <td className="vx-actions">
                    {manage ? (
                      <>
                        <Button
                          size="sm"
                          variant="tertiary"
                          onClick={() => setDraft({ groupId: g.id, name: g.name, siteId: g.siteId ?? '', description: g.description ?? '' })}
                        >
                          {t('common.edit')}
                        </Button>
                        <Button size="sm" variant="tertiary" onClick={() => setDeleting(g)}>
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
        open={!!draft}
        title={draft?.groupId ? t('groups.edit') : t('groups.add')}
        onClose={() => {
          setDraft(null);
          setError(null);
        }}
        footer={
          <>
            <Button onClick={() => setDraft(null)}>{t('common.cancel')}</Button>
            <Button
              variant="primary"
              disabled={busy || !draft?.name.trim()}
              onClick={() =>
                draft &&
                void run(
                  () =>
                    call('upsertScreenGroup', {
                      orgId,
                      ...(draft.groupId ? { groupId: draft.groupId } : {}),
                      name: draft.name,
                      siteId: draft.siteId || null,
                      ...(draft.description.trim() ? { description: draft.description } : {}),
                    }),
                  () => setDraft(null),
                )
              }
            >
              {t('common.save')}
            </Button>
          </>
        }
      >
        {error ? <Alert tone="danger">{error}</Alert> : null}
        {draft ? (
          <>
            <TextField label={t('groups.name')} required value={draft.name} maxLength={80} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            <SelectField
              label={t('groups.site')}
              options={[{ value: '', label: t('groups.anySite') }, ...sites.data.map((s) => ({ value: s.id, label: s.name }))]}
              value={draft.siteId}
              onChange={(e) => setDraft({ ...draft, siteId: e.target.value })}
            />
            <TextField label={t('groups.notes')} value={draft.description} maxLength={300} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
          </>
        ) : null}
      </Dialog>

      <Dialog
        open={!!deleting}
        title={t('groups.deleteTitle')}
        onClose={() => setDeleting(null)}
        footer={
          <>
            <Button onClick={() => setDeleting(null)}>{t('common.cancel')}</Button>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() => deleting && void run(() => call('deleteScreenGroup', { orgId, groupId: deleting.id }), () => setDeleting(null))}
            >
              {t('common.delete')}
            </Button>
          </>
        }
      >
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <p>{t('groups.deleteBody', { name: deleting?.name })}</p>
      </Dialog>
    </section>
  );
}
