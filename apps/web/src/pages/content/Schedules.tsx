import { Alert, Button, Card, Dialog, EmptyState, PageHeader, SelectField, StatusChip, TextField } from '@visione-x/ui';
import { findConflicts, localParts, resolvePlaylist, ruleActiveAt, type ScheduleRule } from '@visione-x/layout-spec';
import { SaveScheduleInput, type ScheduleDoc, type ScheduleTarget } from '@visione-x/shared';
import { CalendarClock, Plus, TriangleAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useById, usePlaylists, useSchedules, useScreenGroups, useSites } from '../../content/data';
import { call, errorMessage } from '../../lib/api';
import { fieldErrors, formatDateTime, timezoneOptions } from '../../lib/format';
import { useOrg } from '../../org/OrgProvider';

const DAYS = [1, 2, 3, 4, 5, 6, 0]; // Monday first
const toRule = (s: ScheduleDoc): ScheduleRule => ({
  id: s.id,
  priority: s.priority,
  timezone: s.timezone,
  startDate: s.startDate,
  endDate: s.endDate,
  daysOfWeek: s.daysOfWeek,
  windowStart: s.windowStart,
  windowEnd: s.windowEnd,
  playlistId: s.playlistId,
});

const appliesTo = (target: ScheduleTarget, filter: string) => {
  if (filter === 'all' || target.kind === 'all') return true;
  const [kind, id] = filter.split(':');
  return target.kind === kind && target.ids.includes(id!);
};

export function Schedules() {
  const { t } = useTranslation();
  const { orgId, can } = useOrg();
  const schedules = useSchedules(orgId);
  const playlists = usePlaylists(orgId);
  const sites = useSites(orgId);
  const groups = useScreenGroups(orgId);
  const playlistById = useById(playlists.data);
  const editable = can('schedule.edit');

  const [editing, setEditing] = useState<ScheduleDoc | 'new' | null>(null);
  const [targetFilter, setTargetFilter] = useState('all');
  const [testAt, setTestAt] = useState(() => toLocalInput(Date.now()));

  const enabled = useMemo(
    () => schedules.data.filter((s) => s.enabled && appliesTo(s.target, targetFilter)),
    [schedules.data, targetFilter],
  );
  const rules = useMemo(() => enabled.map(toRule), [enabled]);
  const weekStart = useMemo(() => startOfWeek(Date.now()), []);
  const conflicts = useMemo(() => findConflicts(rules, Date.now(), { days: 14, stepMinutes: 15 }), [rules]);
  const resolution = resolvePlaylist({ schedules: rules, defaultPlaylistId: null }, new Date(testAt).getTime());
  const scheduleName = (id: string) => schedules.data.find((s) => s.id === id)?.name ?? id;

  const targetLabel = (target: ScheduleTarget) => {
    if (target.kind === 'all') return t('schedules.allScreens');
    const source = target.kind === 'sites' ? sites.data : groups.data;
    return target.ids.map((id) => source.find((x) => x.id === id)?.name ?? '?').join(', ');
  };
  const whenLabel = (s: ScheduleDoc) => {
    const days = s.daysOfWeek.length === 0 || s.daysOfWeek.length === 7 ? t('schedules.everyDay') : s.daysOfWeek.map((d) => t(`schedules.days.${d}`)).join(', ');
    const window = s.windowStart ? `${s.windowStart}–${s.windowEnd}` : t('schedules.allDay');
    return `${days} · ${window}`;
  };

  const filterOptions = [
    { value: 'all', label: t('schedules.filterAll') },
    ...sites.data.map((s) => ({ value: `sites:${s.id}`, label: `${t('schedules.site')}: ${s.name}` })),
    ...groups.data.map((g) => ({ value: `groups:${g.id}`, label: `${t('schedules.group')}: ${g.name}` })),
  ];

  return (
    <>
      <PageHeader
        title={t('nav.schedules')}
        description={t('schedules.description')}
        actions={
          editable ? (
            <Button variant="primary" disabled={!playlists.data.length} onClick={() => setEditing('new')}>
              <Plus size={16} aria-hidden /> {t('schedules.new')}
            </Button>
          ) : null
        }
      />
      {!playlists.data.length && !playlists.loading ? <Alert tone="info">{t('schedules.needPlaylist')}</Alert> : null}

      {schedules.data.length === 0 && !schedules.loading ? (
        <div className="vx-card">
          <EmptyState icon={<CalendarClock size={24} aria-hidden />} title={t('schedules.emptyTitle')} description={t('schedules.emptyBody')} />
        </div>
      ) : (
        <div className="vx-stack">
          <div className="vx-table-wrap">
            <table className="vx-table">
              <thead>
                <tr>
                  <th>{t('schedules.name')}</th>
                  <th>{t('schedules.playlist')}</th>
                  <th>{t('schedules.target')}</th>
                  <th>{t('schedules.when')}</th>
                  <th>{t('schedules.dates')}</th>
                  <th>{t('schedules.priority')}</th>
                  <th>{t('schedules.status')}</th>
                </tr>
              </thead>
              <tbody>
                {schedules.data.map((s) => (
                  <tr key={s.id}>
                    <td>
                      {editable ? (
                        <button type="button" className="link-btn" onClick={() => setEditing(s)}>
                          {s.name}
                        </button>
                      ) : (
                        s.name
                      )}
                    </td>
                    <td>{playlistById.get(s.playlistId)?.name ?? '—'}</td>
                    <td>{targetLabel(s.target)}</td>
                    <td>
                      {whenLabel(s)}
                      <div className="vx-muted">{s.timezone}</div>
                    </td>
                    <td className="vx-tabular">
                      {s.startDate || s.endDate ? `${s.startDate ?? '…'} → ${s.endDate ?? '…'}` : t('schedules.noEnd')}
                    </td>
                    <td className="vx-tabular">{s.priority}</td>
                    <td>
                      <StatusChip tone={s.enabled ? 'success' : 'neutral'}>{s.enabled ? t('schedules.enabled') : t('schedules.disabled')}</StatusChip>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="vx-toolbar" style={{ alignItems: 'center' }}>
            <span className="vx-field__label">{t('schedules.showFor')}</span>
            <select className="vx-input" style={{ width: 'auto' }} aria-label={t('schedules.showFor')} value={targetFilter} onChange={(e) => setTargetFilter(e.target.value)}>
              {filterOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          {conflicts.length ? (
            <Alert tone="warning" title={t('schedules.conflictsTitle')}>
              <ul className="plain-list">
                {conflicts.map((c) => (
                  <li key={`${c.a}|${c.b}`}>
                    <TriangleAlert size={14} aria-hidden />{' '}
                    {t('schedules.conflict', { a: scheduleName(c.a), b: scheduleName(c.b), at: formatDateTime(c.at) })}
                  </li>
                ))}
              </ul>
            </Alert>
          ) : null}

          <Card title={t('schedules.weekTitle')}>
            <WeekView weekStart={weekStart} schedules={enabled} playlistName={(id) => playlistById.get(id)?.name ?? '—'} />
          </Card>

          <Card title={t('schedules.testTitle')}>
            <div className="vx-form__row">
              <TextField label={t('schedules.testAt')} type="datetime-local" value={testAt} onChange={(e) => setTestAt(e.target.value)} />
              <div className="vx-field">
                <span className="vx-field__label">{t('schedules.result')}</span>
                <div className="test-result" aria-live="polite">
                  {resolution.playlistId ? (
                    <>
                      <strong>{playlistById.get(resolution.playlistId)?.name ?? '—'}</strong>
                      <span className="vx-muted">{t('schedules.byRule', { name: scheduleName(resolution.ruleId ?? '') })}</span>
                    </>
                  ) : (
                    <span className="vx-muted">{t('schedules.nothing')}</span>
                  )}
                </div>
              </div>
            </div>
            <p className="vx-muted" style={{ marginBottom: 0 }}>{t('schedules.testHint')}</p>
          </Card>
        </div>
      )}

      {editing ? (
        <ScheduleDialog
          schedule={editing === 'new' ? null : editing}
          playlists={playlists.data}
          sites={sites.data}
          groups={groups.data}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </>
  );
}

/** One week grid with a block per active window; overnight windows are split at midnight. */
function WeekView({ weekStart, schedules, playlistName }: { weekStart: number; schedules: ScheduleDoc[]; playlistName: (id: string) => string }) {
  const { t } = useTranslation();
  const days = DAYS.map((_, i) => weekStart + i * 86_400_000);
  // Sample each day every 15 minutes and merge runs into blocks (handles time zones and overnight).
  const blocks = days.map((dayStart) =>
    schedules.flatMap((s) => {
      const rule = toRule(s);
      const out: Array<{ from: number; to: number }> = [];
      let open: number | null = null;
      for (let m = 0; m <= 96; m++) {
        const active = m < 96 && ruleActiveAt(rule, dayStart + m * 15 * 60_000);
        if (active && open === null) open = m;
        if (!active && open !== null) {
          out.push({ from: open, to: m });
          open = null;
        }
      }
      return out.map((b) => ({ ...b, schedule: s }));
    }),
  );

  return (
    <div className="week">
      <div className="week__hours" aria-hidden>
        {[0, 6, 12, 18, 24].map((h) => (
          <span key={h} style={{ top: `${(h / 24) * 100}%` }}>
            {String(h).padStart(2, '0')}:00
          </span>
        ))}
      </div>
      {days.map((d, i) => {
        const parts = localParts(d, Intl.DateTimeFormat().resolvedOptions().timeZone);
        return (
          <div key={d} className="week__day">
            <div className="week__head">
              {t(`schedules.days.${DAYS[i]}`)} <span className="vx-muted">{parts.date.slice(8)}</span>
            </div>
            <div className="week__col">
              {blocks[i]!.map((b, k) => (
                <div
                  key={k}
                  className="week__block"
                  style={{
                    top: `${(b.from / 96) * 100}%`,
                    height: `${((b.to - b.from) / 96) * 100}%`,
                    opacity: 0.55 + Math.min(0.45, b.schedule.priority / 220),
                  }}
                  title={`${b.schedule.name} · ${playlistName(b.schedule.playlistId)} · P${b.schedule.priority}`}
                >
                  <span>{b.schedule.name}</span>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ScheduleDialog({
  schedule,
  playlists,
  sites,
  groups,
  onClose,
}: {
  schedule: ScheduleDoc | null;
  playlists: Array<{ id: string; name: string }>;
  sites: Array<{ id: string; name: string }>;
  groups: Array<{ id: string; name: string }>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { orgId, org } = useOrg();
  const timezones = useMemo(timezoneOptions, []);
  const [form, setForm] = useState(() => ({
    name: schedule?.name ?? '',
    playlistId: schedule?.playlistId ?? playlists[0]?.id ?? '',
    targetKind: (schedule?.target.kind ?? 'all') as ScheduleTarget['kind'],
    targetIds: schedule && schedule.target.kind !== 'all' ? schedule.target.ids : ([] as string[]),
    priority: schedule?.priority ?? 10,
    timezone: schedule?.timezone ?? org?.timezone ?? 'Asia/Kolkata',
    startDate: schedule?.startDate ?? '',
    endDate: schedule?.endDate ?? '',
    daysOfWeek: schedule?.daysOfWeek ?? [],
    allDay: !schedule?.windowStart,
    windowStart: schedule?.windowStart ?? '09:00',
    windowEnd: schedule?.windowEnd ?? '18:00',
    enabled: schedule?.enabled ?? true,
  }));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));
  const targetChoices = form.targetKind === 'sites' ? sites : form.targetKind === 'groups' ? groups : [];

  async function save() {
    const input = {
      orgId,
      ...(schedule ? { scheduleId: schedule.id } : {}),
      name: form.name,
      playlistId: form.playlistId,
      target: form.targetKind === 'all' ? { kind: 'all' } : { kind: form.targetKind, ids: form.targetIds },
      priority: Number(form.priority),
      timezone: form.timezone,
      startDate: form.startDate || null,
      endDate: form.endDate || null,
      daysOfWeek: form.daysOfWeek,
      windowStart: form.allDay ? null : form.windowStart,
      windowEnd: form.allDay ? null : form.windowEnd,
      enabled: form.enabled,
    };
    const parsed = SaveScheduleInput.safeParse(input);
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error.issues));
      return;
    }
    setErrors({});
    setBusy(true);
    setError(null);
    try {
      await call('saveSchedule', parsed.data);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  async function remove() {
    if (!schedule) return;
    setBusy(true);
    try {
      await call('deleteSchedule', { orgId, scheduleId: schedule.id });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      title={schedule ? t('schedules.edit') : t('schedules.new')}
      size="lg"
      onClose={onClose}
      footer={
        confirmDelete ? (
          <>
            <Button onClick={() => setConfirmDelete(false)}>{t('common.cancel')}</Button>
            <Button variant="danger" disabled={busy} onClick={() => void remove()}>{t('schedules.deleteConfirm')}</Button>
          </>
        ) : (
          <>
            {schedule ? <Button variant="tertiary" onClick={() => setConfirmDelete(true)}>{t('common.delete')}</Button> : null}
            <Button onClick={onClose}>{t('common.cancel')}</Button>
            <Button variant="primary" disabled={busy} onClick={() => void save()}>{t('common.save')}</Button>
          </>
        )
      }
    >
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <TextField label={t('schedules.name')} required value={form.name} error={errors.name} maxLength={120} onChange={(e) => set('name', e.target.value)} />
      <SelectField
        label={t('schedules.playlist')}
        required
        options={playlists.map((p) => ({ value: p.id, label: p.name }))}
        value={form.playlistId}
        error={errors.playlistId}
        onChange={(e) => set('playlistId', e.target.value)}
      />
      <SelectField
        label={t('schedules.target')}
        options={[
          { value: 'all', label: t('schedules.allScreens') },
          { value: 'sites', label: t('schedules.someSites') },
          { value: 'groups', label: t('schedules.someGroups') },
        ]}
        value={form.targetKind}
        onChange={(e) => {
          set('targetKind', e.target.value as ScheduleTarget['kind']);
          set('targetIds', []);
        }}
      />
      {form.targetKind !== 'all' ? (
        <fieldset className="check-group">
          <legend className="vx-field__label">{form.targetKind === 'sites' ? t('schedules.chooseSites') : t('schedules.chooseGroups')}</legend>
          {targetChoices.length === 0 ? <span className="vx-muted">{t('schedules.noTargets')}</span> : null}
          {targetChoices.map((c) => (
            <label key={c.id} className="checkbox-row">
              <input
                type="checkbox"
                checked={form.targetIds.includes(c.id)}
                onChange={(e) => set('targetIds', e.target.checked ? [...form.targetIds, c.id] : form.targetIds.filter((x) => x !== c.id))}
              />
              {c.name}
            </label>
          ))}
          {errors['target.ids'] ? <p className="vx-field__error">{t('schedules.pickTarget')}</p> : null}
        </fieldset>
      ) : null}
      <fieldset className="check-group check-group--row">
        <legend className="vx-field__label">{t('schedules.daysLabel')}</legend>
        {DAYS.map((d) => (
          <label key={d} className="day-chip">
            <input
              type="checkbox"
              checked={form.daysOfWeek.includes(d)}
              onChange={(e) => set('daysOfWeek', e.target.checked ? [...form.daysOfWeek, d] : form.daysOfWeek.filter((x) => x !== d))}
            />
            <span>{t(`schedules.days.${d}`)}</span>
          </label>
        ))}
        <span className="vx-field__hint">{t('schedules.daysHint')}</span>
      </fieldset>
      <label className="checkbox-row">
        <input type="checkbox" checked={form.allDay} onChange={(e) => set('allDay', e.target.checked)} />
        {t('schedules.allDay')}
      </label>
      {!form.allDay ? (
        <div className="vx-form__row">
          <TextField label={t('schedules.from')} type="time" value={form.windowStart} error={errors.windowStart} onChange={(e) => set('windowStart', e.target.value)} />
          <TextField label={t('schedules.to')} type="time" value={form.windowEnd} error={errors.windowEnd} hint={t('schedules.overnightHint')} onChange={(e) => set('windowEnd', e.target.value)} />
        </div>
      ) : null}
      <div className="vx-form__row">
        <TextField label={t('schedules.startDate')} type="date" value={form.startDate} error={errors.startDate} onChange={(e) => set('startDate', e.target.value)} />
        <TextField label={t('schedules.endDate')} type="date" value={form.endDate} error={errors.endDate} onChange={(e) => set('endDate', e.target.value)} />
      </div>
      <div className="vx-form__row">
        <TextField
          label={t('schedules.priority')}
          type="number"
          min={0}
          max={100}
          hint={t('schedules.priorityHint')}
          value={form.priority}
          error={errors.priority}
          onChange={(e) => set('priority', Number(e.target.value))}
        />
        <SelectField label={t('schedules.timezone')} options={timezones} value={form.timezone} onChange={(e) => set('timezone', e.target.value)} />
      </div>
      <label className="checkbox-row">
        <input type="checkbox" checked={form.enabled} onChange={(e) => set('enabled', e.target.checked)} />
        {t('schedules.enabledLabel')}
      </label>
    </Dialog>
  );
}

function startOfWeek(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  const diff = (d.getDay() + 6) % 7; // Monday = 0
  d.setDate(d.getDate() - diff);
  return d.getTime();
}

function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
