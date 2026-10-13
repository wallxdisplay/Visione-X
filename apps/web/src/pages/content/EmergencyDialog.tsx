import { Alert, Button, Dialog, SelectField, TextAreaField, TextField } from '@wallx-play/ui';
import { EMERGENCY_CONFIRM_PHRASE, TriggerEmergencyInput, type ScreenDoc } from '@wallx-play/shared';
import { Siren } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePlaylists, useScreenGroups, useSites } from '../../content/data';
import { call, errorMessage } from '../../lib/api';
import { fieldErrors } from '../../lib/format';
import { useOrg } from '../../org/OrgProvider';

const DURATIONS = [15, 60, 240, 1440];

/**
 * Deliberately heavier than a normal form: the user picks content, target and duration, sees
 * the impact, and must type the confirmation phrase.
 */
export function EmergencyDialog({ screens, onClose }: { screens: ScreenDoc[]; onClose: () => void }) {
  const { t } = useTranslation();
  const { orgId } = useOrg();
  const playlists = usePlaylists(orgId);
  const sites = useSites(orgId);
  const groups = useScreenGroups(orgId);
  const [name, setName] = useState('');
  const [contentKind, setContentKind] = useState<'message' | 'playlist'>('message');
  const [text, setText] = useState('');
  const [background, setBackground] = useState('#B91C1C');
  const [playlistId, setPlaylistId] = useState('');
  const [targetKind, setTargetKind] = useState<'all' | 'sites' | 'groups' | 'screens'>('all');
  const [ids, setIds] = useState<string[]>([]);
  const [duration, setDuration] = useState<string>('60');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const authorized = screens.filter((s) => s.status === 'authorized');
  const choices =
    targetKind === 'sites'
      ? sites.data.map((s) => ({ id: s.id, name: s.name }))
      : targetKind === 'groups'
        ? groups.data.map((g) => ({ id: g.id, name: g.name }))
        : authorized.map((s) => ({ id: s.id, name: s.name }));
  const affected =
    targetKind === 'all'
      ? authorized.length
      : authorized.filter((s) =>
          targetKind === 'sites'
            ? !!s.siteId && ids.includes(s.siteId)
            : targetKind === 'groups'
              ? s.groupIds.some((g) => ids.includes(g))
              : ids.includes(s.id),
        ).length;

  async function start() {
    const input = {
      orgId,
      name,
      content: contentKind === 'message' ? { kind: 'message', text, background, color: '#FFFFFF' } : { kind: 'playlist', playlistId },
      target: targetKind === 'all' ? { kind: 'all' } : { kind: targetKind, ids },
      durationMinutes: duration === 'manual' ? null : Number(duration),
      confirm,
    };
    const parsed = TriggerEmergencyInput.safeParse(input);
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error.issues));
      return;
    }
    setErrors({});
    setBusy(true);
    setError(null);
    try {
      await call('triggerEmergency', parsed.data);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      size="lg"
      title={
        <span className="danger-title">
          <Siren size={18} aria-hidden /> {t('emergency.title')}
        </span>
      }
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="danger" disabled={busy || confirm !== EMERGENCY_CONFIRM_PHRASE || affected === 0} onClick={() => void start()}>
            {t('emergency.start', { count: affected })}
          </Button>
        </>
      }
    >
      <Alert tone="warning">{t('emergency.intro')}</Alert>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <TextField label={t('emergency.name')} required value={name} error={errors.name} maxLength={80} placeholder={t('emergency.namePlaceholder')} onChange={(e) => setName(e.target.value)} />
      <SelectField
        label={t('emergency.content')}
        options={[
          { value: 'message', label: t('emergency.contentMessage') },
          { value: 'playlist', label: t('emergency.contentPlaylist') },
        ]}
        value={contentKind}
        onChange={(e) => setContentKind(e.target.value as 'message' | 'playlist')}
      />
      {contentKind === 'message' ? (
        <>
          <TextAreaField label={t('emergency.message')} required value={text} maxLength={500} error={errors['content.text']} hint={t('emergency.messageHint')} onChange={(e) => setText(e.target.value)} />
          <label className="wxp-field">
            <span className="wxp-field__label">{t('studio.background')}</span>
            <input type="color" className="color-input" value={background} onChange={(e) => setBackground(e.target.value.toUpperCase())} />
          </label>
          {text.trim() ? (
            <div className="emergency-preview" style={{ background }}>
              {text}
            </div>
          ) : null}
        </>
      ) : (
        <SelectField
          label={t('schedules.playlist')}
          options={[{ value: '', label: t('studio.choosePlaylist') }, ...playlists.data.map((p) => ({ value: p.id, label: p.name }))]}
          value={playlistId}
          error={errors['content.playlistId']}
          onChange={(e) => setPlaylistId(e.target.value)}
        />
      )}
      <SelectField
        label={t('emergency.target')}
        options={[
          { value: 'all', label: t('schedules.allScreens') },
          { value: 'sites', label: t('schedules.someSites') },
          { value: 'groups', label: t('schedules.someGroups') },
          { value: 'screens', label: t('emergency.someScreens') },
        ]}
        value={targetKind}
        onChange={(e) => {
          setTargetKind(e.target.value as typeof targetKind);
          setIds([]);
        }}
      />
      {targetKind !== 'all' ? (
        <fieldset className="check-group check-group--row">
          <legend className="wxp-field__label">{t('emergency.choose')}</legend>
          {choices.map((c) => (
            <label key={c.id} className="day-chip">
              <input type="checkbox" checked={ids.includes(c.id)} onChange={(e) => setIds(e.target.checked ? [...ids, c.id] : ids.filter((x) => x !== c.id))} />
              <span>{c.name}</span>
            </label>
          ))}
        </fieldset>
      ) : null}
      <SelectField
        label={t('emergency.duration')}
        options={[
          ...DURATIONS.map((m) => ({ value: String(m), label: t(`emergency.durations.${m}`) })),
          { value: 'manual', label: t('emergency.untilEnded') },
        ]}
        value={duration}
        onChange={(e) => setDuration(e.target.value)}
      />
      <p className="emergency-impact">{t('emergency.impact', { count: affected })}</p>
      <TextField
        label={t('emergency.confirmLabel', { phrase: EMERGENCY_CONFIRM_PHRASE })}
        value={confirm}
        autoComplete="off"
        onChange={(e) => setConfirm(e.target.value.toUpperCase())}
      />
    </Dialog>
  );
}
