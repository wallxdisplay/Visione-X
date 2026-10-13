/**
 * Sensor widgets for the web renderer (Studio preview). The Android player draws the same
 * widgets natively (ui/SensorWidgets.kt) with the rules in @wallx-play/layout-spec/live.
 * Sizes are fractions of the zone (cqh/cqw), like the other widgets.
 */
import {
  formatLiveValue,
  gaugeFraction,
  liveState,
  statusMatches,
  thresholdColor,
  type DataBinding,
  type LiveState,
  type Threshold,
  type Widget,
} from '@wallx-play/layout-spec';
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { paths, type SensorChannelDoc } from '@wallx-play/shared';
import { useLiveValue, useReadings } from '../content/sensors';
import { useDoc } from '../lib/hooks';
import { SERIES_COLORS, SeriesChart } from './SeriesChart';

type W<T extends Widget['type']> = Extract<Widget, { type: T }>;

/** Black or white text, whichever reads better on `hex`. */
export function inkFor(hex: string): string {
  const n = parseInt(hex.slice(1, 7), 16);
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const l = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return l > 0.4 ? '#0B1020' : '#FFFFFF';
}

function useNow(ms: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

function useLive(orgId: string | undefined, binding: DataBinding) {
  const value = useLiveValue(orgId, binding);
  const now = useNow(15_000);
  return { value, state: value === undefined ? ('loading' as const) : liveState(value, now, binding.staleAfterSec) };
}

const base = (style: { color?: string; background?: string } | undefined): CSSProperties => ({
  color: style?.color ?? '#FFFFFF',
  background: style?.background ?? 'transparent',
});

/** Caption + body + a small state note for stale / offline / no data. */
function Frame({ label, state, children, style }: { label: string; state: LiveState | 'loading'; children: ReactNode; style: CSSProperties }) {
  const { t } = useTranslation();
  return (
    <div className="r-fill r-sensor" style={style}>
      {label ? <div className="r-sensor__label">{label}</div> : null}
      <div className={`r-sensor__body${state === 'stale' || state === 'offline' ? ' r-sensor__body--dim' : ''}`}>{children}</div>
      {state === 'stale' || state === 'offline' ? <div className="r-sensor__note">{t(`render.sensor.${state}`)}</div> : null}
    </div>
  );
}

function NoData({ state }: { state: LiveState | 'loading' }) {
  const { t } = useTranslation();
  return <span className="r-sensor__nodata">{state === 'loading' ? '…' : t('render.sensor.nodata')}</span>;
}

function bandOf(thresholds: readonly Threshold[], v: number) {
  const color = thresholdColor(thresholds, v);
  return color ? thresholds.find((t) => t.color === color) : undefined;
}

export function SensorValueView({ widget, orgId }: { widget: W<'sensorValue'>; orgId?: string }) {
  const { value, state } = useLive(orgId, widget.binding);
  const v = value?.value;
  const band = v != null ? bandOf(widget.thresholds, v) : undefined;
  const scale = widget.style?.fontScale ?? 0.4;
  return (
    <Frame label={widget.label} state={state} style={base(widget.style)}>
      {v == null ? (
        <NoData state={state} />
      ) : (
        <>
          <span className="r-sensor__value wxp-tabular" style={{ fontSize: `min(${scale * 100}cqh, 22cqw)`, color: band?.color }}>
            {formatLiveValue(v, widget.binding.decimals)}
            {widget.unit ? <span className="r-sensor__unit">{widget.unit}</span> : null}
          </span>
          {band?.label ? (
            <span className="r-sensor__band" style={{ background: band.color, color: inkFor(band.color) }}>
              {band.label}
            </span>
          ) : null}
        </>
      )}
    </Frame>
  );
}

export function GaugeView({ widget, orgId }: { widget: W<'gauge'>; orgId?: string }) {
  const { value, state } = useLive(orgId, widget.binding);
  const v = value?.value;
  const color = (v != null && thresholdColor(widget.thresholds, v)) || SERIES_COLORS.dark[0];
  const f = v != null ? gaugeFraction(v, widget.min, widget.max) : 0;
  // Semicircle from 180° to 0°, radius 40 in a 100×56 box.
  const arc = (from: number, to: number) => {
    const p = (fr: number) => [50 - 40 * Math.cos(Math.PI * fr), 50 - 40 * Math.sin(Math.PI * fr)];
    const [x0, y0] = p(from);
    const [x1, y1] = p(to);
    return `M${x0},${y0} A40,40 0 0 1 ${x1},${y1}`;
  };
  const text = widget.style?.color ?? '#FFFFFF';
  return (
    <Frame label={widget.label} state={state} style={base(widget.style)}>
      <svg viewBox="0 0 100 60" className="r-gauge" role="img" aria-label={widget.label || widget.unit}>
        <path d={arc(0, 1)} stroke={text} strokeOpacity={0.18} strokeWidth={9} fill="none" strokeLinecap="round" />
        {v != null && f > 0 ? <path d={arc(0, f)} stroke={color} strokeWidth={9} fill="none" strokeLinecap="round" /> : null}
        <text x={50} y={47} textAnchor="middle" fill={text} fontSize={v == null ? 8 : 15} fontWeight={700} className="wxp-tabular">
          {v == null ? '—' : formatLiveValue(v, widget.binding.decimals)}
          {v != null && widget.unit ? <tspan fontSize={7} fontWeight={500}>{` ${widget.unit}`}</tspan> : null}
        </text>
        <text x={10} y={58} textAnchor="middle" fill={text} fillOpacity={0.7} fontSize={6} className="wxp-tabular">
          {formatLiveValue(widget.min)}
        </text>
        <text x={90} y={58} textAnchor="middle" fill={text} fillOpacity={0.7} fontSize={6} className="wxp-tabular">
          {formatLiveValue(widget.max)}
        </text>
      </svg>
      {v == null && state !== 'loading' ? <NoData state={state} /> : null}
    </Frame>
  );
}

export function StatusView({ widget, orgId }: { widget: W<'status'>; orgId?: string }) {
  const { value, state } = useLive(orgId, widget.binding);
  const v = value?.value;
  const match = v != null ? widget.states.find((s) => statusMatches(s.match, v)) : undefined;
  const bg = match?.color ?? widget.style?.background ?? '#1F2937';
  const scale = widget.style?.fontScale ?? 0.3;
  return (
    <Frame label={widget.label} state={state} style={{ background: bg, color: inkFor(bg) }}>
      {v == null ? (
        <NoData state={state} />
      ) : (
        <span className="r-sensor__status" style={{ fontSize: `${scale * 100}cqh` }}>
          {match?.label ?? formatLiveValue(v, widget.binding.decimals)}
        </span>
      )}
    </Frame>
  );
}

/** `#RRGGBB` (or `#RRGGBBAA`) at a given opacity. */
const alpha = (hex: string, a: number) =>
  hex.slice(0, 7) + Math.round(a * 255).toString(16).padStart(2, '0');

/** One chart series: a channel's readings and its name (for the legend). */
function useSeries(orgId: string | undefined, binding: DataBinding | undefined, minutes: number) {
  const points = useReadings(orgId, binding?.sourceId, binding?.field, minutes).points;
  const channel = useDoc<SensorChannelDoc>(binding && orgId ? paths.sensorChannel(orgId, binding.sourceId, binding.field) : null);
  return { points, name: channel.data?.name ?? binding?.field ?? '' };
}

export function ChartView({ widget, orgId }: { widget: W<'chart'>; orgId?: string }) {
  const { t } = useTranslation();
  const now = useNow(60_000);
  // Bindings are capped at 3 by the schema, so the hook calls are stable.
  const series = [
    useSeries(orgId, widget.bindings[0], widget.windowMinutes),
    useSeries(orgId, widget.bindings[1], widget.windowMinutes),
    useSeries(orgId, widget.bindings[2], widget.windowMinutes),
  ];
  const text = widget.style?.color ?? '#FFFFFF';
  return (
    <div className="r-fill r-sensor r-sensor--chart" style={base(widget.style)}>
      {widget.label ? <div className="r-sensor__label">{widget.label}</div> : null}
      <div className="r-sensor__chart">
        <SeriesChart
          series={widget.bindings.map((bd, i) => ({
            key: `${bd.sourceId}/${bd.field}`,
            label: series[i]!.name,
            color: SERIES_COLORS.dark[i]!,
            points: series[i]!.points,
          }))}
          kind={widget.kind}
          from={now - widget.windowMinutes * 60_000}
          to={now}
          decimals={widget.bindings[0]!.decimals}
          textColor={text}
          mutedColor={alpha(text, 0.7)}
          gridColor={alpha(text, 0.15)}
          surfaceColor={widget.style?.background ?? '#000000'}
          fontScale={0.055}
          emptyLabel={t('render.sensor.nodata')}
        />
      </div>
    </div>
  );
}
