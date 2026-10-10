import { Button, SelectField, TextAreaField, TextField } from '@visione-x/ui';
import type { TextStyle, Widget, Zone, ZoneContent } from '@visione-x/layout-spec';
import type { MediaDoc, PlaylistDoc } from '@visione-x/shared';
import { ArrowDown, ArrowUp, Copy, Trash2 } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { timezoneOptions } from '../lib/format';
import { MediaPicker } from './MediaPicker';
import { MediaThumb } from './MediaThumb';
import { defaultWidget, type EditableWidgetType } from './widgetDefaults';

type ContentChoice = 'empty' | 'media' | 'playlist' | EditableWidgetType;

function choiceOf(content: ZoneContent): ContentChoice {
  if (content.kind === 'widget') return content.widget.type as EditableWidgetType;
  return content.kind;
}

const pct = (v: number) => Math.round(v * 1000) / 10;

/** Properties panel for the selected zone. All edits go through `onChange` (undoable). */
export function ZoneInspector({
  zone,
  media,
  playlists,
  timezone,
  readOnly,
  autoPickMedia = false,
  onChange,
  onRemove,
  onDuplicate,
  onLayer,
}: {
  zone: Zone;
  media: MediaDoc[];
  playlists: PlaylistDoc[];
  timezone: string;
  readOnly: boolean;
  /** Open the media picker immediately (zone was just added as a media zone). */
  autoPickMedia?: boolean;
  onChange: (zone: Zone) => void;
  onRemove: () => void;
  onDuplicate: () => void;
  onLayer: (delta: 1 | -1) => void;
}) {
  const { t } = useTranslation();
  const [picking, setPicking] = useState(autoPickMedia);
  const timezones = useMemo(timezoneOptions, []);
  const choice = choiceOf(zone.content);
  const zonePlaylists = playlists.filter((p) => p.layoutIds.length === 0);

  const setContent = (content: ZoneContent) => onChange({ ...zone, content });
  const setWidget = (widget: Widget) => setContent({ kind: 'widget', widget });

  function changeChoice(next: ContentChoice) {
    if (next === 'empty') setContent({ kind: 'empty' });
    else if (next === 'media') setPicking(true);
    else if (next === 'playlist') setContent({ kind: 'playlist', playlistId: zonePlaylists[0]?.id ?? '' });
    else setWidget(defaultWidget(next, timezone));
  }

  function geometry(key: 'x' | 'y' | 'w' | 'h', value: string) {
    const v = Math.min(100, Math.max(key === 'w' || key === 'h' ? 2 : 0, Number(value))) / 100;
    if (Number.isNaN(v)) return;
    const next = { ...zone, [key]: v };
    next.x = Math.min(next.x, 1 - next.w);
    next.y = Math.min(next.y, 1 - next.h);
    onChange(next);
  }

  const styleEditor = (style: TextStyle | undefined, update: (s: TextStyle) => void, defaultScale: number) => (
    <>
      <div className="vx-form__row">
        <label className="vx-field">
          <span className="vx-field__label">{t('studio.color')}</span>
          <input type="color" className="color-input" value={style?.color ?? '#FFFFFF'} disabled={readOnly} onChange={(e) => update({ ...style, color: e.target.value.toUpperCase() })} />
        </label>
        <label className="vx-field">
          <span className="vx-field__label">{t('studio.background')}</span>
          <span className="color-row">
            <input
              type="color"
              className="color-input"
              value={style?.background ?? '#000000'}
              disabled={readOnly}
              onChange={(e) => update({ ...style, background: e.target.value.toUpperCase() })}
            />
            {style?.background ? (
              <Button size="sm" variant="tertiary" disabled={readOnly} onClick={() => update({ ...style, background: undefined })}>
                {t('studio.transparent')}
              </Button>
            ) : null}
          </span>
        </label>
      </div>
      <label className="vx-field">
        <span className="vx-field__label">
          {t('studio.textSize')} <span className="vx-muted">{Math.round((style?.fontScale ?? defaultScale) * 100)}%</span>
        </span>
        <input
          type="range"
          min={2}
          max={100}
          value={Math.round((style?.fontScale ?? defaultScale) * 100)}
          disabled={readOnly}
          onChange={(e) => update({ ...style, fontScale: Number(e.target.value) / 100 })}
        />
      </label>
      <div className="vx-form__row">
        <SelectField
          label={t('studio.align')}
          options={['start', 'center', 'end'].map((a) => ({ value: a, label: t(`studio.alignOptions.${a}`) }))}
          value={style?.align ?? 'center'}
          disabled={readOnly}
          onChange={(e) => update({ ...style, align: e.target.value as TextStyle['align'] })}
        />
        <label className="checkbox-row">
          <input type="checkbox" checked={!!style?.bold} disabled={readOnly} onChange={(e) => update({ ...style, bold: e.target.checked })} />
          {t('studio.bold')}
        </label>
      </div>
    </>
  );

  const c = zone.content;
  return (
    <div className="inspector">
      <TextField label={t('studio.zoneName')} value={zone.name} disabled={readOnly} maxLength={60} onChange={(e) => onChange({ ...zone, name: e.target.value })} />
      <div className="inspector__grid">
        {(['x', 'y', 'w', 'h'] as const).map((k) => (
          <TextField
            key={k}
            label={t(`studio.geometry.${k}`)}
            type="number"
            step={0.5}
            min={0}
            max={100}
            disabled={readOnly}
            value={pct(zone[k])}
            onChange={(e) => geometry(k, e.target.value)}
          />
        ))}
      </div>
      {!readOnly ? (
        <div className="vx-toolbar" style={{ margin: 0 }}>
          <Button size="sm" onClick={() => onLayer(1)} title={t('studio.bringForward')}>
            <ArrowUp size={14} aria-hidden /> {t('studio.forward')}
          </Button>
          <Button size="sm" onClick={() => onLayer(-1)} title={t('studio.sendBackward')}>
            <ArrowDown size={14} aria-hidden /> {t('studio.backward')}
          </Button>
          <Button size="sm" onClick={onDuplicate}>
            <Copy size={14} aria-hidden /> {t('studio.duplicate')}
          </Button>
          <Button size="sm" variant="tertiary" onClick={onRemove}>
            <Trash2 size={14} aria-hidden /> {t('studio.removeZone')}
          </Button>
        </div>
      ) : null}

      <hr className="inspector__rule" />
      <SelectField
        label={t('studio.content')}
        disabled={readOnly}
        options={(['empty', 'media', 'playlist', 'text', 'clock', 'qr', 'table', 'web'] as ContentChoice[]).map((v) => ({
          value: v,
          label: t(`studio.contentTypes.${v}`),
        }))}
        value={choice}
        onChange={(e) => changeChoice(e.target.value as ContentChoice)}
      />

      {c.kind === 'media' ? (
        <>
          <div className="inspector__media">
            {media.find((m) => m.id === c.mediaId) ? (
              <>
                <div className="media-thumb">
                  <MediaThumb media={media.find((m) => m.id === c.mediaId)!} />
                </div>
                <span>{media.find((m) => m.id === c.mediaId)!.name}</span>
              </>
            ) : (
              <span className="vx-field__error">{t('render.missingMedia')}</span>
            )}
          </div>
          {!readOnly ? <Button size="sm" onClick={() => setPicking(true)}>{t('studio.changeMedia')}</Button> : null}
          <SelectField
            label={t('studio.fit')}
            hint={t('studio.fitHint')}
            disabled={readOnly}
            options={['contain', 'cover', 'fill'].map((f) => ({ value: f, label: t(`studio.fitOptions.${f}`) }))}
            value={c.fit}
            onChange={(e) => setContent({ ...c, fit: e.target.value as 'contain' | 'cover' | 'fill' })}
          />
        </>
      ) : null}

      {c.kind === 'playlist' ? (
        zonePlaylists.length ? (
          <SelectField
            label={t('studio.playlist')}
            hint={t('studio.playlistHint')}
            disabled={readOnly}
            options={[{ value: '', label: t('studio.choosePlaylist') }, ...zonePlaylists.map((p) => ({ value: p.id, label: p.name }))]}
            value={c.playlistId}
            onChange={(e) => setContent({ kind: 'playlist', playlistId: e.target.value })}
          />
        ) : (
          <p className="vx-muted">{t('studio.noZonePlaylists')}</p>
        )
      ) : null}

      {c.kind === 'widget' && c.widget.type === 'text' ? (
        <>
          <TextAreaField
            label={t('studio.text')}
            hint={t('studio.textHint')}
            value={c.widget.text}
            disabled={readOnly}
            maxLength={2000}
            onChange={(e) => setWidget({ ...c.widget, text: e.target.value } as Widget)}
          />
          {styleEditor(c.widget.style, (style) => setWidget({ ...c.widget, style } as Widget), 0.4)}
        </>
      ) : null}

      {c.kind === 'widget' && c.widget.type === 'clock' ? (
        <>
          <SelectField
            label={t('studio.clockFormat')}
            disabled={readOnly}
            options={['time', 'date', 'datetime'].map((f) => ({ value: f, label: t(`studio.clockFormats.${f}`) }))}
            value={c.widget.format}
            onChange={(e) => setWidget({ ...c.widget, format: e.target.value } as Widget)}
          />
          <SelectField
            label={t('studio.timezone')}
            disabled={readOnly}
            options={timezones}
            value={c.widget.timezone}
            onChange={(e) => setWidget({ ...c.widget, timezone: e.target.value } as Widget)}
          />
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={c.widget.seconds}
              disabled={readOnly}
              onChange={(e) => setWidget({ ...c.widget, seconds: e.target.checked } as Widget)}
            />
            {t('studio.showSeconds')}
          </label>
          {styleEditor(c.widget.style, (style) => setWidget({ ...c.widget, style } as Widget), 0.45)}
        </>
      ) : null}

      {c.kind === 'widget' && c.widget.type === 'qr' ? (
        <>
          <TextField
            label={t('studio.qrValue')}
            hint={t('studio.qrHint')}
            value={c.widget.value}
            disabled={readOnly}
            maxLength={1000}
            onChange={(e) => setWidget({ ...c.widget, value: e.target.value } as Widget)}
          />
          <div className="vx-form__row">
            <label className="vx-field">
              <span className="vx-field__label">{t('studio.color')}</span>
              <input type="color" className="color-input" value={c.widget.foreground} disabled={readOnly} onChange={(e) => setWidget({ ...c.widget, foreground: e.target.value.toUpperCase() } as Widget)} />
            </label>
            <label className="vx-field">
              <span className="vx-field__label">{t('studio.background')}</span>
              <input type="color" className="color-input" value={c.widget.background} disabled={readOnly} onChange={(e) => setWidget({ ...c.widget, background: e.target.value.toUpperCase() } as Widget)} />
            </label>
          </div>
        </>
      ) : null}

      {c.kind === 'widget' && c.widget.type === 'table' ? (
        <TableEditor
          widget={c.widget}
          readOnly={readOnly}
          onChange={(w) => setWidget(w)}
          styleEditor={(s, u) => styleEditor(s, u, 0.06)}
        />
      ) : null}

      {c.kind === 'widget' && c.widget.type === 'web' ? (
        <>
          <TextField
            label={t('studio.url')}
            hint={t('studio.urlHint')}
            type="url"
            value={c.widget.url}
            disabled={readOnly}
            onChange={(e) => setWidget({ ...c.widget, url: e.target.value } as Widget)}
          />
          <TextField
            label={t('studio.refresh')}
            type="number"
            min={30}
            value={c.widget.refreshSec ?? ''}
            disabled={readOnly}
            onChange={(e) =>
              setWidget({ ...c.widget, refreshSec: e.target.value ? Math.max(30, Number(e.target.value)) : undefined } as Widget)
            }
          />
        </>
      ) : null}

      <MediaPicker
        open={picking}
        media={media}
        types={['image', 'video']}
        onClose={() => setPicking(false)}
        onPick={([m]) => {
          setPicking(false);
          if (m) setContent({ kind: 'media', mediaId: m.id, fit: c.kind === 'media' ? c.fit : 'cover' });
        }}
      />
    </div>
  );
}

function TableEditor({
  widget,
  readOnly,
  onChange,
  styleEditor,
}: {
  widget: Extract<Widget, { type: 'table' }>;
  readOnly: boolean;
  onChange: (w: Widget) => void;
  styleEditor: (s: TextStyle | undefined, u: (s: TextStyle) => void) => ReactNode;
}) {
  const { t } = useTranslation();
  const asText = (w: typeof widget) =>
    [w.columns.join(' | '), ...w.rows.map((r) => r.map((c) => (typeof c === 'string' ? c : '')).join(' | '))].join('\n');
  const [text, setText] = useState(() => asText(widget));

  function apply(value: string) {
    setText(value);
    const lines = value.split('\n').map((l) => l.split('|').map((c) => c.trim()));
    const [columns = [''], ...rows] = lines;
    onChange({
      ...widget,
      columns: columns.slice(0, 10).map((c) => c.slice(0, 80)),
      rows: rows
        .filter((r) => r.some(Boolean))
        .slice(0, 50)
        .map((r) => r.slice(0, columns.length).map((c) => c.slice(0, 200))),
    });
  }

  return (
    <>
      <TextAreaField label={t('studio.tableData')} hint={t('studio.tableHint')} value={text} disabled={readOnly} rows={6} onChange={(e) => apply(e.target.value)} />
      {styleEditor(widget.style, (style) => onChange({ ...widget, style }))}
    </>
  );
}
