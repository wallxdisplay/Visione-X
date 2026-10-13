/**
 * Web renderer for the layout spec, used by Layout Studio, previews and the playlist player.
 * The Android player implements the same spec natively; keep behaviour aligned
 * (fractions of the canvas for geometry, font sizes as a fraction of the zone height).
 */
import type { Layout, LayoutBody, PlaylistItem, Widget, ZoneContent } from '@wallx-play/layout-spec';
import type { LayoutDoc, MediaDoc, PlaylistDoc } from '@wallx-play/shared';
import { Music } from 'lucide-react';
import QRCode from 'qrcode';
import { createContext, useContext, useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useStorageUrl } from '../content/data';
import { ChartView, GaugeView, LiveCell, SensorValueView, StatusView } from './SensorWidgets';
import { RssView, WeatherView } from './DataWidgets';
import './render.css';

export interface RenderLibrary {
  media: Map<string, MediaDoc>;
  playlists: Map<string, PlaylistDoc>;
  layouts: Map<string, LayoutDoc>;
  /** Org whose live sensor values sensor widgets show (absent = no live data). */
  orgId?: string;
}

const LibraryContext = createContext<RenderLibrary>({ media: new Map(), playlists: new Map(), layouts: new Map() });

export function RenderLibraryProvider({ value, children }: { value: RenderLibrary; children: ReactNode }) {
  return <LibraryContext.Provider value={value}>{children}</LibraryContext.Provider>;
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/**
 * Font size is a fraction of the zone height (`fontScale`). Single-line widgets (clocks) are
 * also capped by the zone width so they never overflow: min(scale·h, w / (0.62·chars)).
 * Zones are CSS size containers, so cqh/cqw refer to the zone itself. The Android player
 * applies the same formula.
 */
function textStyle(
  style: { color?: string; background?: string; align?: string; bold?: boolean; fontScale?: number } | undefined,
  defaultScale: number,
  singleLineChars?: number,
): CSSProperties {
  const byHeight = `${(style?.fontScale ?? defaultScale) * 100}cqh`;
  return {
    color: style?.color ?? '#FFFFFF',
    background: style?.background ?? 'transparent',
    justifyContent: style?.align === 'start' ? 'flex-start' : style?.align === 'end' ? 'flex-end' : 'center',
    textAlign: style?.align === 'start' ? 'left' : style?.align === 'end' ? 'right' : 'center',
    fontWeight: style?.bold ? 700 : 500,
    fontSize: singleLineChars ? `min(${byHeight}, ${(100 / (0.62 * singleLineChars)).toFixed(2)}cqw)` : byHeight,
    whiteSpace: singleLineChars ? 'nowrap' : undefined,
  };
}

function QrView({ widget }: { widget: Extract<Widget, { type: 'qr' }> }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(widget.value, {
      margin: 1,
      width: 512,
      color: { dark: widget.foreground ?? '#000000', light: widget.background ?? '#FFFFFF' },
    })
      .then((url) => alive && setSrc(url))
      .catch(() => alive && setSrc(null));
    return () => {
      alive = false;
    };
  }, [widget.value, widget.foreground, widget.background]);
  return (
    <div className="r-fill r-center" style={{ background: widget.background ?? '#FFFFFF' }}>
      {src ? <img src={src} alt="" className="r-contain" /> : null}
    </div>
  );
}

function ClockView({ widget }: { widget: Extract<Widget, { type: 'clock' }> }) {
  const now = useNow(widget.seconds ? 1000 : 10_000);
  let text = '';
  try {
    const opts: Intl.DateTimeFormatOptions = { timeZone: widget.timezone };
    if (widget.format !== 'date') Object.assign(opts, { hour: '2-digit', minute: '2-digit', ...(widget.seconds ? { second: '2-digit' } : {}) });
    if (widget.format !== 'time') Object.assign(opts, { weekday: 'short', day: 'numeric', month: 'short' });
    text = new Intl.DateTimeFormat('en-IN', opts).format(now);
  } catch {
    text = '—';
  }
  return (
    <div className="r-fill r-text" style={textStyle(widget.style, 0.45, Math.max(4, text.length))}>
      <span className="wxp-tabular">{text}</span>
    </div>
  );
}

export function WidgetView({ widget }: { widget: Widget }) {
  const { t } = useTranslation();
  const { orgId } = useContext(LibraryContext);
  switch (widget.type) {
    case 'sensorValue':
      return <SensorValueView widget={widget} orgId={orgId} />;
    case 'gauge':
      return <GaugeView widget={widget} orgId={orgId} />;
    case 'chart':
      return <ChartView widget={widget} orgId={orgId} />;
    case 'status':
      return <StatusView widget={widget} orgId={orgId} />;
    case 'weather':
      return <WeatherView widget={widget} orgId={orgId} />;
    case 'rss':
      return <RssView widget={widget} orgId={orgId} />;
    case 'text':
      return (
        <div className="r-fill r-text" style={textStyle(widget.style, 0.4)}>
          <span className="r-pre">{widget.text}</span>
        </div>
      );
    case 'clock':
      return <ClockView widget={widget} />;
    case 'qr':
      return <QrView widget={widget} />;
    case 'table': {
      const style = textStyle(widget.style, 0.06);
      return (
        <div className="r-fill" style={{ background: style.background, color: style.color, fontSize: style.fontSize }}>
          <table className="r-table">
            <thead>
              <tr>
                {widget.columns.map((c, i) => (
                  <th key={i}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {widget.rows.map((row, r) => (
                <tr key={r}>
                  {widget.columns.map((_, c) => {
                    const cell = row.cells[c];
                    return <td key={c}>{typeof cell === 'string' ? cell : cell ? <LiveCell binding={cell} orgId={orgId} /> : ''}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    case 'web':
      return (
        <iframe
          className="r-fill r-iframe"
          src={widget.url}
          title={widget.url}
          sandbox="allow-scripts allow-same-origin"
          referrerPolicy="no-referrer"
          loading="lazy"
        />
      );
    default:
      return <div className="r-fill r-center r-placeholder">{t('render.laterWidget', { type: (widget as { type: string }).type })}</div>;
  }
}

export function MediaView({
  mediaId,
  fit = 'contain',
  muted = true,
}: {
  mediaId: string;
  fit?: 'contain' | 'cover' | 'fill';
  muted?: boolean;
}) {
  const { t } = useTranslation();
  const media = useContext(LibraryContext).media.get(mediaId);
  const ready = media?.status === 'ready';
  const url = useStorageUrl(ready ? (media.display?.path ?? media.originalPath) : (media?.thumb?.path ?? null));
  if (!media) return <div className="r-fill r-center r-placeholder">{t('render.missingMedia')}</div>;
  if (!ready) return <div className="r-fill r-center r-placeholder">{t(`library.status.${media.status}`)}</div>;
  if (!url) return <div className="r-fill" />;
  if (media.type === 'image') return <img src={url} alt="" className="r-fill" style={{ objectFit: fit }} />;
  if (media.type === 'video') {
    return <video src={url} className="r-fill" style={{ objectFit: fit }} autoPlay loop muted={muted} playsInline />;
  }
  return (
    <div className="r-fill r-center r-placeholder">
      <Music size={32} aria-hidden /> {media.name}
    </div>
  );
}

/** Cycles through playlist items using their durations. */
export function PlaylistPlayer({ items, paused = false }: { items: PlaylistItem[]; paused?: boolean }) {
  const { t } = useTranslation();
  const [index, setIndex] = useState(0);
  const item = items.length ? items[index % items.length] : undefined;

  useEffect(() => {
    if (!item || paused || items.length < 2) return;
    const id = setTimeout(() => setIndex((i) => (i + 1) % items.length), item.durationSec * 1000);
    return () => clearTimeout(id);
  }, [item, paused, items.length, index]);

  if (!item) return <div className="r-fill r-center r-placeholder">{t('render.emptyPlaylist')}</div>;
  return (
    <div key={`${item.id}-${index}`} className={`r-fill r-transition-${item.transition}`}>
      <ItemView content={item.content} />
    </div>
  );
}

function ItemView({ content }: { content: PlaylistItem['content'] }) {
  const lib = useContext(LibraryContext);
  if (content.kind === 'media') return <MediaView mediaId={content.mediaId} />;
  if (content.kind === 'widget') return <WidgetView widget={content.widget} />;
  const layout = lib.layouts.get(content.layoutId);
  return layout ? <LayoutView layout={layout} fill /> : <div className="r-fill r-center r-placeholder">—</div>;
}

export function ZoneContentView({ content }: { content: ZoneContent }) {
  const { t } = useTranslation();
  const lib = useContext(LibraryContext);
  switch (content.kind) {
    case 'empty':
      return null;
    case 'media':
      return <MediaView mediaId={content.mediaId} fit={content.fit} />;
    case 'widget':
      return <WidgetView widget={content.widget} />;
    case 'playlist': {
      const playlist = lib.playlists.get(content.playlistId);
      return playlist ? (
        <PlaylistPlayer items={playlist.items} />
      ) : (
        <div className="r-fill r-center r-placeholder">{t('render.missingPlaylist')}</div>
      );
    }
  }
}

/**
 * Renders a layout. With `width` the canvas is drawn at that pixel width; with `fill` it fills
 * its parent (which must have the canvas aspect ratio).
 */
export function LayoutView({
  layout,
  width,
  fill,
  renderZone,
}: {
  layout: Pick<Layout | LayoutBody, 'canvas' | 'zones'>;
  width?: number;
  fill?: boolean;
  /** Editor hook: wrap each zone (selection outlines, handles). */
  renderZone?: (zone: LayoutBody['zones'][number], content: ReactNode) => ReactNode;
}) {
  const style: CSSProperties = fill
    ? { position: 'absolute', inset: 0 }
    : { width: width ?? '100%', aspectRatio: `${layout.canvas.width} / ${layout.canvas.height}` };

  const zones = [...layout.zones].sort((a, b) => a.z - b.z);
  return (
    <div className="r-canvas" style={{ ...style, background: layout.canvas.background }}>
      {zones.map((zone) => {
        const content = <ZoneContentView content={zone.content} />;
        const zoneStyle: CSSProperties = {
          left: `${zone.x * 100}%`,
          top: `${zone.y * 100}%`,
          width: `${zone.w * 100}%`,
          height: `${zone.h * 100}%`,
          zIndex: zone.z,
        };
        return (
          <div key={zone.id} className="r-zone" style={zoneStyle}>
            {renderZone ? renderZone(zone, content) : content}
          </div>
        );
      })}
    </div>
  );
}
