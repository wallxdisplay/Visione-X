import { collection, collectionGroup, limit, orderBy, query } from 'firebase/firestore';
import { ref, uploadBytesResumable } from 'firebase/storage';
import { Alert, Button, Dialog, PageHeader, SelectField, StatusChip, TextAreaField, TextField } from '@wallx-play/ui';
import {
  hasPlatformPermission,
  MAX_PILOT_ORGS,
  MAX_PLAYER_APK_BYTES,
  PLAYER_APK_MIME,
  PLAYER_ROLLOUTS,
  type OrgDoc,
  type PlayerReleaseDoc,
  type PlayerRollout,
  type ScreenDoc,
} from '@wallx-play/shared';
import { Upload } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../auth/AuthProvider';
import { formatBytes } from '../../content/data';
import { call, errorMessage } from '../../lib/api';
import { db, storage } from '../../lib/firebase';
import { formatDateTime } from '../../lib/format';
import { useQueryData, type WithId } from '../../lib/hooks';
import './admin.css';

const ROLLOUT_TONE: Record<PlayerRollout, 'neutral' | 'info' | 'success' | 'warning'> = { draft: 'neutral', pilot: 'info', all: 'success', withdrawn: 'warning' };

/** Super Admin: player app releases and their rollout (in-app updates). */
export function AdminPlayers() {
  const { t } = useTranslation();
  const { platformRole } = useAuth();
  const canRelease = hasPlatformPermission(platformRole, 'player.release');
  const releases = useQueryData<PlayerReleaseDoc>('admin:playerReleases', () => query(collection(db, 'playerReleases'), orderBy('createdAt', 'desc'), limit(50)));
  const screens = useQueryData<ScreenDoc>('admin:screens', () => query(collectionGroup(db, 'screens'), limit(2000)));
  const orgs = useQueryData<OrgDoc>('admin:orgs', () => query(collection(db, 'orgs'), limit(1000)));
  const [uploading, setUploading] = useState(false);
  const [rollout, setRollout] = useState<WithId<PlayerReleaseDoc> | null>(null);

  const onVersion = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of screens.data) if (s.health?.appVersion) m.set(s.health.appVersion, (m.get(s.health.appVersion) ?? 0) + 1);
    return m;
  }, [screens.data]);
  const waiting = screens.data.filter((s) => s.health?.update?.state === 'waiting_user').length;
  const failing = screens.data.filter((s) => s.health?.update?.state === 'failed').length;
  const visible = releases.data.filter((r) => r.status !== 'uploading');

  return (
    <>
      <PageHeader
        title={t('nav.admin.players')}
        description={t('adminPlayers.description')}
        actions={
          canRelease ? (
            <Button variant="primary" onClick={() => setUploading(true)}>
              <Upload size={16} aria-hidden /> {t('adminPlayers.upload')}
            </Button>
          ) : null
        }
      />
      {waiting ? <Alert tone="info">{t('adminPlayers.waiting', { count: waiting })}</Alert> : null}
      {failing ? <Alert tone="warning">{t('adminPlayers.failing', { count: failing })}</Alert> : null}

      <div className="wxp-table-wrap">
        <table className="wxp-table">
          <thead>
            <tr>
              <th>{t('adminPlayers.version')}</th>
              <th>{t('adminPlayers.rollout')}</th>
              <th>{t('adminPlayers.onScreens')}</th>
              <th>{t('adminPlayers.uploaded')}</th>
              <th>{t('adminPlayers.size')}</th>
              <th aria-label={t('common.actions')} />
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr key={r.id}>
                <td>
                  {r.status === 'ready' ? (
                    <>
                      <strong className="wxp-tabular">v{r.versionName}</strong> <span className="wxp-muted wxp-tabular">({r.versionCode})</span>
                      {r.notes ? <div className="wxp-muted">{r.notes}</div> : null}
                    </>
                  ) : (
                    <>
                      <StatusChip tone="danger">{t('adminPlayers.rejected')}</StatusChip>
                      <div className="wxp-muted">{r.error}</div>
                    </>
                  )}
                </td>
                <td>
                  {r.status === 'ready' ? (
                    <StatusChip tone={ROLLOUT_TONE[r.rollout]}>
                      {t(`adminPlayers.rollouts.${r.rollout}`)}
                      {r.rollout === 'pilot' ? ` · ${r.pilotOrgIds.length}` : ''}
                    </StatusChip>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="wxp-tabular">{r.versionName ? (onVersion.get(r.versionName) ?? 0) : '—'}</td>
                <td>{formatDateTime(r.createdAt)}</td>
                <td className="wxp-tabular">{formatBytes(r.bytes)}</td>
                <td className="wxp-actions">
                  {canRelease && r.status === 'ready' ? (
                    <Button size="sm" variant="tertiary" onClick={() => setRollout(r)}>
                      {t('adminPlayers.changeRollout')}
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {visible.length === 0 && !releases.loading ? <p className="wxp-muted">{t('adminPlayers.none')}</p> : null}
      <p className="wxp-muted" style={{ marginTop: 16 }}>{t('adminPlayers.howItWorks')}</p>

      {uploading ? <UploadDialog onClose={() => setUploading(false)} /> : null}
      {rollout ? <RolloutDialog release={rollout} orgs={orgs.data} onClose={() => setRollout(null)} /> : null}
    </>
  );
}

function UploadDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [file, setFile] = useState<File | null>(null);
  const [notes, setNotes] = useState('');
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ versionName: string; versionCode: number } | null>(null);

  async function upload() {
    if (!file) return;
    setError(null);
    if (file.size > MAX_PLAYER_APK_BYTES) return setError(t('adminPlayers.tooLarge'));
    try {
      setProgress(0);
      const { releaseId, path } = await call<{ releaseId: string; path: string }>('createPlayerReleaseUpload', { bytes: file.size });
      await new Promise<void>((resolve, reject) => {
        const task = uploadBytesResumable(ref(storage, path), file, { contentType: PLAYER_APK_MIME });
        task.on('state_changed', (s) => setProgress(s.totalBytes ? s.bytesTransferred / s.totalBytes : 0), reject, () => resolve());
      });
      setProgress(1);
      setDone(await call<{ versionName: string; versionCode: number }>('registerPlayerRelease', { releaseId, notes }));
    } catch (err) {
      setError(errorMessage(err));
      setProgress(null);
    }
  }

  const busy = progress !== null && !done && !error;
  return (
    <Dialog
      open
      title={t('adminPlayers.upload')}
      onClose={busy ? () => undefined : onClose}
      footer={
        done ? (
          <Button variant="primary" onClick={onClose}>{t('common.done')}</Button>
        ) : (
          <>
            <Button disabled={busy} onClick={onClose}>{t('common.cancel')}</Button>
            <Button variant="primary" disabled={!file || busy} onClick={() => void upload()}>
              {t('adminPlayers.uploadAndCheck')}
            </Button>
          </>
        )
      }
    >
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {done ? (
        <Alert tone="success" title={t('adminPlayers.checked', { version: done.versionName, code: done.versionCode })}>
          {t('adminPlayers.checkedHint')}
        </Alert>
      ) : (
        <>
          <label className="wxp-field">
            <span className="wxp-field__label">{t('adminPlayers.apkFile')}</span>
            <input type="file" accept=".apk,application/vnd.android.package-archive" disabled={busy} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <span className="wxp-field__hint">{t('adminPlayers.apkHint')}</span>
          </label>
          <TextAreaField label={t('adminPlayers.notes')} maxLength={500} rows={3} value={notes} disabled={busy} onChange={(e) => setNotes(e.target.value)} />
          {progress !== null ? (
            <p className="wxp-muted wxp-tabular">{progress < 1 ? t('adminPlayers.uploadingPct', { pct: Math.round(progress * 100) }) : t('adminPlayers.checking')}</p>
          ) : null}
        </>
      )}
    </Dialog>
  );
}

function RolloutDialog({ release, orgs, onClose }: { release: WithId<PlayerReleaseDoc>; orgs: Array<WithId<OrgDoc>>; onClose: () => void }) {
  const { t } = useTranslation();
  const [rollout, setRollout] = useState<PlayerRollout>(release.rollout);
  const [pilot, setPilot] = useState<string[]>(release.pilotOrgIds);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = orgs.filter((o) => o.status === 'active').sort((a, b) => a.name.localeCompare(b.name));
  const q = search.trim().toLowerCase();
  const shown = active.filter((o) => pilot.includes(o.id) || !q || o.name.toLowerCase().includes(q)).slice(0, 100);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await call('setPlayerRollout', { releaseId: release.id, rollout, pilotOrgIds: rollout === 'pilot' ? pilot : [] });
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
      title={t('adminPlayers.rolloutTitle', { version: release.versionName })}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={busy || (rollout === 'pilot' && pilot.length === 0)} onClick={() => void save()}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <SelectField
        label={t('adminPlayers.rollout')}
        options={PLAYER_ROLLOUTS.map((r) => ({ value: r, label: t(`adminPlayers.rollouts.${r}`) }))}
        value={rollout}
        hint={t(`adminPlayers.rolloutHints.${rollout}`)}
        onChange={(e) => setRollout(e.target.value as PlayerRollout)}
      />
      {rollout === 'pilot' ? (
        <fieldset className="site-picker">
          <legend className="wxp-field__label">{t('adminPlayers.pilotOrgs', { count: pilot.length, max: MAX_PILOT_ORGS })}</legend>
          <TextField label={t('adminPlayers.searchOrgs')} value={search} onChange={(e) => setSearch(e.target.value)} />
          <div className="site-picker__list">
            {shown.map((o) => (
              <label key={o.id} className="checkbox-row">
                <input
                  type="checkbox"
                  checked={pilot.includes(o.id)}
                  disabled={!pilot.includes(o.id) && pilot.length >= MAX_PILOT_ORGS}
                  onChange={(e) => setPilot(e.target.checked ? [...pilot, o.id] : pilot.filter((id) => id !== o.id))}
                />
                {o.name}
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}
      <p className="wxp-field__hint wxp-tabular">{t('adminPlayers.signer', { sha: release.signerSha256?.slice(0, 16) ?? '—' })}</p>
    </Dialog>
  );
}
