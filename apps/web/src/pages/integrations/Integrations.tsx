import { Alert, Button, Dialog, EmptyState, PageHeader, StatusChip, TextField } from '@wallx-play/ui';
import { weatherCondition, weatherIcon } from '@wallx-play/layout-spec';
import { RSS_MAX_ITEMS, type DataSourceDoc, type GeocodeResult, type RssData } from '@wallx-play/shared';
import { CloudSun, Plug, Rss, Wind } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDataSources, useDataSourceValue } from '../../content/dataSources';
import { call, errorMessage } from '../../lib/api';
import { formatDate, formatDateTime } from '../../lib/format';
import type { WithId } from '../../lib/hooks';
import { useOrg } from '../../org/OrgProvider';
import './integrations.css';
import { FeatureLocked } from '../../content/apps';

type Editing = { kind: DataSourceDoc['type']; source: DataSourceDoc | null } | null;

/** Weather and air quality places, and RSS feeds, that widgets can show. */
export function Integrations() {
  const { t } = useTranslation();
  const { orgId, can, entitlements } = useOrg();
  const weatherOn = !!entitlements?.features.includes('widget.weather');
  const rssOn = !!entitlements?.features.includes('widget.rss');
  const manage = can('integration.manage');
  const sources = useDataSources(orgId, weatherOn || rssOn);
  const [editing, setEditing] = useState<Editing>(null);
  const [previewing, setPreviewing] = useState<DataSourceDoc | null>(null);
  const [deleting, setDeleting] = useState<DataSourceDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (entitlements && !weatherOn && !rssOn) {
    return (
      <>
        <PageHeader title={t('nav.integrations')} description={t('integrations.description')} />
        <div className="wxp-card">
          <FeatureLocked feature="widget.weather" icon={<Plug size={24} aria-hidden />} title={t('integrations.notInPlanTitle')} fallback={t('integrations.notInPlanBody')} />
        </div>
      </>
    );
  }

  async function remove() {
    if (!deleting) return;
    setBusy(true);
    setError(null);
    try {
      await call('deleteDataSource', { orgId, dataSourceId: deleting.id });
      setDeleting(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title={t('nav.integrations')}
        description={t('integrations.description')}
        actions={
          manage ? (
            <div className="wxp-toolbar" style={{ margin: 0 }}>
              {weatherOn ? (
                <Button onClick={() => setEditing({ kind: 'weather', source: null })}>
                  <CloudSun size={15} aria-hidden /> {t('integrations.addWeather')}
                </Button>
              ) : null}
              {weatherOn ? (
                <Button onClick={() => setEditing({ kind: 'air_quality', source: null })}>
                  <Wind size={15} aria-hidden /> {t('integrations.addAir')}
                </Button>
              ) : null}
              {rssOn ? (
                <Button onClick={() => setEditing({ kind: 'rss', source: null })}>
                  <Rss size={15} aria-hidden /> {t('integrations.addRss')}
                </Button>
              ) : null}
            </div>
          ) : null
        }
      />
      {sources.data.length === 0 && !sources.loading ? (
        <div className="wxp-card">
          <EmptyState icon={<Plug size={24} aria-hidden />} title={t('integrations.emptyTitle')} description={t('integrations.emptyBody')} />
        </div>
      ) : (
        <div className="wxp-table-wrap">
          <table className="wxp-table">
            <thead>
              <tr>
                <th>{t('integrations.name')}</th>
                <th>{t('integrations.type')}</th>
                <th>{t('integrations.details')}</th>
                <th>{t('integrations.lastUpdate')}</th>
                <th aria-label={t('common.actions')} />
              </tr>
            </thead>
            <tbody>
              {sources.data.map((s: WithId<DataSourceDoc>) => (
                <tr key={s.id}>
                  <td>{s.name}</td>
                  <td>{t(`integrations.types.${s.type}`)}</td>
                  <td className="wxp-muted integrations__details">
                    {s.type === 'rss' ? s.config.url : `${s.config.placeName} (${s.config.latitude.toFixed(2)}, ${s.config.longitude.toFixed(2)})`}
                  </td>
                  <td>
                    {s.lastFetch ? (
                      <span className="integrations__status">
                        <StatusChip tone={s.lastFetch.ok ? 'success' : 'danger'}>{s.lastFetch.ok ? t('integrations.ok') : t('integrations.failed')}</StatusChip>
                        <span className="wxp-muted">{s.lastFetch.ok ? formatDateTime(s.lastFetch.at) : s.lastFetch.error}</span>
                      </span>
                    ) : (
                      <span className="wxp-muted">{t('integrations.notYet')}</span>
                    )}
                  </td>
                  <td className="wxp-actions">
                    <Button size="sm" variant="tertiary" onClick={() => setPreviewing(s)}>
                      {t('integrations.preview')}
                    </Button>
                    {manage ? (
                      <>
                        <Button size="sm" variant="tertiary" onClick={() => setEditing({ kind: s.type, source: s })}>
                          {t('common.edit')}
                        </Button>
                        <Button size="sm" variant="tertiary" onClick={() => setDeleting(s)}>
                          {t('common.delete')}
                        </Button>
                      </>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="wxp-muted integrations__hint">{t('integrations.howTo')}</p>

      {editing?.kind === 'weather' || editing?.kind === 'air_quality' ? <PlaceDialog kind={editing.kind} source={editing.source} onClose={() => setEditing(null)} /> : null}
      {editing?.kind === 'rss' ? <RssDialog source={editing.source} onClose={() => setEditing(null)} /> : null}
      {previewing ? <PreviewDialog source={previewing} onClose={() => setPreviewing(null)} /> : null}
      <Dialog
        open={!!deleting}
        title={t('integrations.deleteTitle')}
        onClose={() => {
          setDeleting(null);
          setError(null);
        }}
        footer={
          <>
            <Button onClick={() => setDeleting(null)}>{t('common.cancel')}</Button>
            <Button variant="danger" disabled={busy} onClick={() => void remove()}>
              {t('common.delete')}
            </Button>
          </>
        }
      >
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <p>{t('integrations.deleteBody', { name: deleting?.name })}</p>
      </Dialog>
    </>
  );
}

function useSave(onClose: () => void) {
  const { orgId } = useOrg();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function save(input: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      await call('saveDataSource', { orgId, ...input });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return { error, setError, busy, setBusy, save, orgId };
}

/** A weather or air quality place, found with the place search. */
function PlaceDialog({ kind, source, onClose }: { kind: 'weather' | 'air_quality'; source: DataSourceDoc | null; onClose: () => void }) {
  const { t } = useTranslation();
  const initial = source && source.type !== 'rss' && source.type === kind ? source : null;
  const air = kind === 'air_quality';
  const { error, setError, busy, setBusy, save, orgId } = useSave(onClose);
  const [name, setName] = useState(initial?.name ?? '');
  const [query, setQuery] = useState(initial?.config.placeName ?? '');
  const [results, setResults] = useState<GeocodeResult[] | null>(null);
  const [credit, setCredit] = useState<string | null>(null);
  const [place, setPlace] = useState(initial ? initial.config : null);

  async function search() {
    setBusy(true);
    setError(null);
    try {
      const r = await call<{ results: GeocodeResult[]; attribution?: string }>('geocodePlace', { orgId, query });
      setCredit(r.attribution ?? null);
      setResults(r.results);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      title={air ? t(source ? 'integrations.editAir' : 'integrations.addAir') : t(source ? 'integrations.editWeather' : 'integrations.addWeather')}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            disabled={busy || !place || !name.trim()}
            onClick={() => place && void save({ ...(source ? { dataSourceId: source.id } : {}), name, type: kind, config: place })}
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <form
        className="integrations__search"
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <TextField label={t('integrations.searchPlace')} hint={t('integrations.searchHint')} value={query} onChange={(e) => setQuery(e.target.value)} />
        <Button type="submit" disabled={busy || query.trim().length < 2}>
          {t('integrations.search')}
        </Button>
      </form>
      {results ? (
        results.length === 0 ? (
          <p className="wxp-muted">{t('integrations.noPlaces')}</p>
        ) : (
          <ul className="choice-list" role="radiogroup" aria-label={t('integrations.places')}>
            {results.map((r) => {
              const label = [r.name, r.admin1, r.country].filter(Boolean).join(', ');
              const selected = place?.latitude === r.latitude && place.longitude === r.longitude;
              return (
                <li key={`${r.latitude},${r.longitude}`}>
                  <label className="checkbox-row">
                    <input
                      type="radio"
                      name="place"
                      checked={selected}
                      onChange={() => {
                        setPlace({ placeName: r.name, latitude: r.latitude, longitude: r.longitude });
                        if (!name.trim() || name === place?.placeName) setName(r.name);
                      }}
                    />
                    {label} <span className="wxp-muted">({r.latitude.toFixed(2)}, {r.longitude.toFixed(2)})</span>
                  </label>
                </li>
              );
            })}
          </ul>
        )
      ) : null}
      {place ? <p>{t('integrations.selectedPlace', { place: place.placeName })}</p> : null}
      <TextField label={t('integrations.name')} hint={t('integrations.nameHint')} required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
      {/* The provider's required credit ("Google Maps" is never translated). */}
      {credit ? (
        <p className="wxp-muted">
          {t(air ? 'integrations.placeSource' : 'integrations.weatherSource')} <span translate="no">{credit}</span>
        </p>
      ) : null}
    </Dialog>
  );
}

function RssDialog({ source, onClose }: { source: DataSourceDoc | null; onClose: () => void }) {
  const { t } = useTranslation();
  const initial = source?.type === 'rss' ? source : null;
  const { error, setError, busy, setBusy, save, orgId } = useSave(onClose);
  const [name, setName] = useState(initial?.name ?? '');
  const [url, setUrl] = useState(initial?.config.url ?? '');
  const [maxItems, setMaxItems] = useState(String(initial?.config.maxItems ?? 10));
  const [test, setTest] = useState<RssData | null>(null);
  const n = Number(maxItems);
  const config = { url: url.trim(), maxItems: Number.isInteger(n) ? Math.min(RSS_MAX_ITEMS, Math.max(1, n)) : 10 };

  async function runTest() {
    setBusy(true);
    setError(null);
    setTest(null);
    try {
      const r = await call<RssData>('testRssFeed', { orgId, config });
      setTest(r);
      if (!name.trim() && r.feedTitle) setName(r.feedTitle.slice(0, 80));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      title={source ? t('integrations.editRss') : t('integrations.addRss')}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={busy || !url.trim() || !name.trim()} onClick={() => void save({ ...(source ? { dataSourceId: source.id } : {}), name, type: 'rss', config })}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <TextField label={t('integrations.feedUrl')} hint={t('integrations.feedHint')} type="url" required value={url} onChange={(e) => setUrl(e.target.value)} />
      <div className="wxp-form__row">
        <TextField label={t('integrations.maxItems')} type="number" min={1} max={RSS_MAX_ITEMS} value={maxItems} onChange={(e) => setMaxItems(e.target.value)} />
        <div className="integrations__test">
          <Button disabled={busy || !url.trim()} onClick={() => void runTest()}>
            {t('integrations.test')}
          </Button>
        </div>
      </div>
      {test ? (
        <div className="wxp-card integrations__headlines">
          <strong>{test.feedTitle || t('integrations.untitledFeed')}</strong>
          <ol>
            {test.items.map((i, k) => (
              <li key={k}>{i.title}</li>
            ))}
          </ol>
        </div>
      ) : null}
      <TextField label={t('integrations.name')} required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
    </Dialog>
  );
}

function PreviewDialog({ source, onClose }: { source: DataSourceDoc; onClose: () => void }) {
  const { t } = useTranslation();
  const { orgId } = useOrg();
  const { value } = useDataSourceValue(orgId, source.id);
  const w = value?.weather;
  return (
    <Dialog open title={source.name} onClose={onClose} footer={<Button onClick={onClose}>{t('common.close')}</Button>}>
      {value === undefined ? <p className="wxp-muted">{t('common.loading')}</p> : null}
      {value && !value.ok ? <Alert tone="warning">{value.error}</Alert> : null}
      {w ? (
        <div className="integrations__weather">
          <p className="integrations__now">
            <span aria-hidden>{weatherIcon(weatherCondition(w.current.code), w.current.isDay)}</span> <strong>{Math.round(w.current.tempC)}°C</strong>{' '}
            {t(`render.weather.${weatherCondition(w.current.code)}`)}
          </p>
          <p className="wxp-muted">
            {[
              w.current.feelsLikeC !== null ? t('render.weather.feels', { t: `${Math.round(w.current.feelsLikeC)}°` }) : null,
              w.current.humidity !== null ? t('integrations.humidity', { pct: Math.round(w.current.humidity) }) : null,
              w.current.windKmh !== null ? t('integrations.wind', { kmh: Math.round(w.current.windKmh) }) : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
          <ul className="plain-list">
            {w.daily.map((d) => (
              <li key={d.date}>
                {/* Noon UTC keeps the calendar day in every Indian/Asian time zone. */}
                {formatDate(Date.parse(`${d.date}T12:00:00Z`))} {weatherIcon(weatherCondition(d.code))} {Math.round(d.maxC)}° / {Math.round(d.minC)}°
              </li>
            ))}
          </ul>
          {/* The provider's required credit ("Google Maps" is never translated). */}
          {w.attribution ? (
            <p className="wxp-muted">
              {t('integrations.weatherSource')} <span translate="no">{w.attribution}</span>
            </p>
          ) : null}
        </div>
      ) : null}
      {value?.airQuality ? (
        <div className="integrations__weather">
          <p className="integrations__now">
            {value.airQuality.index.color ? <span className="integrations__swatch" style={{ background: value.airQuality.index.color }} aria-hidden /> : null}
            <strong>{t('integrations.aqiValue', { aqi: value.airQuality.index.display })}</strong> {value.airQuality.index.category}
          </p>
          <p className="wxp-muted">
            {[value.airQuality.index.dominantPollutant ? t('render.aqi.pollutant', { p: value.airQuality.index.dominantPollutant }) : null, value.airQuality.index.name]
              .filter(Boolean)
              .join(' · ')}
          </p>
          {value.airQuality.attribution ? (
            <p className="wxp-muted">
              {t('integrations.airSource')} <span translate="no">{value.airQuality.attribution}</span>
            </p>
          ) : null}
        </div>
      ) : null}
      {value?.rss ? (
        <ol>
          {value.rss.items.map((i, k) => (
            <li key={k}>
              {i.title} {i.publishedAt ? <span className="wxp-muted">· {formatDateTime(i.publishedAt)}</span> : null}
            </li>
          ))}
        </ol>
      ) : null}
      {value?.fetchedAt ? <p className="wxp-muted">{t('integrations.fetchedAt', { at: formatDateTime(value.fetchedAt) })}</p> : null}
    </Dialog>
  );
}
