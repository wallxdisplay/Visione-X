import { Alert, Button, Dialog, SelectField, Spinner, TextAreaField, TextField } from '@visione-x/ui';
import type { PlaylistItem, Widget } from '@visione-x/layout-spec';
import { paths, type MediaDoc, type PlaylistDoc } from '@visione-x/shared';
import { ArrowDown, ArrowLeft, ArrowUp, Clock, GripVertical, Image as ImageIcon, LayoutTemplate, Play, QrCode, Save, Trash2, Type } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useBlocker, useParams } from 'react-router';
import { MediaPicker } from '../../content/MediaPicker';
import { MediaThumb } from '../../content/MediaThumb';
import { formatDuration, newId } from '../../content/data';
import { PreviewOverlay } from '../../content/PreviewOverlay';
import { useRenderLibrary } from '../../content/useLibrary';
import { defaultWidget } from '../../content/widgetDefaults';
import { call, errorMessage } from '../../lib/api';
import { useDoc } from '../../lib/hooks';
import { useOrg } from '../../org/OrgProvider';
import { PlaylistPlayer, RenderLibraryProvider } from '../../render/Render';

const DEFAULT_IMAGE_SEC = 10;

export function PlaylistEditor() {
  const { t } = useTranslation();
  const { playlistId = '' } = useParams();
  const { orgId, org, can } = useOrg();
  const readOnly = !can('playlist.edit');
  const saved = useDoc<PlaylistDoc>(paths.playlist(orgId, playlistId));
  const { library, media, layouts } = useRenderLibrary(orgId);

  const [name, setName] = useState('');
  const [items, setItems] = useState<PlaylistItem[] | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [picker, setPicker] = useState(false);
  const [layoutPicker, setLayoutPicker] = useState(false);
  const [editing, setEditing] = useState<PlaylistItem | null>(null);
  const [preview, setPreview] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  useEffect(() => {
    if (saved.data && items === null) {
      setName(saved.data.name);
      setItems(saved.data.items);
    }
  }, [saved.data, items]);

  const blocker = useBlocker(dirty);

  if (saved.loading || (saved.data && items === null)) return <Spinner label={t('common.loading')} />;
  if (!saved.data || !items) return <Alert tone="danger">{t('playlists.notFound')}</Alert>;

  const update = (next: PlaylistItem[]) => {
    setItems(next);
    setDirty(true);
    setMessage(null);
  };
  const move = (from: number, to: number) => {
    if (to < 0 || to >= items.length || from === to) return;
    const next = [...items];
    const [x] = next.splice(from, 1);
    next.splice(to, 0, x!);
    update(next);
  };

  const addMedia = (picked: MediaDoc[]) => {
    setPicker(false);
    update([
      ...items,
      ...picked.map<PlaylistItem>((m) => ({
        id: newId(),
        content: { kind: 'media', mediaId: m.id },
        durationSec: m.type === 'image' ? DEFAULT_IMAGE_SEC : Math.max(1, Math.round(m.durationSec ?? DEFAULT_IMAGE_SEC)),
        transition: 'fade',
      })),
    ]);
  };

  const addWidget = (type: 'text' | 'clock' | 'qr') => {
    const item: PlaylistItem = {
      id: newId(),
      content: { kind: 'widget', widget: defaultWidget(type, org?.timezone ?? 'Asia/Kolkata') },
      durationSec: DEFAULT_IMAGE_SEC,
      transition: 'fade',
    };
    update([...items, item]);
    setEditing(item);
  };

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      await call('savePlaylist', { orgId, playlistId, name, items });
      setDirty(false);
      setMessage({ tone: 'success', text: t('playlists.saved') });
    } catch (err) {
      setMessage({ tone: 'danger', text: errorMessage(err) });
    } finally {
      setSaving(false);
    }
  };

  const label =(item: PlaylistItem): string => {
    const c = item.content;
    if (c.kind === 'media') return library.media.get(c.mediaId)?.name ?? t('render.missingMedia');
    if (c.kind === 'layout') return library.layouts.get(c.layoutId)?.name ?? t('playlists.missingLayout');
    if (c.widget.type === 'text') return c.widget.text.split('\n')[0]?.slice(0, 60) || t('studio.contentTypes.text');
    return t(`studio.contentTypes.${c.widget.type}`);
  };
  const total = items.reduce((s, i) => s + i.durationSec, 0);

  return (
    <div className="playlist-editor">
      <header className="studio__bar">
        <Link to="/playlists" className="vx-btn vx-btn--tertiary vx-btn--sm">
          <ArrowLeft size={16} aria-hidden /> {t('nav.playlists')}
        </Link>
        <input
          className="vx-input studio__name"
          aria-label={t('playlists.name')}
          value={name}
          maxLength={120}
          disabled={readOnly}
          onChange={(e) => {
            setName(e.target.value);
            setDirty(true);
          }}
        />
        <span className="vx-muted studio__state">
          {t('playlists.summary', { count: items.length, duration: formatDuration(total) })}
        </span>
        <div className="studio__actions">
          <Button size="sm" disabled={!items.length} onClick={() => setPreview(true)}>
            <Play size={15} aria-hidden /> {t('studio.preview')}
          </Button>
          {!readOnly ? (
            <Button size="sm" variant="primary" disabled={saving || !dirty || !name.trim()} onClick={() => void save()}>
              <Save size={15} aria-hidden /> {t('common.save')}
            </Button>
          ) : null}
        </div>
      </header>
      {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}
      {blocker.state === 'blocked' ? (
        <Alert tone="warning" title={t('studio.leaveTitle')}>
          <div className="vx-toolbar" style={{ margin: '8px 0 0' }}>
            <Button size="sm" onClick={() => blocker.reset()}>{t('studio.stay')}</Button>
            <Button size="sm" variant="danger" onClick={() => blocker.proceed()}>{t('studio.discard')}</Button>
          </div>
        </Alert>
      ) : null}

      <div className="playlist-editor__body">
        <section>
          {!readOnly ? (
            <div className="vx-toolbar">
              <Button size="sm" onClick={() => setPicker(true)}>
                <ImageIcon size={14} aria-hidden /> {t('playlists.addMedia')}
              </Button>
              <Button size="sm" onClick={() => setLayoutPicker(true)}>
                <LayoutTemplate size={14} aria-hidden /> {t('playlists.addLayout')}
              </Button>
              <Button size="sm" onClick={() => addWidget('text')}>
                <Type size={14} aria-hidden /> {t('studio.contentTypes.text')}
              </Button>
              <Button size="sm" onClick={() => addWidget('clock')}>
                <Clock size={14} aria-hidden /> {t('studio.contentTypes.clock')}
              </Button>
              <Button size="sm" onClick={() => addWidget('qr')}>
                <QrCode size={14} aria-hidden /> {t('studio.contentTypes.qr')}
              </Button>
            </div>
          ) : null}
          {items.length === 0 ? (
            <div className="vx-card">
              <p className="vx-muted" style={{ margin: 0 }}>{t('playlists.noItems')}</p>
            </div>
          ) : (
            <ol className="playlist-items">
              {items.map((item, i) => {
                const m = item.content.kind === 'media' ? library.media.get(item.content.mediaId) : undefined;
                return (
                  <li
                    key={item.id}
                    className={`playlist-item${dragIndex === i ? ' playlist-item--dragging' : ''}`}
                    draggable={!readOnly}
                    onDragStart={() => setDragIndex(i)}
                    onDragOver={(e) => {
                      e.preventDefault();
                      if (dragIndex !== null && dragIndex !== i) {
                        move(dragIndex, i);
                        setDragIndex(i);
                      }
                    }}
                    onDragEnd={() => setDragIndex(null)}
                  >
                    {!readOnly ? <GripVertical size={16} className="playlist-item__grip" aria-hidden /> : null}
                    <span className="playlist-item__index vx-tabular">{i + 1}</span>
                    <div className="playlist-item__thumb">
                      {m ? (
                        <MediaThumb media={m} />
                      ) : item.content.kind === 'layout' ? (
                        <LayoutTemplate size={20} aria-hidden />
                      ) : (
                        <Type size={20} aria-hidden />
                      )}
                    </div>
                    <div className="playlist-item__main">
                      <span className="playlist-item__name">{label(item)}</span>
                      <span className="vx-muted">
                        {t(`playlists.kinds.${item.content.kind === 'media' ? (m?.type ?? 'media') : item.content.kind}`)}
                        {m?.status && m.status !== 'ready' ? ` · ${t(`library.status.${m.status}`)}` : ''}
                      </span>
                    </div>
                    <label className="playlist-item__duration">
                      <span className="sr-only">{t('playlists.seconds')}</span>
                      <input
                        type="number"
                        className="vx-input"
                        min={1}
                        max={86400}
                        disabled={readOnly}
                        value={item.durationSec}
                        aria-label={t('playlists.durationFor', { name: label(item) })}
                        onChange={(e) =>
                          update(items.map((x) => (x.id === item.id ? { ...x, durationSec: Math.max(1, Math.min(86400, Math.round(Number(e.target.value) || 1))) } : x)))
                        }
                      />
                      <span className="vx-muted">s</span>
                    </label>
                    <select
                      className="vx-input playlist-item__transition"
                      aria-label={t('playlists.transition')}
                      disabled={readOnly}
                      value={item.transition}
                      onChange={(e) => update(items.map((x) => (x.id === item.id ? { ...x, transition: e.target.value as PlaylistItem['transition'] } : x)))}
                    >
                      {(['none', 'fade', 'slide'] as const).map((tr) => (
                        <option key={tr} value={tr}>
                          {t(`playlists.transitions.${tr}`)}
                        </option>
                      ))}
                    </select>
                    {!readOnly ? (
                      <div className="playlist-item__actions">
                        {item.content.kind === 'widget' ? (
                          <Button size="sm" variant="tertiary" onClick={() => setEditing(item)}>{t('common.edit')}</Button>
                        ) : null}
                        <Button size="sm" variant="tertiary" aria-label={t('playlists.moveUp')} disabled={i === 0} onClick={() => move(i, i - 1)}>
                          <ArrowUp size={14} />
                        </Button>
                        <Button size="sm" variant="tertiary" aria-label={t('playlists.moveDown')} disabled={i === items.length - 1} onClick={() => move(i, i + 1)}>
                          <ArrowDown size={14} />
                        </Button>
                        <Button size="sm" variant="tertiary" aria-label={t('playlists.remove')} onClick={() => update(items.filter((x) => x.id !== item.id))}>
                          <Trash2 size={14} />
                        </Button>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          )}
        </section>
        <aside className="playlist-editor__preview">
          <div className="studio__panel-title">{t('studio.preview')}</div>
          <RenderLibraryProvider value={library}>
            <div className="r-canvas" style={{ width: '100%', aspectRatio: '16 / 9', background: '#000', borderRadius: 8 }}>
              <PlaylistPlayer items={items} />
            </div>
          </RenderLibraryProvider>
          <p className="vx-muted">{t('playlists.previewHint')}</p>
        </aside>
      </div>

      <MediaPicker open={picker} media={media.data} types={['image', 'video', 'audio']} multiple onClose={() => setPicker(false)} onPick={addMedia} />

      <Dialog open={layoutPicker} title={t('playlists.addLayout')} onClose={() => setLayoutPicker(false)}>
        {layouts.data.length === 0 ? (
          <p className="vx-muted">{t('playlists.noLayouts')}</p>
        ) : (
          <ul className="choice-list">
            {layouts.data.map((l) => (
              <li key={l.id}>
                <button
                  type="button"
                  onClick={() => {
                    setLayoutPicker(false);
                    update([...items, { id: newId(), content: { kind: 'layout', layoutId: l.id }, durationSec: 15, transition: 'fade' }]);
                  }}
                >
                  <strong>{l.name}</strong>
                  <span className="vx-muted">
                    {l.canvas.width}×{l.canvas.height}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Dialog>

      {editing && editing.content.kind === 'widget' ? (
        <WidgetItemDialog
          widget={editing.content.widget}
          onClose={() => setEditing(null)}
          onSave={(widget) => {
            update(items.map((x) => (x.id === editing.id ? { ...x, content: { kind: 'widget', widget } } : x)));
            setEditing(null);
          }}
        />
      ) : null}

      {preview ? <PreviewOverlay library={library} playlist={items} onClose={() => setPreview(false)} /> : null}
    </div>
  );
}

/** Quick editor for full-screen widget items in a playlist. */
function WidgetItemDialog({ widget, onClose, onSave }: { widget: Widget; onClose: () => void; onSave: (w: Widget) => void }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<Widget>(widget);
  return (
    <Dialog
      open
      title={t(`studio.contentTypes.${widget.type}`)}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={() => onSave(draft)}>{t('common.done')}</Button>
        </>
      }
    >
      {draft.type === 'text' ? (
        <TextAreaField label={t('studio.text')} value={draft.text} maxLength={2000} onChange={(e) => setDraft({ ...draft, text: e.target.value })} />
      ) : null}
      {draft.type === 'clock' ? (
        <SelectField
          label={t('studio.clockFormat')}
          options={['time', 'date', 'datetime'].map((f) => ({ value: f, label: t(`studio.clockFormats.${f}`) }))}
          value={draft.format}
          onChange={(e) => setDraft({ ...draft, format: e.target.value as 'time' | 'date' | 'datetime' })}
        />
      ) : null}
      {draft.type === 'qr' ? (
        <TextField label={t('studio.qrValue')} value={draft.value} maxLength={1000} onChange={(e) => setDraft({ ...draft, value: e.target.value })} />
      ) : null}
      <p className="vx-muted">{t('playlists.widgetHint')}</p>
    </Dialog>
  );
}
