import { Button, SelectField, TextField } from '@wallx-play/ui';
import type { Widget, Zone, ZoneContent } from '@wallx-play/layout-spec';
import type { MediaDoc, PlaylistDoc } from '@wallx-play/shared';
import { ArrowDown, ArrowUp, Copy, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MediaPicker } from './MediaPicker';
import { MediaThumb } from './MediaThumb';
import { defaultDataWidget, defaultSensorWidget, defaultWidget } from './widgetDefaults';
import { isDataChoice, isSensorChoice, WidgetEditor, widgetChoices, widgetChoicesHint, type WidgetChoice } from './WidgetEditor';
import type { WidgetSources } from './widgetSources';

type ContentChoice = 'empty' | 'media' | 'playlist' | WidgetChoice;

function choiceOf(content: ZoneContent): ContentChoice {
  return content.kind === 'widget' ? (content.widget.type as WidgetChoice) : content.kind;
}

const pct = (v: number) => Math.round(v * 1000) / 10;

/** Properties panel for the selected zone. All edits go through `onChange` (undoable). */
export function ZoneInspector({
  zone,
  media,
  playlists,
  timezone,
  readOnly,
  sources,
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
  /** Sensor channels and data sources widgets may show. */
  sources: WidgetSources;
  /** Open the media picker immediately (zone was just added as a media zone). */
  autoPickMedia?: boolean;
  onChange: (zone: Zone) => void;
  onRemove: () => void;
  onDuplicate: () => void;
  onLayer: (delta: 1 | -1) => void;
}) {
  const { t } = useTranslation();
  const [picking, setPicking] = useState(autoPickMedia);
  const choice = choiceOf(zone.content);
  const zonePlaylists = playlists.filter((p) => p.layoutIds.length === 0);
  const { sensors, dataSources } = sources;

  const setContent = (content: ZoneContent) => onChange({ ...zone, content });
  const setWidget = (widget: Widget) => setContent({ kind: 'widget', widget });

  function changeChoice(next: ContentChoice) {
    if (next === 'empty') setContent({ kind: 'empty' });
    else if (next === 'media') setPicking(true);
    else if (next === 'playlist') setContent({ kind: 'playlist', playlistId: zonePlaylists[0]?.id ?? '' });
    else if (isSensorChoice(next)) {
      // Keep the bound channel when switching between sensor widget types.
      const w = zone.content.kind === 'widget' ? zone.content.widget : null;
      const current = w && 'binding' in w ? w.binding : w?.type === 'chart' ? w.bindings[0] : null;
      const channel = sensors?.find((s) => current && s.sensorDeviceId === current.sourceId && s.channelId === current.field) ?? sensors?.[0];
      if (channel) setWidget(defaultSensorWidget(next, channel));
    } else if (isDataChoice(next)) {
      const first = dataSources[next]?.[0];
      if (first) setWidget(defaultDataWidget(next, first.id));
    } else setWidget(defaultWidget(next, timezone));
  }

  function geometry(key: 'x' | 'y' | 'w' | 'h', value: string) {
    const v = Math.min(100, Math.max(key === 'w' || key === 'h' ? 2 : 0, Number(value))) / 100;
    if (Number.isNaN(v)) return;
    const next = { ...zone, [key]: v };
    next.x = Math.min(next.x, 1 - next.w);
    next.y = Math.min(next.y, 1 - next.h);
    onChange(next);
  }

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
        <div className="wxp-toolbar" style={{ margin: 0 }}>
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
        options={[
          ...(['empty', 'media', 'playlist'] as const).map((v) => ({ value: v, label: t(`studio.contentTypes.${v}`) })),
          ...widgetChoices(sources).map((o) => ({ value: o.type, label: t(`studio.contentTypes.${o.type}`), disabled: o.disabled })),
        ]}
        hint={widgetChoicesHint(sources, t)}
        value={choice}
        onChange={(e) => changeChoice(e.target.value as ContentChoice)}
      />

      {c.kind === 'widget' ? <WidgetEditor widget={c.widget} sources={sources} readOnly={readOnly} compact onChange={setWidget} /> : null}

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
              <span className="wxp-field__error">{t('render.missingMedia')}</span>
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
          <p className="wxp-muted">{t('studio.noZonePlaylists')}</p>
        )
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
