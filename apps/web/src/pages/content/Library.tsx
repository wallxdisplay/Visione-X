import { ref, uploadBytesResumable } from 'firebase/storage';
import { Alert, Button, Dialog, EmptyState, PageHeader, SelectField, StatusChip, TextField } from '@wallx-play/ui';
import { MEDIA_LIMITS, mediaTypeForMime, type MediaDoc } from '@wallx-play/shared';
import { FolderPlus, ImagePlus, Images, X } from 'lucide-react';
import { useMemo, useRef, useState, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { MediaThumb } from '../../content/MediaThumb';
import { formatBytes, formatDuration, mimeForFile, useFolders, useMediaList, useStorageUrl } from '../../content/data';
import { call, errorMessage } from '../../lib/api';
import { storage } from '../../lib/firebase';
import { formatDateTime } from '../../lib/format';
import { useOrg } from '../../org/OrgProvider';

interface UploadTask {
  key: string;
  name: string;
  progress: number;
  error?: string;
  done?: boolean;
  /** Set once the upload is created: its card then follows the media's processing status. */
  mediaId?: string;
}

const STATUS_TONE = { uploading: 'info', processing: 'info', ready: 'success', failed: 'danger' } as const;
/** Processing beyond this is treated as stuck (the function's hard limit is 9 minutes). */
const STUCK_MS = 15 * 60_000;

export function Library() {
  const { t } = useTranslation();
  const { orgId, can, entitlements } = useOrg();
  const media = useMediaList(orgId);
  const folders = useFolders(orgId);
  const canUpload = can('media.upload');
  const fileInput = useRef<HTMLInputElement>(null);

  const [tasks, setTasks] = useState<UploadTask[]>([]);
  const [type, setType] = useState<'all' | MediaDoc['type']>('all');
  const [folder, setFolder] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [detail, setDetail] = useState<MediaDoc | null>(null);
  const [folderDialog, setFolderDialog] = useState(false);
  const [dragging, setDragging] = useState(false);

  const items = useMemo(() => {
    const q = search.trim().toLowerCase();
    return media.data.filter(
      (m) =>
        (type === 'all' || m.type === type) &&
        (folder === 'all' || (folder === 'none' ? !m.folderId : m.folderId === folder)) &&
        (!q || m.name.toLowerCase().includes(q) || m.tags.some((tag) => tag.includes(q))),
    );
  }, [media.data, type, folder, search]);

  const patchTask = (key: string, patch: Partial<UploadTask>) =>
    setTasks((all) => all.map((x) => (x.key === key ? { ...x, ...patch } : x)));

  async function uploadOne(file: File) {
    const key = `${file.name}-${file.size}-${Math.random()}`;
    setTasks((all) => [...all, { key, name: file.name, progress: 0 }]);
    const mimeType = mimeForFile(file);
    const mediaType = mediaTypeForMime(mimeType);
    if (!mediaType) return patchTask(key, { error: t('library.unsupported') });
    if (file.size > MEDIA_LIMITS[mediaType].maxBytes) {
      return patchTask(key, { error: t('library.tooLarge', { limit: formatBytes(MEDIA_LIMITS[mediaType].maxBytes) }) });
    }
    try {
      const { mediaId, uploadPath } = await call<{ mediaId: string; uploadPath: string }>('createMediaUpload', {
        orgId,
        name: file.name,
        mimeType,
        bytes: file.size,
        folderId: folder !== 'all' && folder !== 'none' ? folder : null,
      });
      patchTask(key, { mediaId });
      await new Promise<void>((resolve, reject) => {
        const task = uploadBytesResumable(ref(storage, uploadPath), file, { contentType: mimeType });
        task.on(
          'state_changed',
          (s) => patchTask(key, { progress: s.totalBytes ? s.bytesTransferred / s.totalBytes : 0 }),
          reject,
          () => resolve(),
        );
      });
      patchTask(key, { progress: 1, done: true });
    } catch (err) {
      patchTask(key, { error: errorMessage(err) });
    }
  }

  function uploadFiles(files: FileList | File[]) {
    // Sequential keeps quota checks accurate and avoids saturating slow connections.
    void [...files].reduce<Promise<void>>((p, f) => p.then(() => uploadOne(f)), Promise.resolve());
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    if (canUpload && e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
  }

  const folderName = (id: string | null) => folders.data.find((f) => f.id === id)?.name;

  return (
    <div
      onDragOver={(e) => {
        if (!canUpload) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      className={dragging ? 'library library--dragging' : 'library'}
    >
      <PageHeader
        title={t('nav.library')}
        description={t('library.description', {
          limit: entitlements?.limits.storageGB ?? '∞',
        })}
        actions={
          canUpload ? (
            <div className="wxp-toolbar" style={{ margin: 0 }}>
              <Button onClick={() => setFolderDialog(true)}>
                <FolderPlus size={16} aria-hidden /> {t('library.newFolder')}
              </Button>
              <Button variant="primary" onClick={() => fileInput.current?.click()}>
                <ImagePlus size={16} aria-hidden /> {t('library.upload')}
              </Button>
              <input
                ref={fileInput}
                type="file"
                multiple
                hidden
                accept={Object.values(MEDIA_LIMITS).flatMap((l) => l.mimeTypes).join(',') + ',.mkv,.mov'}
                onChange={(e) => {
                  if (e.target.files) uploadFiles(e.target.files);
                  e.target.value = '';
                }}
              />
            </div>
          ) : null
        }
      />

      {tasks.length > 0 ? (
        <div className="upload-queue" aria-live="polite">
          <div className="upload-queue__head">
            <strong>{t('library.uploads')}</strong>
            <Button size="sm" variant="tertiary" onClick={() => setTasks((all) => all.filter((x) => !x.done && !x.error))}>
              {t('library.clearFinished')}
            </Button>
          </div>
          {tasks.map((task) => {
            // After the upload, show what processing made of it (ready or failed).
            const status = task.done ? media.data.find((m) => m.id === task.mediaId)?.status : undefined;
            return (
            <div key={task.key} className="upload-queue__row">
              <span className="upload-queue__name">{task.name}</span>
              {task.error ? (
                <span className="wxp-field__error">{task.error}</span>
              ) : status === 'ready' || status === 'failed' ? (
                <StatusChip tone={STATUS_TONE[status]}>{t(`library.status.${status}`)}</StatusChip>
              ) : task.done ? (
                <StatusChip tone="info">{t('library.uploadedProcessing')}</StatusChip>
              ) : (
                <progress max={1} value={task.progress} aria-label={task.name} />
              )}
            </div>
            );
          })}
        </div>
      ) : null}

      <div className="wxp-toolbar">
        <input
          className="wxp-input"
          style={{ maxWidth: 260 }}
          placeholder={t('library.search')}
          aria-label={t('library.search')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select className="wxp-input" style={{ width: 'auto' }} aria-label={t('library.type')} value={type} onChange={(e) => setType(e.target.value as typeof type)}>
          <option value="all">{t('library.allTypes')}</option>
          <option value="image">{t('library.types.image')}</option>
          <option value="video">{t('library.types.video')}</option>
          <option value="audio">{t('library.types.audio')}</option>
        </select>
        <select className="wxp-input" style={{ width: 'auto' }} aria-label={t('library.folder')} value={folder} onChange={(e) => setFolder(e.target.value)}>
          <option value="all">{t('library.allFolders')}</option>
          <option value="none">{t('library.noFolder')}</option>
          {folders.data.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      </div>

      {items.length === 0 && !media.loading ? (
        <div className="wxp-card">
          <EmptyState
            icon={<Images size={24} aria-hidden />}
            title={media.data.length ? t('library.noResults') : t('library.emptyTitle')}
            description={media.data.length ? undefined : t('library.emptyBody')}
            action={
              canUpload && !media.data.length ? (
                <Button variant="primary" onClick={() => fileInput.current?.click()}>
                  {t('library.upload')}
                </Button>
              ) : undefined
            }
          />
        </div>
      ) : (
        <div className="media-grid">
          {items.map((m) => {
            const stuck = m.status === 'processing' && Date.now() - (m.processingStartedAt ?? m.updatedAt) > STUCK_MS;
            return (
              <button key={m.id} type="button" className="media-card" onClick={() => setDetail(m)}>
                <div className="media-thumb">
                  <MediaThumb media={m} />
                  {m.durationSec ? <span className="media-thumb__badge">{formatDuration(m.durationSec)}</span> : null}
                </div>
                <div className="media-card__body">
                  <span className="media-card__name" title={m.name}>
                    {m.name}
                  </span>
                  <span className="wxp-muted">
                    {t(`library.types.${m.type}`)}
                    {m.width ? ` · ${m.width}×${m.height}` : ''}
                    {m.folderId ? ` · ${folderName(m.folderId) ?? ''}` : ''}
                  </span>
                  {m.status !== 'ready' ? (
                    <StatusChip tone={stuck ? 'danger' : STATUS_TONE[m.status]}>
                      {stuck ? t('library.status.stuck') : t(`library.status.${m.status}`)}
                    </StatusChip>
                  ) : null}
                </div>
              </button>
            );
          })}
        </div>
      )}

      {detail ? (
        <MediaDetails
          key={detail.id}
          media={media.data.find((m) => m.id === detail.id) ?? detail}
          folders={folders.data}
          onClose={() => setDetail(null)}
        />
      ) : null}
      <FolderDialog open={folderDialog} onClose={() => setFolderDialog(false)} />
    </div>
  );
}

function FolderDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const { orgId } = useOrg();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    setError(null);
    try {
      await call('upsertFolder', { orgId, name });
      setName('');
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={open}
      title={t('library.newFolder')}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={busy || !name.trim()} onClick={() => void save()}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <TextField label={t('library.folderName')} value={name} onChange={(e) => setName(e.target.value)} />
    </Dialog>
  );
}

function MediaDetails({
  media,
  folders,
  onClose,
}: {
  media: MediaDoc;
  folders: Array<{ id: string; name: string }>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { orgId, can } = useOrg();
  const [name, setName] = useState(media.name);
  const [folderId, setFolderId] = useState(media.folderId ?? '');
  const [tags, setTags] = useState(media.tags.join(', '));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const url = useStorageUrl(media.status === 'ready' ? (media.display?.path ?? media.originalPath) : null);

  async function run(action: () => Promise<unknown>, close = false) {
    setBusy(true);
    setError(null);
    try {
      await action();
      if (close) onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const save = () =>
    run(
      () =>
        call('updateMedia', {
          orgId,
          mediaId: media.id,
          name,
          folderId: folderId || null,
          tags: tags
            .split(',')
            .map((x) => x.trim())
            .filter(Boolean),
        }),
      true,
    );

  return (
    <Dialog
      open
      title={media.name}
      size="lg"
      onClose={onClose}
      footer={
        confirmDelete ? (
          <>
            <Button onClick={() => setConfirmDelete(false)}>{t('common.cancel')}</Button>
            <Button variant="danger" disabled={busy} onClick={() => void run(() => call('deleteMedia', { orgId, mediaId: media.id }), true)}>
              {t('library.deleteConfirm')}
            </Button>
          </>
        ) : (
          <>
            {can('media.delete') ? (
              <Button variant="tertiary" onClick={() => setConfirmDelete(true)}>
                {t('common.delete')}
              </Button>
            ) : null}
            <Button onClick={onClose}>{t('common.cancel')}</Button>
            {can('media.upload') ? (
              <Button variant="primary" disabled={busy || !name.trim()} onClick={() => void save()}>
                {t('common.save')}
              </Button>
            ) : null}
          </>
        )
      }
    >
      <button type="button" className="dialog-close" aria-label={t('common.cancel')} onClick={onClose}>
        <X size={18} />
      </button>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {confirmDelete ? <Alert tone="warning">{t('library.deleteBody')}</Alert> : null}
      {media.status === 'failed' ? <Alert tone="danger" title={t('library.status.failed')}>{media.error}</Alert> : null}
      <div className="media-preview">
        {url && media.type === 'image' ? <img src={url} alt="" /> : null}
        {url && media.type === 'video' ? <video src={url} controls muted playsInline /> : null}
        {url && media.type === 'audio' ? <audio src={url} controls /> : null}
        {!url ? <MediaThumb media={media} /> : null}
      </div>
      <dl className="wxp-dl">
        <dt>{t('library.type')}</dt>
        <dd>{t(`library.types.${media.type}`)}</dd>
        {media.width ? (
          <>
            <dt>{t('library.dimensions')}</dt>
            <dd className="wxp-tabular">
              {media.width}×{media.height}
            </dd>
          </>
        ) : null}
        {media.durationSec ? (
          <>
            <dt>{t('library.duration')}</dt>
            <dd className="wxp-tabular">{formatDuration(media.durationSec)}</dd>
          </>
        ) : null}
        <dt>{t('library.size')}</dt>
        <dd className="wxp-tabular">{formatBytes(media.storedBytes || media.bytes)}</dd>
        {media.display && media.display.path !== media.originalPath ? (
          <>
            <dt>{t('library.converted')}</dt>
            <dd>{t('library.convertedBody', { type: media.display.mimeType })}</dd>
          </>
        ) : null}
        <dt>{t('library.uploaded')}</dt>
        <dd>{formatDateTime(media.createdAt)}</dd>
      </dl>
      {can('media.upload') ? (
        <>
          <TextField label={t('library.name')} value={name} onChange={(e) => setName(e.target.value)} />
          <SelectField
            label={t('library.folder')}
            options={[{ value: '', label: t('library.noFolder') }, ...folders.map((f) => ({ value: f.id, label: f.name }))]}
            value={folderId}
            onChange={(e) => setFolderId(e.target.value)}
          />
          <TextField label={t('library.tags')} hint={t('library.tagsHint')} value={tags} onChange={(e) => setTags(e.target.value)} />
        </>
      ) : null}
    </Dialog>
  );
}
