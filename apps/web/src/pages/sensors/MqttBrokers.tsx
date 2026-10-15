import { Alert, Button, Dialog, SelectField, StatusChip, TextField } from '@wallx-play/ui';
import { MAX_MQTT_BROKERS, SaveMqttBrokerInput, type MqttBrokerDoc, type ScreenDoc } from '@wallx-play/shared';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useScreens } from '../../content/data';
import { useMqttBrokers } from '../../content/sensors';
import { call, errorMessage } from '../../lib/api';
import { fieldErrors, formatDateTime } from '../../lib/format';
import { useOrg } from '../../org/OrgProvider';

type Tone = 'success' | 'danger' | 'warning' | 'neutral';

/** Connection state as the bridge screen last reported it. */
export function brokerState(b: MqttBrokerDoc, screens: ScreenDoc[]): { key: string; tone: Tone; error: string | null; lastMessageAt: number | null } {
  const screen = screens.find((s) => s.id === b.bridgeScreenId);
  if (!screen) return { key: 'noBridge', tone: 'danger', error: null, lastMessageAt: null };
  const report = screen.health?.mqtt?.find((m) => m.brokerId === b.id);
  if (!report) return { key: 'waiting', tone: 'neutral', error: null, lastMessageAt: null };
  const tone: Tone = report.state === 'connected' ? 'success' : report.state === 'error' ? 'danger' : 'warning';
  return { key: report.state, tone, error: report.error ?? null, lastMessageAt: report.lastMessageAt ?? null };
}

/** MQTT brokers of the org, each read through one of its screens (the bridge). */
export function MqttBrokersSection() {
  const { t } = useTranslation();
  const { orgId, can, siteScope } = useOrg();
  const brokers = useMqttBrokers(orgId);
  const screens = useScreens(orgId, siteScope);
  const manage = can('sensor.manage');
  const [editing, setEditing] = useState<MqttBrokerDoc | 'new' | null>(null);
  const [deleting, setDeleting] = useState<MqttBrokerDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function remove() {
    if (!deleting) return;
    setBusy(true);
    setError(null);
    try {
      await call('deleteMqttBroker', { orgId, brokerId: deleting.id });
      setDeleting(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mqtt-section">
      <div className="section-head">
        <h2 className="section-title">{t('mqtt.title')}</h2>
        {manage ? (
          <Button size="sm" disabled={brokers.data.length >= MAX_MQTT_BROKERS} onClick={() => setEditing('new')}>
            <Plus size={14} aria-hidden /> {t('mqtt.add')}
          </Button>
        ) : null}
      </div>
      <p className="wxp-muted">{t('mqtt.description')}</p>
      {brokers.data.length ? (
        <div className="wxp-table-wrap">
          <table className="wxp-table">
            <thead>
              <tr>
                <th>{t('mqtt.name')}</th>
                <th>{t('mqtt.address')}</th>
                <th>{t('mqtt.bridge')}</th>
                <th>{t('mqtt.status')}</th>
                <th>{t('mqtt.lastMessage')}</th>
                {manage ? <th aria-label={t('common.actions')} /> : null}
              </tr>
            </thead>
            <tbody>
              {brokers.data.map((b) => {
                const s = brokerState(b, screens.data);
                return (
                  <tr key={b.id}>
                    <td>{b.name}</td>
                    <td>
                      <code>
                        {b.tls ? 'mqtts' : 'mqtt'}://{b.host}:{b.port}
                      </code>
                    </td>
                    <td>{screens.data.find((x) => x.id === b.bridgeScreenId)?.name ?? '—'}</td>
                    <td>
                      <StatusChip tone={s.tone}>{t(`mqtt.states.${s.key}`)}</StatusChip>
                      {s.error ? <div className="wxp-field__hint mqtt-error">{s.error}</div> : null}
                    </td>
                    <td>{formatDateTime(s.lastMessageAt)}</td>
                    {manage ? (
                      <td className="wxp-actions">
                        <Button size="sm" variant="tertiary" aria-label={t('common.edit')} onClick={() => setEditing(b)}>
                          <Pencil size={14} aria-hidden />
                        </Button>
                        <Button size="sm" variant="tertiary" aria-label={t('common.delete')} onClick={() => setDeleting(b)}>
                          <Trash2 size={14} aria-hidden />
                        </Button>
                      </td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : !brokers.loading ? (
        <p className="wxp-muted">{t('mqtt.empty')}</p>
      ) : null}

      <MqttBrokerDialog open={editing !== null} broker={editing === 'new' ? null : editing} screens={screens.data} onClose={() => setEditing(null)} />
      <Dialog
        open={!!deleting}
        title={t('mqtt.deleteTitle')}
        onClose={() => setDeleting(null)}
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
        <p>{t('mqtt.deleteBody', { name: deleting?.name ?? '' })}</p>
      </Dialog>
    </section>
  );
}

interface BrokerForm {
  name: string;
  host: string;
  port: string;
  tls: boolean;
  username: string;
  password: string;
  removePassword: boolean;
  bridgeScreenId: string;
}

function MqttBrokerDialog({ open, broker, screens, onClose }: { open: boolean; broker: MqttBrokerDoc | null; screens: ScreenDoc[]; onClose: () => void }) {
  const { t } = useTranslation();
  const { orgId } = useOrg();
  const [form, setForm] = useState<BrokerForm | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const bridges = screens.filter((s) => s.status === 'authorized');

  useEffect(() => {
    if (!open) return;
    setErrors({});
    setError(null);
    setForm({
      name: broker?.name ?? '',
      host: broker?.host ?? '',
      port: String(broker?.port ?? 1883),
      tls: broker?.tls ?? false,
      username: broker?.username ?? '',
      password: '',
      removePassword: false,
      bridgeScreenId: broker?.bridgeScreenId ?? bridges[0]?.id ?? '',
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset only when the dialog opens
  }, [open, broker]);

  if (!form) return null;
  const set = <K extends keyof BrokerForm>(k: K, v: BrokerForm[K]) => setForm((f) => f && { ...f, [k]: v });

  async function save() {
    if (!form) return;
    const parsed = SaveMqttBrokerInput.safeParse({
      orgId,
      ...(broker ? { brokerId: broker.id } : {}),
      name: form.name,
      host: form.host,
      port: Number(form.port),
      tls: form.tls,
      username: form.username.trim() || null,
      // Empty keeps the stored password; "remove" clears it.
      ...(form.removePassword ? { password: null } : form.password ? { password: form.password } : {}),
      bridgeScreenId: form.bridgeScreenId,
    });
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error.issues));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await call('saveMqttBroker', parsed.data);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      size="lg"
      title={broker ? t('mqtt.edit') : t('mqtt.add')}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={busy || !form.name.trim() || !form.host.trim() || !form.bridgeScreenId} onClick={() => void save()}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <Alert tone="info">{t('mqtt.howItWorks')}</Alert>
      <TextField label={t('mqtt.name')} required maxLength={80} value={form.name} error={errors.name} onChange={(e) => set('name', e.target.value)} />
      <div className="wxp-form__row">
        <TextField label={t('mqtt.host')} hint={t('mqtt.hostHint')} required maxLength={253} value={form.host} error={errors.host} onChange={(e) => set('host', e.target.value.trim())} />
        <TextField label={t('mqtt.port')} type="number" min={1} max={65535} value={form.port} error={errors.port} onChange={(e) => set('port', e.target.value)} />
      </div>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={form.tls}
          onChange={(e) => {
            const tls = e.target.checked;
            // Switch the default port along with TLS (a custom port stays).
            setForm((f) => f && { ...f, tls, port: f.port === (f.tls ? '8883' : '1883') ? (tls ? '8883' : '1883') : f.port });
          }}
        />
        {t('mqtt.tls')}
      </label>
      <div className="wxp-form__row">
        <TextField label={t('mqtt.username')} maxLength={200} autoComplete="off" value={form.username} onChange={(e) => set('username', e.target.value)} />
        <TextField
          label={t('mqtt.password')}
          hint={broker?.hasPassword ? t('mqtt.passwordKeep') : t('mqtt.passwordHint')}
          type="password"
          autoComplete="new-password"
          maxLength={500}
          disabled={form.removePassword}
          value={form.password}
          onChange={(e) => set('password', e.target.value)}
        />
      </div>
      {broker?.hasPassword ? (
        <label className="checkbox-row">
          <input type="checkbox" checked={form.removePassword} onChange={(e) => { const removePassword = e.target.checked; setForm((f) => f && { ...f, removePassword, password: '' }); }} />
          {t('mqtt.removePassword')}
        </label>
      ) : null}
      <SelectField
        label={t('mqtt.bridge')}
        hint={t('mqtt.bridgeHint')}
        required
        options={bridges.length ? bridges.map((s) => ({ value: s.id, label: s.name })) : [{ value: '', label: t('mqtt.noScreens') }]}
        value={form.bridgeScreenId}
        error={errors.bridgeScreenId}
        onChange={(e) => set('bridgeScreenId', e.target.value)}
      />
    </Dialog>
  );
}
