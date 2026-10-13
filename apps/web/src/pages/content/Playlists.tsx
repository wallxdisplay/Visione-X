import { Alert, Button, Dialog, EmptyState, PageHeader, TextField } from '@wallx-play/ui';
import type { PlaylistDoc } from '@wallx-play/shared';
import { ListVideo, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';
import { formatDuration, usePlaylists } from '../../content/data';
import { call, errorMessage } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { useOrg } from '../../org/OrgProvider';

export function Playlists() {
  const { t } = useTranslation();
  const { orgId, can } = useOrg();
  const playlists = usePlaylists(orgId);
  const navigate = useNavigate();
  const editable = can('playlist.edit');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [deleting, setDeleting] = useState<PlaylistDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const { playlistId } = await call<{ playlistId: string }>('savePlaylist', { orgId, name, items: [] });
      navigate(`/playlists/${playlistId}`);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  async function remove() {
    if (!deleting) return;
    setBusy(true);
    setError(null);
    try {
      await call('deletePlaylist', { orgId, playlistId: deleting.id });
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
        title={t('nav.playlists')}
        description={t('playlists.description')}
        actions={
          editable ? (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus size={16} aria-hidden /> {t('playlists.new')}
            </Button>
          ) : null
        }
      />
      {error && !creating && !deleting ? <Alert tone="danger">{error}</Alert> : null}
      {playlists.data.length === 0 && !playlists.loading ? (
        <div className="wxp-card">
          <EmptyState
            icon={<ListVideo size={24} aria-hidden />}
            title={t('playlists.emptyTitle')}
            description={t('playlists.emptyBody')}
            action={editable ? <Button variant="primary" onClick={() => setCreating(true)}>{t('playlists.new')}</Button> : undefined}
          />
        </div>
      ) : (
        <div className="wxp-table-wrap">
          <table className="wxp-table">
            <thead>
              <tr>
                <th>{t('playlists.name')}</th>
                <th>{t('playlists.items')}</th>
                <th>{t('playlists.duration')}</th>
                <th>{t('playlists.updated')}</th>
                <th aria-label={t('common.actions')} />
              </tr>
            </thead>
            <tbody>
              {playlists.data.map((p) => (
                <tr key={p.id}>
                  <td>
                    <Link to={`/playlists/${p.id}`}>{p.name}</Link>
                    {p.layoutIds.length ? <div className="wxp-muted">{t('playlists.containsLayouts')}</div> : null}
                  </td>
                  <td className="wxp-tabular">{p.items.length}</td>
                  <td className="wxp-tabular">{formatDuration(p.totalDurationSec)}</td>
                  <td className="wxp-tabular">{formatDateTime(p.updatedAt)}</td>
                  <td className="wxp-actions">
                    {editable ? (
                      <Button size="sm" variant="tertiary" aria-label={t('common.delete')} onClick={() => setDeleting(p)}>
                        <Trash2 size={15} />
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Dialog
        open={creating}
        title={t('playlists.new')}
        onClose={() => setCreating(false)}
        footer={
          <>
            <Button onClick={() => setCreating(false)}>{t('common.cancel')}</Button>
            <Button variant="primary" disabled={busy || !name.trim()} onClick={() => void create()}>
              {t('playlists.create')}
            </Button>
          </>
        }
      >
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <TextField label={t('playlists.name')} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
      </Dialog>

      <Dialog
        open={!!deleting}
        title={t('playlists.deleteTitle')}
        onClose={() => setDeleting(null)}
        footer={
          <>
            <Button onClick={() => setDeleting(null)}>{t('common.cancel')}</Button>
            <Button variant="danger" disabled={busy} onClick={() => void remove()}>
              {t('common.delete')}
            </Button>
          </>
        }
      >
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <p>{t('playlists.deleteBody', { name: deleting?.name })}</p>
      </Dialog>
    </>
  );
}
