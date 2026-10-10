import { collection, orderBy, query } from 'firebase/firestore';
import { Alert, Button, Dialog, EmptyState, PageHeader, SelectField, TextField } from '@visione-x/ui';
import { paths, UpsertSiteInput, type SiteDoc } from '@visione-x/shared';
import { MapPin, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { call, errorMessage } from '../../lib/api';
import { db } from '../../lib/firebase';
import { fieldErrors, timezoneOptions } from '../../lib/format';
import { useQueryData } from '../../lib/hooks';
import { useOrg } from '../../org/OrgProvider';

interface Draft {
  siteId?: string;
  name: string;
  address: string;
  timezone: string;
}

export function Sites() {
  const { t } = useTranslation();
  const { orgId, org, can } = useOrg();
  const manage = can('site.manage');
  const sites = useQueryData<SiteDoc>(`sites:${orgId}`, () =>
    query(collection(db, paths.sites(orgId)), orderBy('name')),
  );
  const timezones = useMemo(timezoneOptions, []);

  const [draft, setDraft] = useState<Draft | null>(null);
  const [deleting, setDeleting] = useState<SiteDoc | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const newDraft = (): Draft => ({ name: '', address: '', timezone: org?.timezone ?? 'Asia/Kolkata' });

  async function save() {
    if (!draft) return;
    const input = { orgId, ...draft, address: draft.address || undefined };
    const parsed = UpsertSiteInput.safeParse(input);
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error.issues));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await call('upsertSite', parsed.data);
      setDraft(null);
      setErrors({});
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!deleting) return;
    setBusy(true);
    setError(null);
    try {
      await call('deleteSite', { orgId, siteId: deleting.id });
      setDeleting(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title={t('sites.title')}
        description={t('sites.description')}
        actions={
          manage ? (
            <Button variant="primary" onClick={() => setDraft(newDraft())}>
              <Plus size={16} aria-hidden /> {t('sites.add')}
            </Button>
          ) : null
        }
      />

      {sites.data.length === 0 && !sites.loading ? (
        <div className="vx-card">
          <EmptyState
            icon={<MapPin size={24} aria-hidden />}
            title={t('sites.emptyTitle')}
            description={t('sites.emptyBody')}
            action={
              manage ? (
                <Button variant="primary" onClick={() => setDraft(newDraft())}>
                  {t('sites.add')}
                </Button>
              ) : undefined
            }
          />
        </div>
      ) : (
        <div className="vx-table-wrap">
          <table className="vx-table">
            <thead>
              <tr>
                <th>{t('sites.name')}</th>
                <th>{t('sites.address')}</th>
                <th>{t('sites.timezone')}</th>
                <th aria-label={t('common.actions')} />
              </tr>
            </thead>
            <tbody>
              {sites.data.map((s) => (
                <tr key={s.id}>
                  <td>{s.name}</td>
                  <td className="vx-muted">{s.address ?? '—'}</td>
                  <td>{s.timezone}</td>
                  <td className="vx-actions">
                    {manage ? (
                      <>
                        <Button
                          size="sm"
                          variant="tertiary"
                          onClick={() =>
                            setDraft({ siteId: s.id, name: s.name, address: s.address ?? '', timezone: s.timezone })
                          }
                        >
                          {t('common.edit')}
                        </Button>
                        <Button size="sm" variant="tertiary" onClick={() => setDeleting(s)}>
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
      <p className="vx-muted" style={{ marginTop: 16 }}>
        {t('sites.groupsNote')}
      </p>

      <Dialog
        open={!!draft}
        title={draft?.siteId ? t('sites.edit') : t('sites.add')}
        onClose={() => {
          setDraft(null);
          setErrors({});
          setError(null);
        }}
        footer={
          <>
            <Button onClick={() => setDraft(null)}>{t('common.cancel')}</Button>
            <Button variant="primary" disabled={busy} onClick={() => void save()}>
              {t('common.save')}
            </Button>
          </>
        }
      >
        {error ? <Alert tone="danger">{error}</Alert> : null}
        {draft ? (
          <>
            <TextField
              label={t('sites.name')}
              required
              value={draft.name}
              error={errors.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
            <TextField
              label={t('sites.address')}
              value={draft.address}
              error={errors.address}
              onChange={(e) => setDraft({ ...draft, address: e.target.value })}
            />
            <SelectField
              label={t('sites.timezone')}
              required
              options={timezones}
              value={draft.timezone}
              error={errors.timezone}
              onChange={(e) => setDraft({ ...draft, timezone: e.target.value })}
            />
          </>
        ) : null}
      </Dialog>

      <Dialog
        open={!!deleting}
        title={t('sites.deleteTitle')}
        onClose={() => setDeleting(null)}
        footer={
          <>
            <Button onClick={() => setDeleting(null)}>{t('common.cancel')}</Button>
            <Button variant="danger" disabled={busy} onClick={() => void remove()}>
              {t('sites.deleteConfirm')}
            </Button>
          </>
        }
      >
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <p>{t('sites.deleteBody', { name: deleting?.name })}</p>
      </Dialog>
    </>
  );
}
