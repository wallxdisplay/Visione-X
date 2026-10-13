/**
 * Time-series chart (line or bar) in plain SVG. Used by the signage chart widget (static,
 * sized to its zone) and the Sensors pages (interactive: crosshair + tooltip).
 * Marks follow the data-viz spec: 2px lines, ≥8px end dots with a surface ring, bars ≤24px
 * with 4px rounded tops and a 2px gap, hairline recessive grid, text in text colours only.
 */
import { formatLiveValue } from '@wallx-play/layout-spec';
import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';

export interface Series {
  key: string;
  label: string;
  color: string;
  points: Array<[number, number]>;
}

/** Categorical slots 1–3 (validated for colour-vision deficiency in both modes). */
export const SERIES_COLORS = {
  light: ['#2a78d6', '#eb6834', '#1baf7a'],
  dark: ['#3987e5', '#d95926', '#199e70'],
} as const;

function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const r = entry!.contentRect;
      setSize({ width: Math.round(r.width), height: Math.round(r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

/** 3–5 round tick values covering [min, max]. */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const start = Math.floor(min / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= max + step * 0.001; v += step) ticks.push(Number(v.toFixed(10)));
  if (ticks[ticks.length - 1]! < max) ticks.push(Number((start + ticks.length * step).toFixed(10)));
  return ticks;
}

const timeFmt = new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit' });

/** Splits a series where readings stop for a while, so a gap is drawn instead of a bridge. */
function segments(points: Array<[number, number]>): Array<Array<[number, number]>> {
  if (points.length < 2) return [points];
  const gaps = points.slice(1).map((p, i) => p[0] - points[i]![0]).sort((a, b) => a - b);
  const typical = gaps[Math.floor(gaps.length / 2)]!;
  const out: Array<Array<[number, number]>> = [[points[0]!]];
  for (let i = 1; i < points.length; i++) {
    if (points[i]![0] - points[i - 1]![0] > Math.max(typical * 4, 60_000)) out.push([]);
    out[out.length - 1]!.push(points[i]!);
  }
  return out;
}

/** Averages points into `bins` equal time slots across [from, to]. */
function binned(points: Array<[number, number]>, from: number, to: number, bins: number): Array<number | null> {
  const sums = Array.from({ length: bins }, () => ({ s: 0, n: 0 }));
  for (const [t, v] of points) {
    const i = Math.min(bins - 1, Math.max(0, Math.floor(((t - from) / (to - from)) * bins)));
    sums[i]!.s += v;
    sums[i]!.n += 1;
  }
  return sums.map(({ s, n }) => (n ? s / n : null));
}

export function SeriesChart({
  series,
  kind,
  from,
  to,
  unit = '',
  decimals,
  textColor,
  mutedColor,
  gridColor,
  surfaceColor,
  fontPx: fixedFontPx = 12,
  fontScale,
  interactive = false,
  emptyLabel,
}: {
  series: Series[];
  kind: 'line' | 'bar';
  from: number;
  to: number;
  unit?: string;
  decimals?: number;
  textColor: string;
  mutedColor: string;
  gridColor: string;
  surfaceColor: string;
  fontPx?: number;
  /** Signage: text size as a fraction of the chart height (overrides fontPx). */
  fontScale?: number;
  interactive?: boolean;
  emptyLabel: string;
}) {
  const [ref, { width, height }] = useSize<HTMLDivElement>();
  const [hoverX, setHoverX] = useState<number | null>(null);
  // Signage scales text and strokes with the zone so they stay legible on large walls.
  const fontPx = fontScale ? Math.max(9, Math.round(height * fontScale)) : fixedFontPx;
  const stroke = fontScale ? Math.max(2, Math.round(fontPx / 6)) : 2;
  const all = series.flatMap((s) => s.points.map((p) => p[1]));
  const showLegend = series.length > 1;
  const legendH = showLegend ? fontPx * 1.8 : 0;

  const ticks = useMemo(() => (all.length ? niceTicks(Math.min(...all), Math.max(...all)) : []), [all.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  const fmt = (v: number) => formatLiveValue(v, decimals);
  const tickW = Math.max(...ticks.map((t) => fmt(t).length), 1) * fontPx * 0.62;
  const pad = { left: tickW + fontPx * 0.8, right: fontPx * 0.8, top: fontPx * 0.8 + legendH, bottom: fontPx * 2 };
  const plotW = Math.max(1, width - pad.left - pad.right);
  const plotH = Math.max(1, height - pad.top - pad.bottom);
  const yMin = ticks[0] ?? 0;
  const yMax = ticks[ticks.length - 1] ?? 1;
  const x = (t: number) => pad.left + ((t - from) / (to - from)) * plotW;
  const y = (v: number) => pad.top + plotH - ((v - yMin) / (yMax - yMin || 1)) * plotH;

  // Hover: the crosshair snaps to the nearest reading time of any series.
  const times = useMemo(() => [...new Set(series.flatMap((s) => s.points.map((p) => p[0])))].sort((a, b) => a - b), [series]);
  const hoverT = hoverX === null || times.length === 0 ? null : times.reduce((best, t) => (Math.abs(x(t) - hoverX) < Math.abs(x(best) - hoverX) ? t : best), times[0]!);
  const nearest = (s: Series, t: number) =>
    s.points.reduce<[number, number] | null>((best, p) => (!best || Math.abs(p[0] - t) < Math.abs(best[0] - t) ? p : best), null);

  function onMove(e: PointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    setHoverX(e.clientX - rect.left);
  }

  const bins = Math.max(4, Math.min(24, Math.floor(plotW / 28)));
  const barGroupW = plotW / bins;
  const barW = Math.min(24, (barGroupW - 4 - 2 * (series.length - 1)) / series.length);

  return (
    <div ref={ref} className="series-chart" style={{ position: 'relative', width: '100%', height: '100%', fontSize: fontPx }}>
      {width > 0 && height > 0 ? (
        all.length === 0 ? (
          <div className="series-chart__empty" style={{ color: mutedColor }}>
            {emptyLabel}
          </div>
        ) : (
          <svg
            width={width}
            height={height}
            role="img"
            aria-label={series.map((s) => s.label).join(', ')}
            onPointerMove={interactive ? onMove : undefined}
            onPointerLeave={interactive ? () => setHoverX(null) : undefined}
          >
            {showLegend ? (
              <g>
                {series.map((s, i) => {
                  const lx = pad.left + i * Math.max(plotW / series.length, 0);
                  return (
                    <g key={s.key} transform={`translate(${lx},${fontPx * 0.9})`}>
                      <line x1={0} x2={fontPx} y1={0} y2={0} stroke={s.color} strokeWidth={2} strokeLinecap="round" />
                      <text x={fontPx * 1.4} y={fontPx * 0.35} fill={textColor}>
                        {s.label}
                      </text>
                    </g>
                  );
                })}
              </g>
            ) : null}
            {ticks.map((t) => (
              <g key={t}>
                <line x1={pad.left} x2={pad.left + plotW} y1={y(t)} y2={y(t)} stroke={gridColor} strokeWidth={1} />
                <text x={pad.left - fontPx * 0.5} y={y(t) + fontPx * 0.35} textAnchor="end" fill={mutedColor} className="wxp-tabular">
                  {fmt(t)}
                </text>
              </g>
            ))}
            {[from, (from + to) / 2, to].map((t, i) => (
              <text
                key={i}
                x={x(t)}
                y={height - fontPx * 0.6}
                textAnchor={i === 0 ? 'start' : i === 2 ? 'end' : 'middle'}
                fill={mutedColor}
                className="wxp-tabular"
              >
                {timeFmt.format(t)}
              </text>
            ))}

            {kind === 'line'
              ? series.map((s) => {
                  const last = s.points[s.points.length - 1];
                  return (
                    <g key={s.key}>
                      {series.length === 1 && s.points.length > 1 ? (
                        <path
                          d={`M${x(s.points[0]![0])},${pad.top + plotH} ${s.points.map(([t, v]) => `L${x(t)},${y(v)}`).join(' ')} L${x(last![0])},${pad.top + plotH} Z`}
                          fill={s.color}
                          opacity={0.1}
                        />
                      ) : null}
                      {segments(s.points).map((seg, i) => (
                        <path
                          key={i}
                          d={seg.map(([t, v], j) => `${j ? 'L' : 'M'}${x(t)},${y(v)}`).join(' ')}
                          fill="none"
                          stroke={s.color}
                          strokeWidth={stroke}
                          strokeLinejoin="round"
                          strokeLinecap="round"
                        />
                      ))}
                      {last ? <circle cx={x(last[0])} cy={y(last[1])} r={Math.max(4, stroke * 2)} fill={s.color} stroke={surfaceColor} strokeWidth={2} /> : null}
                    </g>
                  );
                })
              : series.map((s, si) =>
                  binned(s.points, from, to, bins).map((v, b) => {
                    if (v === null) return null;
                    const bx = pad.left + b * barGroupW + (barGroupW - (barW * series.length + 2 * (series.length - 1))) / 2 + si * (barW + 2);
                    // Bars grow from zero when it is on the axis, else from the axis floor.
                    const base = y(Math.min(Math.max(0, yMin), yMax));
                    const top = y(v);
                    const h = Math.max(1, Math.abs(base - top));
                    const r = Math.min(4, barW / 2, h);
                    const up = top <= base;
                    const y0 = up ? top : base;
                    // Rounded data end, square at the baseline.
                    const d = up
                      ? `M${bx},${y0 + h} V${y0 + r} Q${bx},${y0} ${bx + r},${y0} H${bx + barW - r} Q${bx + barW},${y0} ${bx + barW},${y0 + r} V${y0 + h} Z`
                      : `M${bx},${y0} V${y0 + h - r} Q${bx},${y0 + h} ${bx + r},${y0 + h} H${bx + barW - r} Q${bx + barW},${y0 + h} ${bx + barW},${y0 + h - r} V${y0} Z`;
                    return <path key={`${s.key}-${b}`} d={d} fill={s.color} />;
                  }),
                )}

            {interactive && hoverT !== null ? (
              <g pointerEvents="none">
                <line x1={x(hoverT)} x2={x(hoverT)} y1={pad.top} y2={pad.top + plotH} stroke={mutedColor} strokeWidth={1} />
                {series.map((s) => {
                  const p = nearest(s, hoverT);
                  return p ? <circle key={s.key} cx={x(p[0])} cy={y(p[1])} r={4} fill={s.color} stroke={surfaceColor} strokeWidth={2} /> : null;
                })}
              </g>
            ) : null}
          </svg>
        )
      ) : null}
      {interactive && hoverT !== null ? (
        <div
          className="series-chart__tip"
          style={{ left: Math.min(Math.max(x(hoverT) + 12, 0), Math.max(0, width - 170)), top: pad.top }}
          role="status"
        >
          <div className="series-chart__tip-time">{timeFmt.format(hoverT)}</div>
          {series.map((s) => {
            const p = nearest(s, hoverT);
            return p ? (
              <div key={s.key} className="series-chart__tip-row">
                <span className="series-chart__key" style={{ background: s.color }} aria-hidden />
                <strong className="wxp-tabular">
                  {fmt(p[1])}
                  {unit ? ` ${unit}` : ''}
                </strong>
                {series.length > 1 ? <span>{s.label}</span> : null}
              </div>
            ) : null;
          })}
        </div>
      ) : null}
    </div>
  );
}
