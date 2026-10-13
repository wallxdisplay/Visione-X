/**
 * Weather and RSS widgets for the web renderer (Studio preview). The Android player draws the
 * same widgets natively (ui/DataWidgets.kt) from /devices/data. Sizes are fractions of the
 * zone (cqh/cqw).
 */
import { weatherCondition, weatherIcon, type Widget } from '@wallx-play/layout-spec';
import { useEffect, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { useDataSourceValue } from '../content/dataSources';

type W<T extends Widget['type']> = Extract<Widget, { type: T }>;

const base = (style: { color?: string; background?: string } | undefined): CSSProperties => ({
  color: style?.color ?? '#FFFFFF',
  background: style?.background ?? 'transparent',
});

const round = (c: number) => `${Math.round(c)}°`;

function Placeholder({ text, style }: { text: string; style: CSSProperties }) {
  return (
    <div className="r-fill r-sensor" style={style}>
      <span className="r-sensor__nodata">{text}</span>
    </div>
  );
}

export function WeatherView({ widget, orgId }: { widget: W<'weather'>; orgId?: string }) {
  const { t } = useTranslation();
  const { value } = useDataSourceValue(orgId, widget.dataSourceId);
  const style = base(widget.style);
  if (value === undefined) return <Placeholder text="…" style={style} />;
  const w = value?.weather;
  if (!w) return <Placeholder text={value?.error ?? t('render.data.nodata')} style={style} />;
  const cond = weatherCondition(w.current.code);
  const forecast = widget.layout === 'forecast';
  const weekday = (date: string) => new Intl.DateTimeFormat('en-IN', { weekday: 'short', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));
  return (
    <div className={`r-fill r-weather${forecast ? ' r-weather--forecast' : ''}`} style={style}>
      <div className="r-weather__now">
        <span className="r-weather__icon" aria-hidden>
          {weatherIcon(cond, w.current.isDay)}
        </span>
        <div className="r-weather__main">
          <div className="r-weather__place">{value!.name}</div>
          <div className="r-weather__temp wxp-tabular">{round(w.current.tempC)}</div>
          <div className="r-weather__cond">
            {t(`render.weather.${cond}`)}
            {w.current.feelsLikeC !== null ? ` · ${t('render.weather.feels', { t: round(w.current.feelsLikeC) })}` : ''}
          </div>
        </div>
      </div>
      {forecast ? (
        <div className="r-weather__days">
          {w.daily.slice(1, 4).map((d) => (
            <div key={d.date} className="r-weather__day">
              <span>{weekday(d.date)}</span>
              <span aria-hidden>{weatherIcon(weatherCondition(d.code))}</span>
              <span className="wxp-tabular">
                {round(d.maxC)} <span className="r-weather__min">{round(d.minC)}</span>
              </span>
            </div>
          ))}
        </div>
      ) : null}
      {!value!.ok ? <div className="r-sensor__note">{t('render.data.stale')}</div> : null}
    </div>
  );
}

export function RssView({ widget, orgId }: { widget: W<'rss'>; orgId?: string }) {
  const { t } = useTranslation();
  const { value } = useDataSourceValue(orgId, widget.dataSourceId);
  const [index, setIndex] = useState(0);
  const items = value?.rss?.items ?? [];
  useEffect(() => {
    if (items.length < 2) return;
    const id = setInterval(() => setIndex((i) => (i + 1) % items.length), widget.itemDurationSec * 1000);
    return () => clearInterval(id);
  }, [items.length, widget.itemDurationSec]);
  const style = base(widget.style);
  if (value === undefined) return <Placeholder text="…" style={style} />;
  if (!items.length) return <Placeholder text={value?.error ?? t('render.data.nodata')} style={style} />;
  const item = items[index % items.length]!;
  return (
    <div className="r-fill r-rss" style={style}>
      {widget.showFeedTitle && value!.rss!.feedTitle ? <div className="r-rss__feed">{value!.rss!.feedTitle}</div> : null}
      <div key={index} className="r-rss__title r-transition-fade" style={{ fontSize: `min(${(widget.style?.fontScale ?? 0.14) * 100}cqh, 7cqw)`, fontWeight: widget.style?.bold ? 700 : 600 }}>
        {item.title}
      </div>
    </div>
  );
}
