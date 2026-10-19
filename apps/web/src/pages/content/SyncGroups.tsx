import { Alert, Button, Dialog, EmptyState, PageHeader, SelectField, StatusChip, TextField } from '@wallx-play/ui';
import { MAX_SYNC_SCREENS, MAX_WALL_SIDE, paths, type ScreenDoc, type SyncGroupDoc, type SyncMode } from '@wallx-play/shared';
import { collection, orderBy, query } from 'firebase/firestore';
import { Grid2x2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePlaylists, useScreens } from '../../content/data';
import { call, errorMessage } from '../../lib/api';
import { db } from '../../lib/firebase';
import { useQueryData, type WithId } from '../../lib/hooks';
import { useOrg } from '../../org/OrgProvider';
import './sync.css';
import { FeatureLocked } from '../../content/apps';

/** Sync groups: screens that play one playlist in lockstep, mirrored or as a video wall. */
export function SyncGroups() {
  const { t } = useTranslation();
  const { orgId, can, entitlements, siteScope } = useOrg();
  const inPlan = !!entitlements?.features.includes('screen.multiSync');
  const manage = can('screen.manage');
  const groups = useQueryData<SyncGroupDoc>(inPlan ? `syncGroups:${orgId}` : null, () => query(collection(db, paths.syncGroups(orgId)), orderBy('name')));
  const screens = useScreens(orgId, siteScope);
  const playlists = usePlaylists(orgId);
  const [editing, setEditing] = useState<WithId<SyncGroupDoc> | 'new' | null>(null);
  const [deleting, setDeleting] = useState<WithId<SyncGroupDoc> | null>(null);
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  if (entitlements && !inPlan) {
    return (
      <>
        <PageHeader title={t('nav.sync')} description={t('sync.description')} />
        <div className="wxp-card">
          <FeatureLocked feature="screen.multiSync" icon={<Grid2x2 size={24} aria-hidden />} title={t('sync.notInPlanTitle')} fallback={t('sync.notInPlanBody')} />
        </div>
      </>
    );
  }

  const screenName = (id: string) => screens.data.find((s) => s.id === id)?.name ?? t('sync.unknownScreen');
  const playlistName = (id: string) => playlists.data.find((p) => p.id === id)?.name ?? '—';

  async function remove() {
    if (!deleting) return;
    setBusy(true);
    setMessage(null);
    try {
      await call('deleteSyncGroup', { orgId, groupId: deleting.id });
      setMessage({ tone: 'success', text: t('sync.deleted', { name: deleting.name }) });
      setDeleting(null);
    } catch (err) {
      setMessage({ tone: 'danger', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title={t('nav.sync')}
        description={t('sync.description')}
        actions={
          manage ? (
            <Button variant="primary" onClick={() => setEditing('new')}>
              {t('sync.new')}
            </Button>
          ) : null
        }
      />
      {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}
      {groups.data.length === 0 ? (
        <div className="wxp-card">
          <EmptyState icon={<Grid2x2 size={24} aria-hidden />} title={t('sync.emptyTitle')} description={t('sync.emptyBody')} />
        </div>
      ) : (
        <div className="wxp-table-wrap">
          <table className="wxp-table">
            <thead>
              <tr>
                <th>{t('sync.name')}</th>
                <th>{t('sync.mode')}</th>
                <th>{t('sync.playlist')}</th>
                <th>{t('sync.screens')}</th>
                <th aria-label={t('common.actions')} />
              </tr>
            </thead>
            <tbody>
              {groups.data.map((g) => (
                <tr key={g.id}>
                  <td>
                    {g.name}
                    <div>{g.enabled ? <StatusChip tone="success">{t('sync.on')}</StatusChip> : <StatusChip tone="neutral">{t('sync.off')}</StatusChip>}</div>
                  </td>
                  <td>{g.mode === 'wall' ? t('sync.wallSize', { cols: g.cols, rows: g.rows }) : t('sync.modes.mirror')}</td>
                  <td>{playlistName(g.playlistId)}</td>
                  <td className="sync__names">{g.members.map((m) => screenName(m.screenId)).join(', ')}</td>
                  <td className="wxp-actions">
                    {manage ? (
                      <>
                        <Button size="sm" variant="tertiary" onClick={() => setEditing(g)}>
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
      <p className="wxp-muted sync__note">{t('sync.note')}</p>
      {editing ? (
        <SyncGroupDialog
          orgId={orgId}
          group={editing === 'new' ? null : editing}
          screens={screens.data}
          groups={groups.data}
          playlists={playlists.data}
          onClose={() => setEditing(null)}
          onSaved={(name, published) => {
            setMessage({ tone: 'success', text: t('sync.saved', { name, count: published }) });
            setEditing(null);
          }}
        />
      ) : null}
      {deleting ? (
        <Dialog
          open
          title={t('sync.deleteTitle', { name: deleting.name })}
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
          <p>{t('sync.deleteBody')}</p>
        </Dialog>
      ) : null}
    </>
  );
}

interface DialogProps {
  orgId: string;
  group: WithId<SyncGroupDoc> | null;
  screens: Array<WithId<ScreenDoc>>;
  groups: Array<WithId<SyncGroupDoc>>;
  playlists: Array<{ id: string; name: string }>;
  onClose: () => void;
  onSaved: (name: string, published: number) => void;
}

function SyncGroupDialog({ orgId, group, screens, groups, playlists, onClose, onSaved }: DialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState(group?.name ?? '');
  const [mode, setMode] = useState<SyncMode>(group?.mode ?? 'mirror');
  const [playlistId, setPlaylistId] = useState(group?.playlistId ?? playlists[0]?.id ?? '');
  const [rows, setRows] = useState(group?.rows && group.mode === 'wall' ? group.rows : 1);
  const [cols, setCols] = useState(group?.cols && group.mode === 'wall' ? group.cols : 2);
  const [selected, setSelected] = useState<string[]>(group?.mode === 'mirror' ? group.members.map((m) => m.screenId) : []);
  const [cells, setCells] = useState<Record<string, string>>(() =>
    Object.fromEntries(group?.mode === 'wall' ? group.members.map((m) => [`${m.row}:${m.col}`, m.screenId]) : []),
  );
  const [enabled, setEnabled] = useState(group?.enabled ?? true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Screens already in another group cannot be added here.
  const takenBy = new Map(groups.filter((g) => g.id !== group?.id).flatMap((g) => g.members.map((m) => [m.screenId, g.name] as const)));
  const usable = screens.filter((s) => s.status === 'authorized');
  const options: Array<{ value: string; label: string; disabled?: boolean }> = [
    { value: '', label: t('sync.chooseScreen') },
    ...usable.map((s) => ({ value: s.id, label: s.name, disabled: takenBy.has(s.id) })),
  ];

  const members =
    mode === 'mirror'
      ? selected.map((screenId) => ({ screenId, row: 0, col: 0 }))
      : Object.entries(cells)
          .filter(([key, id]) => !!id && Number(key.split(':')[0]) < rows && Number(key.split(':')[1]) < cols)
          .map(([key, screenId]) => ({ screenId, row: Number(key.split(':')[0]), col: Number(key.split(':')[1]) }));
  const wallFull = mode !== 'wall' || (members.length === rows * cols && new Set(members.map((m) => m.screenId)).size === members.length);
  const valid = name.trim().length >= 2 && !!playlistId && members.length >= 2 && members.length <= MAX_SYNC_SCREENS && wallFull;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await call<{ published: number }>('saveSyncGroup', {
        orgId,
        ...(group ? { groupId: group.id } : {}),
        name: name.trim(),
        mode,
        playlistId,
        rows: mode === 'wall' ? rows : 1,
        cols: mode === 'wall' ? cols : 1,
        members,
        enabled,
      });
      onSaved(name.trim(), res.published);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const sides = Array.from({ length: MAX_WALL_SIDE }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }));

  return (
    <Dialog
      open
      title={group ? t('sync.edit') : t('sync.new')}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={busy || !valid} onClick={() => void save()}>
            {t('sync.saveAndPublish')}
          </Button>
        </>
      }
    >
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <TextField label={t('sync.name')} value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
      <fieldset className="sync__modes">
        <legend>{t('sync.mode')}</legend>
        {(['mirror', 'wall'] as const).map((m) => (
          <label key={m} className="checkbox-row">
            <input type="radio" name="sync-mode" checked={mode === m} onChange={() => setMode(m)} />
            <span>
              <strong>{t(`sync.modes.${m}`)}</strong>
              <span className="wxp-muted"> — {t(`sync.modeHints.${m}`)}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <SelectField
        label={t('sync.playlist')}
        hint={t('sync.playlistHint')}
        value={playlistId}
        onChange={(e) => setPlaylistId(e.target.value)}
        options={playlists.length ? playlists.map((p) => ({ value: p.id, label: p.name })) : [{ value: '', label: t('sync.noPlaylists') }]}
      />
      {mode === 'mirror' ? (
        <fieldset className="sync__screens">
          <legend>{t('sync.screens')}</legend>
          {usable.length === 0 ? <p className="wxp-muted">{t('sync.noScreens')}</p> : null}
          {usable.map((s) => (
            <label key={s.id} className="checkbox-row">
              <input
                type="checkbox"
                disabled={takenBy.has(s.id)}
                checked={selected.includes(s.id)}
                onChange={(e) => setSelected(e.target.checked ? [...selected, s.id] : selected.filter((x) => x !== s.id))}
              />
              <span>
                {s.name}
                {takenBy.has(s.id) ? <span className="wxp-muted"> — {t('sync.inGroup', { name: takenBy.get(s.id) })}</span> : null}
              </span>
            </label>
          ))}
        </fieldset>
      ) : (
        <>
          <div className="sync__size">
            <SelectField label={t('sync.cols')} value={String(cols)} onChange={(e) => setCols(Number(e.target.value))} options={sides} />
            <SelectField label={t('sync.rows')} value={String(rows)} onChange={(e) => setRows(Number(e.target.value))} options={sides} />
          </div>
          <p className="wxp-muted">{t('sync.wallHint')}</p>
          <div className="sync__grid" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
            {Array.from({ length: rows * cols }, (_, i) => {
              const key = `${Math.floor(i / cols)}:${i % cols}`;
              return (
                <div key={key} className="sync__cell">
                  <span className="wxp-muted sync__cellLabel">{t('sync.cell', { row: Math.floor(i / cols) + 1, col: (i % cols) + 1 })}</span>
                  <select
                    className="wxp-input"
                    aria-label={t('sync.cell', { row: Math.floor(i / cols) + 1, col: (i % cols) + 1 })}
                    value={cells[key] ?? ''}
                    onChange={(e) => setCells({ ...cells, [key]: e.target.value })}
                  >
                    {options.map((o) => (
                      <option key={o.value} value={o.value} disabled={o.disabled}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>
              );
            })}
          </div>
          {!wallFull ? <p className="wxp-field__error">{t('sync.fillWall')}</p> : null}
        </>
      )}
      <label className="checkbox-row">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        {t('sync.enabled')}
      </label>
    </Dialog>
  );
}
