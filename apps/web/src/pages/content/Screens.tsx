import { Alert, Button, Dialog, EmptyState, PageHeader, SelectField, StatusChip, TextField } from '@wallx-play/ui';
import { RESOLUTION_PRESETS } from '@wallx-play/layout-spec';
import {
  ClaimDeviceInput,
  DEFAULT_SCREEN_RESOLUTION,
  SCREEN_ROTATIONS,
  isScreenOnline,
  type ScreenDoc,
  type ScreenRotation,
} from '@wallx-play/shared';
import { AppWindow, Monitor, Plus, Send, Siren } from 'lucide-react';
import { AppScreensDialog, screenAppNames } from './AppScreens';
import { useAppCatalog } from '../../content/apps';
import { ApprovalsPanel } from './ApprovalsPanel';
import { EmergencyDialog } from './EmergencyDialog';
import { ScreenDiagnostics } from '../analytics/ScreenDiagnostics';
import { ScreenCommands } from './ScreenCommands';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { useLayouts, usePlaylists, useScreenGroups, useScreens, useSites } from '../../content/data';
import { call, errorMessage } from '../../lib/api';
import { fieldErrors, formatDateTime } from '../../lib/format';
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
  rotation: ScreenRotation;
  preset: string;
  defaultPlaylistId: string;
  /** Touch screen: home page layout ('' = off). */
  touchHome: string;
  touchIdle: string;
  touchAttract: boolean;
}

function resolutionFor(form: ScreenForm) {
  const p = RESOLUTION_PRESETS.find((x) => x.id === form.preset) ?? RESOLUTION_PRESETS[0]!;
  return form.orientation === 'portrait' ? { width: p.height, height: p.width } : { width: p.width, height: p.height };
}

export function Screens() {
  const { t } = useTranslation();
  const { orgId, org, can, siteScope, entitlements } = useOrg();
  const diagnosticsOn = !!entitlements?.features.includes('screen.diagnostics');
  const [diagnosing, setDiagnosing] = useState<ScreenDoc | null>(null);
  const [params, setParams] = useSearchParams();
  const screens = useScreens(orgId, siteScope);
  const sites = useSites(orgId);
  const [adding, setAdding] = useState<string | null>(null);
  const [editing, setEditing] = useState<ScreenDoc | null>(null);
  const [emergencyOpen, setEmergencyOpen] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'warning' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // App store: after the trial, organizations billed by apps place screen apps screen by screen.
  const seats = entitlements?.screenApps;
  const catalog = useAppCatalog(!!seats);
  const [placingApps, setPlacingApps] = useState(false);

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
      const { published, approvalId, missingApps } = await call<{
        published: number;
        approvalId?: string;
        missingApps?: Array<{ screenId: string; name: string; features: string[] }>;
      }>('publishScreens', { orgId, screenIds });
      const done = approvalId ? t('screens.sentForApproval') : t('screens.published', { count: published });
      // Content using an app a screen does not hold shows a notice there instead.
      setMessage(
        missingApps?.length
          ? { tone: 'warning', text: `${done} ${t('screenApps.missing', { screens: missingApps.map((m) => m.name).join(', ') })}` }
          : { tone: 'success', text: done },
      );
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
          <div className="wxp-toolbar" style={{ margin: 0 }}>
            {can('emergency.trigger') && screens.data.some((s) => s.status === 'authorized') ? (
              <Button variant="danger" onClick={() => setEmergencyOpen(true)}>
                <Siren size={15} aria-hidden /> {t('emergency.button')}
              </Button>
            ) : null}
            {seats && can('screen.manage') && !siteScope?.length ? (
              <Button onClick={() => setPlacingApps(true)}>
                <AppWindow size={15} aria-hidden /> {t('screenApps.button')}
              </Button>
            ) : null}
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
      <ApprovalsPanel />

      {screens.data.length === 0 && !screens.loading ? (
        <div className="wxp-card">
          <EmptyState
            icon={<Monitor size={24} aria-hidden />}
            title={t('screens.emptyTitle')}
            description={t('screens.emptyBody')}
            action={can('screen.manage') ? <Button variant="primary" onClick={() => setAdding('')}>{t('screens.add')}</Button> : undefined}
          />
        </div>
      ) : (
        <div className="wxp-table-wrap">
          <table className="wxp-table">
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
                      <div className="wxp-muted">
                        {sites.data.find((x) => x.id === s.siteId)?.name ?? t('screens.noSite')} · {s.resolution.width}×{s.resolution.height}
                      </div>
                      {seats && s.status === 'authorized' ? (
                        <div className="wxp-muted">{t('screenApps.onScreen', { apps: screenAppNames(s, catalog.data) || t('screenApps.baseOnly') })}</div>
                      ) : null}
                    </td>
                    <td>
                      <StatusChip tone={state.tone}>{t(`screens.states.${state.key}`)}</StatusChip>
                      {s.health?.errors.length ? <div className="wxp-field__error">{t('screens.errors', { count: s.health.errors.length })}</div> : null}
                    </td>
                    <td className="wxp-tabular">{formatDateTime(s.lastSeen)}</td>
                    <td>
                      {s.device ? `${s.device.manufacturer} ${s.device.model}` : '—'}
                      <div className="wxp-muted">
                        {s.device ? `Android ${s.device.androidVersion}` : ''}
                        {s.health ? ` · v${s.health.appVersion}` : ''}
                      </div>
                    </td>
                    <td>
                      {s.publishedAt ? t('screens.version', { v: s.manifestVersion }) : t('screens.notPublished')}
                      <div className="wxp-muted">
                        {s.publishedAt ? formatDateTime(s.publishedAt) : ''}
                        {s.health?.manifestVersion != null && s.publishedAt && s.health.manifestVersion < s.manifestVersion
                          ? ` · ${t('screens.syncing')}`
                          : ''}
                      </div>
                    </td>
                    <td className="wxp-actions">
                      {s.status === 'pending_authorization' && can('device.authorize') ? (
                        <Button size="sm" variant="primary" disabled={busy} onClick={() => void authorize(s)}>
                          {t('screens.authorize')}
                        </Button>
                      ) : null}
                      {s.status === 'authorized' && diagnosticsOn && !s.blockedFeatures?.includes('screen.diagnostics') ? (
                        <Button size="sm" variant="tertiary" onClick={() => setDiagnosing(s)}>
                          {t('analytics.diagnostics')}
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
      <p className="wxp-muted" style={{ marginTop: 16 }}>
        {t('screens.publishHint')}
      </p>

      {adding !== null ? <ScreenDialog code={adding} onClose={() => setAdding(null)} /> : null}
      {placingApps && seats ? (
        <AppScreensDialog orgId={orgId} seats={seats} catalog={catalog.data} screens={screens.data} onClose={() => setPlacingApps(false)} />
      ) : null}
      {emergencyOpen ? <EmergencyDialog screens={screens.data} onClose={() => setEmergencyOpen(false)} /> : null}
      {diagnosing ? (
        <ScreenDiagnostics
          orgId={orgId}
          screen={screens.data.find((s) => s.id === diagnosing.id) ?? diagnosing}
          timezone={org?.timezone ?? 'Asia/Kolkata'}
          onClose={() => setDiagnosing(null)}
        />
      ) : null}
      {editing ? (
        <ScreenDialog key={editing.id} screen={screens.data.find((s) => s.id === editing.id) ?? editing} onClose={() => setEditing(null)} />
      ) : null}
    </>
  );
}

/** Add (pair) a screen when `code` is given, otherwise edit `screen`. */
function ScreenDialog({ code, screen, onClose }: { code?: string; screen?: ScreenDoc; onClose: () => void }) {
  const { t } = useTranslation();
  const { orgId, can, siteScope, entitlements } = useOrg();
  const touchInPlan = !!entitlements?.features.includes('interactive.touch');
  const layouts = useLayouts(orgId);
  const allSites = useSites(orgId);
  // Scoped members place screens only at their own sites (a site is then required).
  const siteChoices = siteScope.length ? allSites.data.filter((x) => siteScope.includes(x.id)) : allSites.data;
  const groups = useScreenGroups(orgId);
  const playlists = usePlaylists(orgId);
  const editable = can('screen.manage');
  const [pairingCode, setPairingCode] = useState(code ?? '');
  const [form, setForm] = useState<ScreenForm>(() => ({
    name: screen?.name ?? '',
    siteId: screen?.siteId ?? (siteScope.length ? (siteScope[0] ?? '') : ''),
    groupIds: screen?.groupIds ?? [],
    orientation: screen?.orientation ?? 'landscape',
    rotation: screen?.rotation ?? 0,
    preset:
      RESOLUTION_PRESETS.find(
        (p) =>
          Math.max(p.width, p.height) === Math.max(screen?.resolution.width ?? DEFAULT_SCREEN_RESOLUTION.width, screen?.resolution.height ?? 0),
      )?.id ?? 'fhd',
    defaultPlaylistId: screen?.defaultPlaylistId ?? '',
    touchHome: screen?.touch?.homeLayoutId ?? '',
    touchIdle: String(screen?.touch?.idleSec ?? 60),
    touchAttract: screen?.touch?.attract ?? true,
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
      rotation: form.rotation,
      resolution: resolutionFor(form),
    };
    setBusy(true);
    setError(null);
    try {
      if (screen) {
        // Touch settings are sent only on plans with touch screens (otherwise left as they are).
        const touch = touchInPlan
          ? form.touchHome
            ? { homeLayoutId: form.touchHome, idleSec: Math.min(3600, Math.max(10, Math.round(Number(form.touchIdle) || 60))), attract: form.touchAttract }
            : null
          : undefined;
        await call('updateScreen', { ...base, screenId: screen.id, defaultPlaylistId: form.defaultPlaylistId || null, ...(touch !== undefined ? { touch } : {}) });
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
            className="wxp-input pairing-input"
            maxLength={9}
            onChange={(e) => setPairingCode(e.target.value.toUpperCase())}
          />
        </>
      ) : null}
      <TextField label={t('screens.name')} required value={form.name} maxLength={80} disabled={!editable} onChange={(e) => set('name', e.target.value)} />
      <div className="wxp-form__row">
        <SelectField
          label={t('screens.site')}
          disabled={!editable}
          options={[...(siteScope.length ? [] : [{ value: '', label: t('screens.noSite') }]), ...siteChoices.map((s) => ({ value: s.id, label: s.name }))]}
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
      <SelectField
        label={t('screens.rotation')}
        hint={t('screens.rotationHint')}
        disabled={!editable}
        options={SCREEN_ROTATIONS.map((r) => ({ value: String(r), label: t(`screens.rotations.r${r}`) }))}
        value={String(form.rotation)}
        onChange={(e) => set('rotation', Number(e.target.value) as ScreenRotation)}
      />
      {groups.data.length ? (
        <fieldset className="check-group check-group--row">
          <legend className="wxp-field__label">{t('screens.groups')}</legend>
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
      {screen && touchInPlan ? (
        <fieldset className="touch-settings">
          <legend className="wxp-field__label">{t('screens.touch.title')}</legend>
          {screen.syncGroupId ? (
            <p className="wxp-muted">{t('screens.touch.inSyncGroup')}</p>
          ) : (
            <>
              <SelectField
                label={t('screens.touch.home')}
                hint={t('screens.touch.homeHint')}
                disabled={!editable}
                options={[{ value: '', label: t('screens.touch.off') }, ...layouts.data.map((l) => ({ value: l.id, label: l.name }))]}
                value={form.touchHome}
                onChange={(e) => set('touchHome', e.target.value)}
              />
              {form.touchHome ? (
                <div className="wxp-form__row">
                  <TextField
                    label={t('screens.touch.idle')}
                    hint={t('screens.touch.idleHint')}
                    type="number"
                    min={10}
                    max={3600}
                    disabled={!editable}
                    value={form.touchIdle}
                    onChange={(e) => set('touchIdle', e.target.value)}
                  />
                  <label className="checkbox-row">
                    <input type="checkbox" disabled={!editable} checked={form.touchAttract} onChange={(e) => set('touchAttract', e.target.checked)} />
                    {t('screens.touch.attract')}
                  </label>
                </div>
              ) : null}
              {form.touchHome ? <p className="wxp-field__hint">{t(form.touchAttract ? 'screens.touch.attractOn' : 'screens.touch.attractOff')}</p> : null}
            </>
          )}
        </fieldset>
      ) : null}
      {screen ? (
        <dl className="wxp-dl">
          <dt>{t('screens.lastSeen')}</dt>
          <dd>{formatDateTime(screen.lastSeen)}</dd>
          <dt>{t('screens.player')}</dt>
          <dd>{screen.device ? `${screen.device.manufacturer} ${screen.device.model} · Android ${screen.device.androidVersion}` : '—'}</dd>
          {h ? (
            <>
              <dt>{t('screens.output')}</dt>
              <dd className="wxp-tabular">
                {h.display.width}×{h.display.height} · v{h.appVersion}
              </dd>
              <dt>{t('screens.storageFree')}</dt>
              <dd className="wxp-tabular">{h.storageFreeMb != null ? `${h.storageFreeMb} MB` : '—'}</dd>
              <dt>{t('screens.nowPlaying')}</dt>
              <dd>{h.playing ? `${h.playing.source} · ${h.playing.playlistId ?? '—'}` : '—'}</dd>
              <dt>{t('screens.contentVersion')}</dt>
              <dd className="wxp-tabular">
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
      {screen ? <ScreenCommands screen={screen} /> : null}
    </Dialog>
  );
}
