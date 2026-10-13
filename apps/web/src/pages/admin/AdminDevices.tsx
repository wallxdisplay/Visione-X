import { collection, collectionGroup, limit, query } from 'firebase/firestore';
import { Button, Dialog, PageHeader, StatusChip, TextField } from '@wallx-play/ui';
import { hasPlatformPermission, type OrgDoc, type ScreenDoc } from '@wallx-play/shared';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../auth/AuthProvider';
import { orgIdOf } from '../../content/billing';
import { db } from '../../lib/firebase';
import { formatDateTime } from '../../lib/format';
import { useQueryData, type WithId } from '../../lib/hooks';
import { CommandPanel } from '../content/ScreenCommands';
import { screenState } from '../content/Screens';
import './admin.css';

type Filter = 'all' | 'online' | 'offline' | 'pending' | 'neverSeen' | 'errors';
const FILTERS: Filter[] = ['all', 'online', 'offline', 'pending', 'neverSeen', 'errors'];

/** Platform view of every screen and player across organizations (device.view). */
export function AdminDevices() {
  const { t } = useTranslation();
  const { platformRole } = useAuth();
  const canCommand = hasPlatformPermission(platformRole, 'device.command');
  const screens = useQueryData<ScreenDoc>('admin:screens', () => query(collectionGroup(db, 'screens'), limit(2000)));
  const orgs = useQueryData<OrgDoc>('admin:orgs', () => query(collection(db, 'orgs'), limit(1000)));
  const orgName = useMemo(() => new Map(orgs.data.map((o) => [o.id, o.name])), [orgs.data]);
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<WithId<ScreenDoc> | null>(null);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return screens.data
      .filter((s) => {
        const state = screenState(s).key;
        if (filter === 'errors' ? !s.health?.errors.length : filter !== 'all' && state !== filter) return false;
        return !q || s.name.toLowerCase().includes(q) || (orgName.get(orgIdOf(s._path)) ?? '').toLowerCase().includes(q) || (s.device?.model ?? '').toLowerCase().includes(q);
      })
      .sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0));
  }, [screens.data, filter, search, orgName]);

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: screens.data.length, online: 0, offline: 0, pending: 0, neverSeen: 0, errors: 0 };
    for (const s of screens.data) {
      c[screenState(s).key as Filter] += 1;
      if (s.health?.errors.length) c.errors += 1;
    }
    return c;
  }, [screens.data]);

  // Player app versions in the field (helps plan updates).
  const versions = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of screens.data) if (s.health?.appVersion) m.set(s.health.appVersion, (m.get(s.health.appVersion) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0], undefined, { numeric: true }));
  }, [screens.data]);

  return (
    <>
      <PageHeader title={t('nav.admin.devices')} description={t('adminDevices.description')} />

      <div className="wxp-stat-row">
        {(['all', 'online', 'offline', 'pending'] as const).map((k) => (
          <div key={k} className="wxp-stat">
            <div className="wxp-stat__label">{t(`adminDevices.stats.${k}`)}</div>
            <div className="wxp-stat__value">{counts[k]}</div>
          </div>
        ))}
      </div>
      {versions.length ? (
        <p className="admin-devices__versions">
          <span className="wxp-muted">{t('adminDevices.versions')}</span>{' '}
          {versions.map(([v, n]) => (
            <span key={v} className="admin-devices__version">
              v{v} × {n}
            </span>
          ))}
        </p>
      ) : null}

      <div className="admin-devices__filters">
        <div className="wxp-toolbar" role="group" aria-label={t('adminDevices.filter')} style={{ margin: 0 }}>
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={filter === f}
              className={`wxp-btn wxp-btn--sm ${filter === f ? 'wxp-btn--primary' : 'wxp-btn--secondary'}`}
              onClick={() => setFilter(f)}
            >
              {t(`adminDevices.filters.${f}`)} ({counts[f]})
            </button>
          ))}
        </div>
        <TextField label={t('adminDevices.search')} value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      <div className="wxp-table-wrap">
        <table className="wxp-table">
          <thead>
            <tr>
              <th>{t('adminDevices.screen')}</th>
              <th>{t('adminDevices.org')}</th>
              <th>{t('adminDevices.status')}</th>
              <th>{t('adminDevices.player')}</th>
              <th>{t('adminDevices.box')}</th>
              <th>{t('adminDevices.lastSeen')}</th>
              <th>{t('adminDevices.errors')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => {
              const state = screenState(s);
              return (
                <tr key={s._path}>
                  <td>
                    <button type="button" className="link-btn" onClick={() => setOpen(s)}>
                      {s.name}
                    </button>
                  </td>
                  <td>{orgName.get(orgIdOf(s._path)) ?? orgIdOf(s._path)}</td>
                  <td>
                    <StatusChip tone={state.tone}>{t(`screens.states.${state.key}`)}</StatusChip>
                  </td>
                  <td className="wxp-tabular">{s.health?.appVersion ? `v${s.health.appVersion}` : '—'}</td>
                  <td>{s.device ? `${s.device.manufacturer} ${s.device.model} · Android ${s.device.androidVersion}` : '—'}</td>
                  <td>{formatDateTime(s.lastSeen)}</td>
                  <td className="wxp-tabular">{s.health?.errors.length || ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && !screens.loading ? <p className="wxp-muted">{t('adminDevices.none')}</p> : null}

      {open ? (
        <Dialog open size="lg" title={open.name} onClose={() => setOpen(null)} footer={<Button onClick={() => setOpen(null)}>{t('common.close')}</Button>}>
          <dl className="wxp-dl">
            <dt>{t('adminDevices.org')}</dt>
            <dd>{orgName.get(orgIdOf(open._path)) ?? orgIdOf(open._path)}</dd>
            <dt>{t('adminDevices.status')}</dt>
            <dd>{t(`screens.states.${screenState(open).key}`)}</dd>
            <dt>{t('adminDevices.box')}</dt>
            <dd>{open.device ? `${open.device.manufacturer} ${open.device.model} · Android ${open.device.androidVersion}` : '—'}</dd>
            <dt>{t('adminDevices.display')}</dt>
            <dd className="wxp-tabular">
              {open.health ? `${open.health.display.width}×${open.health.display.height}` : '—'} ({t(`studio.orientations.${open.orientation}`)}
              {open.rotation ? `, ${open.rotation}°` : ''})
            </dd>
            <dt>{t('adminDevices.storage')}</dt>
            <dd className="wxp-tabular">{open.health?.storageFreeMb != null ? `${open.health.storageFreeMb} MB` : '—'}</dd>
            <dt>{t('adminDevices.content')}</dt>
            <dd>
              {t('adminDevices.manifest', { published: open.manifestVersion, playing: open.health?.manifestVersion ?? '—' })}
              {open.health?.playing ? ` · ${open.health.playing.source}` : ''}
            </dd>
            <dt>{t('adminDevices.lastSeen')}</dt>
            <dd>{formatDateTime(open.lastSeen)}</dd>
            {open.health?.update ? (
              <>
                <dt>{t('adminDevices.update')}</dt>
                <dd>
                  {t(`adminDevices.updateStates.${open.health.update.state}`, { version: open.health.update.versionName })}
                  {open.health.update.error ? <span className="wxp-muted"> — {open.health.update.error}</span> : null}
                </dd>
              </>
            ) : null}
          </dl>
          {open.health?.errors.length ? (
            <>
              <h3>{t('adminDevices.recentErrors')}</h3>
              <ul className="admin-devices__errors">
                {open.health.errors.map((e, i) => (
                  <li key={i}>
                    <code>{e}</code>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {/* Staff troubleshooting: not limited by the customer's plan; every command is audited. */}
          <CommandPanel orgId={orgIdOf(open._path)} screen={open} canSend={canCommand} entitled />
        </Dialog>
      ) : null}
    </>
  );
}
