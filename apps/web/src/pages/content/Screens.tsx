import { collection, orderBy, query } from 'firebase/firestore';
import { Alert, Button, Dialog, EmptyState, PageHeader, SelectField, StatusChip, TextField } from '@visione-x/ui';
import { RESOLUTION_PRESETS } from '@visione-x/layout-spec';
import {
  ClaimDeviceInput,
  DEFAULT_SCREEN_RESOLUTION,
  isScreenOnline,
  paths,
  type ScreenDoc,
} from '@visione-x/shared';
import { Monitor, Plus, Send } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { usePlaylists, useScreenGroups, useSites } from '../../content/data';
import { call, errorMessage } from '../../lib/api';
import { db } from '../../lib/firebase';
import { fieldErrors, formatDateTime } from '../../lib/format';
import { useQueryData } from '../../lib/hooks';
import { useOrg } from '../../org/OrgProvider';

type Tone = 'success' | 'danger' | 'warning' | 'neutral';

export function screenState(s: ScreenDoc): { key: string; tone: Tone } {
  if (s.status === 'pending_authorization') return { key: 'pending', tone: 'warning' };
  if (!s.lastSeen) return { key: 'neverSeen', tone: 'neutral' };
  return isScreenOnline(s) ? { key: 'online', tone: 'success' } : { key: 'offline', tone: 'danger' };
}

interface ScreenForm {
  name: string;
  siteId: string;
  groupIds: string[];
  orientation: 'landscape' | 'portrait';
  preset: string;
  defaultPlaylistId: string;
}

function resolutionFor(form: ScreenForm) {
  const p = RESOLUTION_PRESETS.find((x) => x.id === form.preset) ?? RESOLUTION_PRESETS[0]!;
  return form.orientation === 'portrait' ? { width: p.height, height: p.width } : { width: p.width, height: p.height };
}

export function Screens() {
  const { t } = useTranslation();
  const { orgId, can } = useOrg();
  const [params, setParams] = useSearchParams();
  const screens = useQueryData<ScreenDoc>(`screens:${orgId}`, () => query(collection(db, paths.screens(orgId)), orderBy('name')));
  const sites = useSites(orgId);
  const [adding, setAdding] = useState<string | null>(null);
  const [editing, setEditing] = useState<ScreenDoc | null>(null);
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // QR on the player opens /screens?pair=CODE → start pairing with the code filled in.
  useEffect(() => {
    const code = params.get('pair');
    if (code && can('screen.manage')) {
      setAdding(code);
      setParams({}, { replace: true });
    }
  }, [params, setParams, can]);

  async function publish(screenIds: string[]) {
    setBusy(true);
    setMessage(null);
    try {
      const { published } = await call<{ published: number }>('publishScreens', { orgId, screenIds });
      setMessage({ tone: 'success', text: t('screens.published', { count: published }) });
    } catch (err) {
      setMessage({ tone: 'danger', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  async function authorize(s: ScreenDoc) {
    setBusy(true);
    setMessage(null);
    try {
      await call('authorizeScreen', { orgId, screenId: s.id });
    } catch (err) {
      setMessage({ tone: 'danger', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title={t('nav.screens')}
        description={t('screens.description')}
        actions={
          <div className="vx-toolbar" style={{ margin: 0 }}>
            {can('content.publish') && screens.data.some((s) => s.status === 'authorized') ? (
              <Button disabled={busy} onClick={() => void publish([])}>
                <Send size={15} aria-hidden /> {t('screens.publishAll')}
              </Button>
            ) : null}
            {can('screen.manage') ? (
              <Button variant="primary" onClick={() => setAdding('')}>
                <Plus size={16} aria-hidden /> {t('screens.add')}
              </Button>
            ) : null}
          </div>
        }
      />
      {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}

      {screens.data.length === 0 && !screens.loading ? (
        <div className="vx-card">
          <EmptyState
            icon={<Monitor size={24} aria-hidden />}
            title={t('screens.emptyTitle')}
            description={t('screens.emptyBody')}
            action={can('screen.manage') ? <Button variant="primary" onClick={() => setAdding('')}>{t('screens.add')}</Button> : undefined}
          />
        </div>
      ) : (
        <div className="vx-table-wrap">
          <table className="vx-table">
            <thead>
              <tr>
                <th>{t('screens.name')}</th>
                <th>{t('screens.status')}</th>
                <th>{t('screens.lastSeen')}</th>
                <th>{t('screens.player')}</th>
                <th>{t('screens.content')}</th>
                <th aria-label={t('common.actions')} />
              </tr>
            </thead>
            <tbody>
              {screens.data.map((s) => {
                const state = screenState(s);
                return (
                  <tr key={s.id}>
                    <td>
                      <button type="button" className="link-btn" onClick={() => setEditing(s)}>
                        {s.name}
                      </button>
                      <div className="vx-muted">
                        {sites.data.find((x) => x.id === s.siteId)?.name ?? t('screens.noSite')} · {s.resolution.width}×{s.resolution.height}
                      </div>
                    </td>
                    <td>
                      <StatusChip tone={state.tone}>{t(`screens.states.${state.key}`)}</StatusChip>
                      {s.health?.errors.length ? <div className="vx-field__error">{t('screens.errors', { count: s.health.errors.length })}</div> : null}
                    </td>
                    <td className="vx-tabular">{formatDateTime(s.lastSeen)}</td>
                    <td>
                      {s.device ? `${s.device.manufacturer} ${s.device.model}` : '—'}
                      <div className="vx-muted">
                        {s.device ? `Android ${s.device.androidVersion}` : ''}
                        {s.health ? ` · v${s.health.appVersion}` : ''}
                      </div>
                    </td>
                    <td>
                      {s.publishedAt ? t('screens.version', { v: s.manifestVersion }) : t('screens.notPublished')}
                      <div className="vx-muted">
                        {s.publishedAt ? formatDateTime(s.publishedAt) : ''}
                        {s.health?.manifestVersion != null && s.publishedAt && s.health.manifestVersion < s.manifestVersion
                          ? ` · ${t('screens.syncing')}`
                          : ''}
                      </div>
                    </td>
                    <td className="vx-actions">
                      {s.status === 'pending_authorization' && can('device.authorize') ? (
                        <Button size="sm" variant="primary" disabled={busy} onClick={() => void authorize(s)}>
                          {t('screens.authorize')}
                        </Button>
                      ) : null}
                      {s.status === 'authorized' && can('content.publish') ? (
                        <Button size="sm" variant="tertiary" disabled={busy} onClick={() => void publish([s.id])}>
                          {t('screens.publish')}
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="vx-muted" style={{ marginTop: 16 }}>
        {t('screens.publishHint')}
      </p>

      {adding !== null ? <ScreenDialog code={adding} onClose={() => setAdding(null)} /> : null}
      {editing ? (
        <ScreenDialog key={editing.id} screen={screens.data.find((s) => s.id === editing.id) ?? editing} onClose={() => setEditing(null)} />
      ) : null}
    </>
  );
}

/** Add (pair) a screen when `code` is given, otherwise edit `screen`. */
function ScreenDialog({ code, screen, onClose }: { code?: string; screen?: ScreenDoc; onClose: () => void }) {
  const { t } = useTranslation();
  const { orgId, can } = useOrg();
  const sites = useSites(orgId);
  const groups = useScreenGroups(orgId);
  const playlists = usePlaylists(orgId);
  const editable = can('screen.manage');
  const [pairingCode, setPairingCode] = useState(code ?? '');
  const [form, setForm] = useState<ScreenForm>(() => ({
    name: screen?.name ?? '',
    siteId: screen?.siteId ?? '',
    groupIds: screen?.groupIds ?? [],
    orientation: screen?.orientation ?? 'landscape',
    preset:
      RESOLUTION_PRESETS.find(
        (p) =>
          Math.max(p.width, p.height) === Math.max(screen?.resolution.width ?? DEFAULT_SCREEN_RESOLUTION.width, screen?.resolution.height ?? 0),
      )?.id ?? 'fhd',
    defaultPlaylistId: screen?.defaultPlaylistId ?? '',
  }));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const set = <K extends keyof ScreenForm>(k: K, v: ScreenForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  async function save() {
    const base = {
      orgId,
      name: form.name,
      siteId: form.siteId || null,
      groupIds: form.groupIds,
      orientation: form.orientation,
      resolution: resolutionFor(form),
    };
    setBusy(true);
    setError(null);
    try {
      if (screen) {
        await call('updateScreen', { ...base, screenId: screen.id, defaultPlaylistId: form.defaultPlaylistId || null });
      } else {
        const parsed = ClaimDeviceInput.safeParse({ ...base, pairingCode });
        if (!parsed.success) {
          setErrors(fieldErrors(parsed.error.issues));
          setBusy(false);
          return;
        }
        await call('claimDevice', parsed.data);
      }
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  async function remove() {
    if (!screen) return;
    setBusy(true);
    try {
      await call('removeScreen', { orgId, screenId: screen.id });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  const h = screen?.health;
  return (
    <Dialog
      open
      size="lg"
      title={screen ? screen.name : t('screens.add')}
      onClose={onClose}
      footer={
        confirmRemove ? (
          <>
            <Button onClick={() => setConfirmRemove(false)}>{t('common.cancel')}</Button>
            <Button variant="danger" disabled={busy} onClick={() => void remove()}>{t('screens.removeConfirm')}</Button>
          </>
        ) : (
          <>
            {screen && editable ? <Button variant="tertiary" onClick={() => setConfirmRemove(true)}>{t('screens.remove')}</Button> : null}
            <Button onClick={onClose}>{t('common.cancel')}</Button>
            {editable ? (
              <Button variant="primary" disabled={busy || !form.name.trim() || (!screen && !pairingCode.trim())} onClick={() => void save()}>
                {screen ? t('common.save') : t('screens.pair')}
              </Button>
            ) : null}
          </>
        )
      }
    >
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {confirmRemove ? <Alert tone="warning">{t('screens.removeBody')}</Alert> : null}
      {!screen ? (
        <>
          <Alert tone="info">{t('screens.pairHelp')}</Alert>
          <TextField
            label={t('screens.pairingCode')}
            required
            value={pairingCode}
            error={errors.pairingCode}
            autoComplete="off"
            className="vx-input pairing-input"
            maxLength={9}
            onChange={(e) => setPairingCode(e.target.value.toUpperCase())}
          />
        </>
      ) : null}
      <TextField label={t('screens.name')} required value={form.name} maxLength={80} disabled={!editable} onChange={(e) => set('name', e.target.value)} />
      <div className="vx-form__row">
        <SelectField
          label={t('screens.site')}
          disabled={!editable}
          options={[{ value: '', label: t('screens.noSite') }, ...sites.data.map((s) => ({ value: s.id, label: s.name }))]}
          value={form.siteId}
          onChange={(e) => set('siteId', e.target.value)}
        />
        <SelectField
          label={t('studio.orientation')}
          disabled={!editable}
          options={['landscape', 'portrait'].map((o) => ({ value: o, label: t(`studio.orientations.${o}`) }))}
          value={form.orientation}
          onChange={(e) => set('orientation', e.target.value as ScreenForm['orientation'])}
        />
        <SelectField
          label={t('studio.resolution')}
          disabled={!editable}
          options={RESOLUTION_PRESETS.map((p) => ({ value: p.id, label: t(`studio.presets.${p.id}`, { w: p.width, h: p.height }) }))}
          value={form.preset}
          onChange={(e) => set('preset', e.target.value)}
        />
      </div>
      {groups.data.length ? (
        <fieldset className="check-group check-group--row">
          <legend className="vx-field__label">{t('screens.groups')}</legend>
          {groups.data.map((g) => (
            <label key={g.id} className="day-chip">
              <input
                type="checkbox"
                disabled={!editable}
                checked={form.groupIds.includes(g.id)}
                onChange={(e) => set('groupIds', e.target.checked ? [...form.groupIds, g.id] : form.groupIds.filter((x) => x !== g.id))}
              />
              <span>{g.name}</span>
            </label>
          ))}
        </fieldset>
      ) : null}
      {screen ? (
        <SelectField
          label={t('screens.defaultPlaylist')}
          hint={t('screens.defaultPlaylistHint')}
          disabled={!editable}
          options={[{ value: '', label: t('screens.none') }, ...playlists.data.map((p) => ({ value: p.id, label: p.name }))]}
          value={form.defaultPlaylistId}
          onChange={(e) => set('defaultPlaylistId', e.target.value)}
        />
      ) : null}
      {screen ? (
        <dl className="vx-dl">
          <dt>{t('screens.lastSeen')}</dt>
          <dd>{formatDateTime(screen.lastSeen)}</dd>
          <dt>{t('screens.player')}</dt>
          <dd>{screen.device ? `${screen.device.manufacturer} ${screen.device.model} · Android ${screen.device.androidVersion}` : '—'}</dd>
          {h ? (
            <>
              <dt>{t('screens.output')}</dt>
              <dd className="vx-tabular">
                {h.display.width}×{h.display.height} · v{h.appVersion}
              </dd>
              <dt>{t('screens.storageFree')}</dt>
              <dd className="vx-tabular">{h.storageFreeMb != null ? `${h.storageFreeMb} MB` : '—'}</dd>
              <dt>{t('screens.nowPlaying')}</dt>
              <dd>{h.playing ? `${h.playing.source} · ${h.playing.playlistId ?? '—'}` : '—'}</dd>
              <dt>{t('screens.contentVersion')}</dt>
              <dd className="vx-tabular">
                {h.manifestVersion ?? '—'} / {screen.manifestVersion}
              </dd>
            </>
          ) : null}
        </dl>
      ) : null}
      {h?.errors.length ? (
        <Alert tone="warning" title={t('screens.recentErrors')}>
          <ul className="plain-list">
            {h.errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </Alert>
      ) : null}
    </Dialog>
  );
}
