import { Alert, Button, Spinner } from '@wallx-play/ui';
import { LayoutBody, RESOLUTION_PRESETS, type Zone } from '@wallx-play/layout-spec';
import { paths, type LayoutDoc } from '@wallx-play/shared';
import { ArrowLeft, Clock, Image as ImageIcon, Play, Plus, QrCode, Radio, Redo2, Save, Type, Undo2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useBlocker, useParams } from 'react-router';
import { newId } from '../../content/data';
import { PreviewOverlay } from '../../content/PreviewOverlay';
import { useRenderLibrary } from '../../content/useLibrary';
import { useAllChannels } from '../../content/sensors';
import { useDataSources } from '../../content/dataSources';
import { defaultSensorWidget, defaultWidget, type ChannelChoice, type DataWidgetType, type EditableWidgetType } from '../../content/widgetDefaults';
import { ZoneInspector, type DataSourceChoice } from '../../content/ZoneInspector';
import { call, errorMessage } from '../../lib/api';
import { fieldErrors } from '../../lib/format';
import { useDoc } from '../../lib/hooks';
import { useOrg } from '../../org/OrgProvider';
import { LayoutView, RenderLibraryProvider } from '../../render/Render';

const SNAP = 0.005;
const MIN = 0.02;
const snap = (v: number) => Math.round(v / SNAP) * SNAP;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

interface History {
  past: LayoutBody[];
  present: LayoutBody | null;
  future: LayoutBody[];
}

interface Drag {
  zoneId: string;
  mode: 'move' | Handle;
  startX: number;
  startY: number;
  origin: Zone;
  rect: DOMRect;
}

function applyDrag(d: Drag, clientX: number, clientY: number): Zone {
  const dx = (clientX - d.startX) / d.rect.width;
  const dy = (clientY - d.startY) / d.rect.height;
  const o = d.origin;
  if (d.mode === 'move') {
    return { ...o, x: snap(clamp(o.x + dx, 0, 1 - o.w)), y: snap(clamp(o.y + dy, 0, 1 - o.h)) };
  }
  let { x, y, w, h } = o;
  if (d.mode.includes('e')) w = clamp(o.w + dx, MIN, 1 - o.x);
  if (d.mode.includes('s')) h = clamp(o.h + dy, MIN, 1 - o.y);
  if (d.mode.includes('w')) {
    const nx = clamp(o.x + dx, 0, o.x + o.w - MIN);
    w = o.w + (o.x - nx);
    x = nx;
  }
  if (d.mode.includes('n')) {
    const ny = clamp(o.y + dy, 0, o.y + o.h - MIN);
    h = o.h + (o.y - ny);
    y = ny;
  }
  return { ...o, x: snap(x), y: snap(y), w: snap(Math.min(w, 1 - snap(x))), h: snap(Math.min(h, 1 - snap(y))) };
}

export function StudioEditor() {
  const { t } = useTranslation();
  const { layoutId = '' } = useParams();
  const { orgId, org, can, entitlements } = useOrg();
  const sensorsOn = !!entitlements?.features.includes('sensor.esp32') && can('sensor.view');
  const sensorChannels = useAllChannels(orgId, sensorsOn);
  const channelChoices = useMemo<ChannelChoice[] | null>(
    () =>
      sensorsOn
        ? sensorChannels.options.map(({ device, channel }) => ({
            sensorDeviceId: device.id,
            channelId: channel.id,
            name: `${device.name} · ${channel.name}`,
            channelName: channel.name,
            unit: channel.unit,
            valueType: channel.valueType,
            min: channel.min,
            max: channel.max,
          }))
        : null,
    [sensorsOn, sensorChannels.options],
  );
  const weatherOn = !!entitlements?.features.includes('widget.weather');
  const rssOn = !!entitlements?.features.includes('widget.rss');
  const sources = useDataSources(orgId, weatherOn || rssOn);
  const dataSourceChoices = useMemo<Partial<Record<DataWidgetType, DataSourceChoice[]>>>(() => {
    const pick = (type: DataWidgetType) => sources.data.filter((d) => d.type === type).map((d) => ({ id: d.id, name: d.name, type }));
    return { ...(weatherOn ? { weather: pick('weather') } : {}), ...(rssOn ? { rss: pick('rss') } : {}) };
  }, [sources.data, weatherOn, rssOn]);
  const readOnly = !can('layout.edit');
  const saved = useDoc<LayoutDoc>(paths.layout(orgId, layoutId));
  const { library, media, playlists } = useRenderLibrary(orgId);

  // Undo history lives in ONE state object, updated functionally, so rapid edits/undos never
  // read a stale snapshot.
  const [hist, setHist] = useState<History>({ past: [], present: null, future: [] });
  const { past, present: draft, future } = hist;
  const [selected, setSelected] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [preview, setPreview] = useState(false);
  /** Zone that should open the media picker right after being added. */
  const [pickFor, setPickFor] = useState<string | null>(null);
  const drag = useRef<Drag | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);

  // Load once; later snapshots (e.g. our own save) must not clobber local edits.
  useEffect(() => {
    if (saved.data && !draft) {
      const { name, canvas, zones } = saved.data;
      setHist({ past: [], present: { name, canvas, zones }, future: [] });
    }
  }, [saved.data, draft]);

  const blocker = useBlocker(dirty);
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  /** Every change goes through here so it can be undone. */
  const commit = useCallback(
    (update: (d: LayoutBody) => LayoutBody, record = true) => {
      if (readOnly) return;
      setHist((h) => {
        if (!h.present) return h;
        const next = update(h.present);
        return record ? { past: [...h.past.slice(-49), h.present], present: next, future: [] } : { ...h, present: next };
      });
      setDirty(true);
      setMessage(null);
    },
    [readOnly],
  );

  const updateZone = (zone: Zone, record = true) =>
    commit((d) => ({ ...d, zones: d.zones.map((z) => (z.id === zone.id ? zone : z)) }), record);

  function undo() {
    setHist((h) =>
      h.present && h.past.length
        ? { past: h.past.slice(0, -1), present: h.past[h.past.length - 1]!, future: [h.present, ...h.future] }
        : h,
    );
    setDirty(true);
  }
  function redo() {
    setHist((h) =>
      h.present && h.future.length ? { past: [...h.past, h.present], present: h.future[0]!, future: h.future.slice(1) } : h,
    );
    setDirty(true);
  }

  async function save() {
    if (!draft) return;
    const parsed = LayoutBody.safeParse(draft);
    if (!parsed.success) {
      setMessage({ tone: 'danger', text: Object.values(fieldErrors(parsed.error.issues))[0] ?? t('errors.generic') });
      return;
    }
    setSaving(true);
    try {
      await call('saveLayout', { orgId, layoutId, layout: parsed.data });
      setDirty(false);
      setMessage({ tone: 'success', text: t('studio.saved') });
    } catch (err) {
      setMessage({ tone: 'danger', text: errorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  function addZone(kind: 'empty' | 'media' | 'sensorValue' | EditableWidgetType) {
    if (!draft) return;
    const zone: Zone = {
      id: newId(),
      name: t(`studio.contentTypes.${kind}`),
      x: 0.35,
      y: 0.35,
      w: 0.3,
      h: 0.3,
      z: Math.max(0, ...draft.zones.map((z) => z.z)) + 1,
      content:
        kind === 'empty' || kind === 'media'
          ? { kind: 'empty' }
          : kind === 'sensorValue'
            ? { kind: 'widget', widget: defaultSensorWidget('sensorValue', channelChoices![0]!) }
            : { kind: 'widget', widget: defaultWidget(kind, org?.timezone ?? 'Asia/Kolkata') },
    };
    commit((d) => ({ ...d, zones: [...d.zones, zone] }));
    setSelected(zone.id);
    setPickFor(kind === 'media' ? zone.id : null);
  }

  function removeZone(id: string) {
    commit((d) => ({ ...d, zones: d.zones.filter((z) => z.id !== id) }));
    setSelected(null);
  }

  function duplicateZone(zone: Zone) {
    if (!draft) return;
    const copy: Zone = {
      ...zone,
      id: newId(),
      name: `${zone.name} 2`.slice(0, 60),
      x: clamp(zone.x + 0.02, 0, 1 - zone.w),
      y: clamp(zone.y + 0.02, 0, 1 - zone.h),
      z: Math.max(...draft.zones.map((z) => z.z)) + 1,
    };
    commit((d) => ({ ...d, zones: [...d.zones, copy] }));
    setSelected(copy.id);
  }

  function layer(zone: Zone, delta: 1 | -1) {
    commit((d) => {
      const sorted = [...d.zones].sort((a, b) => a.z - b.z);
      const i = sorted.findIndex((z) => z.id === zone.id);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= sorted.length) return d;
      [sorted[i], sorted[j]] = [sorted[j]!, sorted[i]!];
      return { ...d, zones: sorted.map((z, k) => ({ ...z, z: k })) };
    });
  }

  // Keyboard: arrows move (Shift = 5%), Delete removes, Ctrl+Z / Ctrl+Y / Ctrl+S.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void save();
        return;
      }
      if (typing) return;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
        return;
      }
      const zone = draft?.zones.find((z) => z.id === selected);
      if (!zone || readOnly) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        removeZone(zone.id);
        return;
      }
      const step = e.shiftKey ? 0.05 : SNAP;
      const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      const move = moves[e.key];
      if (move) {
        e.preventDefault();
        updateZone({ ...zone, x: snap(clamp(zone.x + move[0], 0, 1 - zone.w)), y: snap(clamp(zone.y + move[1], 0, 1 - zone.h)) });
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  function startDrag(e: ReactPointerEvent, zone: Zone, mode: Drag['mode']) {
    if (readOnly || !canvasRef.current || !draft) return;
    e.stopPropagation();
    e.preventDefault();
    setSelected(zone.id);
    // One undo step per drag: snapshot now, then move without recording.
    setHist((h) => (h.present ? { past: [...h.past.slice(-49), h.present], present: h.present, future: [] } : h));
    drag.current = { zoneId: zone.id, mode, startX: e.clientX, startY: e.clientY, origin: zone, rect: canvasRef.current.getBoundingClientRect() };
    const onMove = (ev: PointerEvent) => {
      if (!drag.current) return;
      const next = applyDrag(drag.current, ev.clientX, ev.clientY);
      setHist((h) =>
        h.present ? { ...h, present: { ...h.present, zones: h.present.zones.map((z) => (z.id === next.id ? next : z)) } } : h,
      );
      setDirty(true);
    };
    const onUp = () => {
      drag.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  if (saved.loading || (!draft && saved.data)) return <Spinner label={t('common.loading')} />;
  if (!saved.data || !draft) return <Alert tone="danger">{t('studio.notFound')}</Alert>;

  const zone = draft.zones.find((z) => z.id === selected) ?? null;
  const sortedZones = [...draft.zones].sort((a, b) => b.z - a.z);

  return (
    <div className="studio">
      <header className="studio__bar">
        <Link to="/studio" className="wxp-btn wxp-btn--tertiary wxp-btn--sm">
          <ArrowLeft size={16} aria-hidden /> {t('nav.studio')}
        </Link>
        <input
          className="wxp-input studio__name"
          aria-label={t('studio.name')}
          value={draft.name}
          maxLength={80}
          disabled={readOnly}
          onChange={(e) => {
            const name = e.target.value;
            commit((d) => ({ ...d, name }), false);
          }}
        />
        <span className="wxp-muted studio__state" aria-live="polite">
          {saving ? t('studio.saving') : dirty ? t('studio.unsaved') : t('studio.allSaved')}
        </span>
        <div className="studio__actions">
          <Button size="sm" variant="tertiary" disabled={!past.length} onClick={undo} aria-label={t('studio.undo')} title={t('studio.undo')}>
            <Undo2 size={16} />
          </Button>
          <Button size="sm" variant="tertiary" disabled={!future.length} onClick={redo} aria-label={t('studio.redo')} title={t('studio.redo')}>
            <Redo2 size={16} />
          </Button>
          <Button size="sm" onClick={() => setPreview(true)}>
            <Play size={15} aria-hidden /> {t('studio.preview')}
          </Button>
          {!readOnly ? (
            <Button size="sm" variant="primary" disabled={saving || !dirty} onClick={() => void save()}>
              <Save size={15} aria-hidden /> {t('common.save')}
            </Button>
          ) : null}
        </div>
      </header>
      {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}
      {blocker.state === 'blocked' ? (
        <Alert tone="warning" title={t('studio.leaveTitle')}>
          <div className="wxp-toolbar" style={{ margin: '8px 0 0' }}>
            <Button size="sm" onClick={() => blocker.reset()}>
              {t('studio.stay')}
            </Button>
            <Button size="sm" variant="danger" onClick={() => blocker.proceed()}>
              {t('studio.discard')}
            </Button>
          </div>
        </Alert>
      ) : null}

      <div className="studio__body">
        <aside className="studio__panel" aria-label={t('studio.layers')}>
          {!readOnly ? (
            <>
              <div className="studio__panel-title">{t('studio.add')}</div>
              <div className="studio__add">
                <Button size="sm" onClick={() => addZone('empty')}>
                  <Plus size={14} aria-hidden /> {t('studio.contentTypes.empty')}
                </Button>
                <Button size="sm" onClick={() => addZone('text')}>
                  <Type size={14} aria-hidden /> {t('studio.contentTypes.text')}
                </Button>
                <Button size="sm" onClick={() => addZone('clock')}>
                  <Clock size={14} aria-hidden /> {t('studio.contentTypes.clock')}
                </Button>
                <Button size="sm" onClick={() => addZone('qr')}>
                  <QrCode size={14} aria-hidden /> {t('studio.contentTypes.qr')}
                </Button>
                <Button size="sm" onClick={() => addZone('media')}>
                  <ImageIcon size={14} aria-hidden /> {t('studio.contentTypes.media')}
                </Button>
                {channelChoices?.length ? (
                  <Button size="sm" onClick={() => addZone('sensorValue')}>
                    <Radio size={14} aria-hidden /> {t('studio.contentTypes.sensorValue')}
                  </Button>
                ) : null}
              </div>
              <p className="wxp-muted studio__later">{t('studio.laterWidgets')}</p>
            </>
          ) : null}
          <div className="studio__panel-title">{t('studio.layers')}</div>
          <ul className="studio__layers">
            {sortedZones.map((z) => (
              <li key={z.id}>
                <button type="button" className={z.id === selected ? 'is-selected' : ''} onClick={() => setSelected(z.id)}>
                  <span>{z.name || t('studio.untitledZone')}</span>
                  <span className="wxp-muted">{t(`studio.contentTypes.${z.content.kind === 'widget' ? z.content.widget.type : z.content.kind}`)}</span>
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <div className="studio__stage" onPointerDown={() => setSelected(null)}>
          <div className={`studio__canvas-wrap studio__canvas-wrap--${draft.canvas.orientation}`}>
            <div
              ref={canvasRef}
              className="studio__canvas"
              style={{ aspectRatio: `${draft.canvas.width} / ${draft.canvas.height}` }}
            >
              <RenderLibraryProvider value={library}>
                <LayoutView
                  layout={draft}
                  fill
                  renderZone={(z, content) => (
                    <>
                      {content}
                      <div
                        className={`editor-zone${z.id === selected ? ' editor-zone--selected' : ''}${z.content.kind === 'empty' ? ' editor-zone--empty' : ''}`}
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          setSelected(z.id);
                          startDrag(e, z, 'move');
                        }}
                        role="button"
                        aria-label={z.name}
                        aria-pressed={z.id === selected}
                      >
                        <span className="editor-zone__label">{z.name || t('studio.untitledZone')}</span>
                        {z.id === selected && !readOnly
                          ? HANDLES.map((h) => (
                              <span key={h} className={`editor-zone__handle editor-zone__handle--${h}`} onPointerDown={(e) => startDrag(e, z, h)} />
                            ))
                          : null}
                      </div>
                    </>
                  )}
                />
              </RenderLibraryProvider>
            </div>
          </div>
          <p className="wxp-muted studio__hint">{t('studio.canvasHint', { w: draft.canvas.width, h: draft.canvas.height })}</p>
        </div>

        <aside className="studio__panel studio__panel--right" aria-label={t('studio.properties')}>
          {zone ? (
            <ZoneInspector
              key={zone.id}
              zone={zone}
              media={media.data}
              playlists={playlists.data}
              timezone={org?.timezone ?? 'Asia/Kolkata'}
              readOnly={readOnly}
              sensors={channelChoices}
              dataSources={dataSourceChoices}
              autoPickMedia={pickFor === zone.id}
              onChange={(z) => updateZone(z)}
              onRemove={() => removeZone(zone.id)}
              onDuplicate={() => duplicateZone(zone)}
              onLayer={(d) => layer(zone, d)}
            />
          ) : (
            <div className="inspector">
              <div className="studio__panel-title">{t('studio.canvas')}</div>
              <dl className="wxp-dl">
                <dt>{t('studio.resolution')}</dt>
                <dd className="wxp-tabular">
                  {draft.canvas.width}×{draft.canvas.height}
                </dd>
                <dt>{t('studio.orientation')}</dt>
                <dd>{t(`studio.orientations.${draft.canvas.orientation}`)}</dd>
              </dl>
              {!readOnly ? (
                <>
                  <label className="wxp-field">
                    <span className="wxp-field__label">{t('studio.background')}</span>
                    <input
                      type="color"
                      className="color-input"
                      value={draft.canvas.background}
                      onChange={(e) => {
                        const background = e.target.value.toUpperCase();
                        commit((d) => ({ ...d, canvas: { ...d.canvas, background } }));
                      }}
                    />
                  </label>
                  <label className="wxp-field">
                    <span className="wxp-field__label">{t('studio.changeResolution')}</span>
                    <select
                      className="wxp-input"
                      value=""
                      onChange={(e) => {
                        const p = RESOLUTION_PRESETS.find((x) => x.id === e.target.value);
                        if (!p) return;
                        commit((d) => {
                          const portrait = d.canvas.orientation === 'portrait';
                          return {
                            ...d,
                            canvas: { ...d.canvas, width: portrait ? p.height : p.width, height: portrait ? p.width : p.height },
                          };
                        });
                      }}
                    >
                      <option value="">{t('studio.choose')}</option>
                      {RESOLUTION_PRESETS.map((p) => (
                        <option key={p.id} value={p.id}>
                          {t(`studio.presets.${p.id}`, { w: p.width, h: p.height })}
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              ) : null}
              <p className="wxp-muted">{t('studio.selectHint')}</p>
            </div>
          )}
        </aside>
      </div>

      {preview ? <PreviewOverlay library={library} layout={draft} onClose={() => setPreview(false)} /> : null}
    </div>
  );
}
