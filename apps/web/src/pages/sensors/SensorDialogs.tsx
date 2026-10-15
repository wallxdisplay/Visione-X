import { Alert, Button, Dialog, SelectField, TextField } from '@wallx-play/ui';
import {
  ALERT_OPERATORS,
  ALERT_SEVERITIES,
  DEFAULT_SENSOR_OFFLINE_MIN,
  DEFAULT_STALE_AFTER_SEC,
  SaveSensorChannelInput,
  type AlertRule,
  type SensorChannelDoc,
  type SensorDeviceDoc,
} from '@wallx-play/shared';
import { Check, Copy, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSites } from '../../content/data';
import { useMqttBrokers } from '../../content/sensors';
import { newId } from '../../content/data';
import { call, errorMessage } from '../../lib/api';
import { fieldErrors } from '../../lib/format';
import { useOrg } from '../../org/OrgProvider';

export const ingestUrl = () => `${window.location.origin}/api/v1/ingest`;

/** Create or edit a sensor device. Creating returns the API key (shown once by the caller). */
export function SensorDeviceDialog({
  open,
  device,
  onClose,
  onSaved,
}: {
  open: boolean;
  device: SensorDeviceDoc | null;
  onClose: () => void;
  onSaved: (result: { sensorDeviceId: string; apiKey?: string }, name: string) => void;
}) {
  const { t } = useTranslation();
  const { orgId, entitlements } = useOrg();
  const sites = useSites(orgId);
  const mqttOn = !!entitlements?.features.includes('sensor.mqtt');
  const brokers = useMqttBrokers(orgId, mqttOn);
  const blank = { name: '', siteId: '', offlineAfterMin: String(DEFAULT_SENSOR_OFFLINE_MIN), enabled: true, transport: 'http' as 'http' | 'mqtt', mqttBrokerId: '' };
  const [form, setForm] = useState(blank);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setForm(
      device
        ? {
            name: device.name,
            siteId: device.siteId ?? '',
            offlineAfterMin: String(device.offlineAfterMin),
            enabled: device.status === 'active',
            transport: device.transport ?? 'http',
            mqttBrokerId: device.mqttBrokerId ?? '',
          }
        : blank,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset only when the dialog opens
  }, [open, device]);
  const mqtt = form.transport === 'mqtt';

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const result = await call<{ sensorDeviceId: string; apiKey?: string }>('saveSensorDevice', {
        orgId,
        ...(device ? { sensorDeviceId: device.id } : {}),
        name: form.name,
        siteId: form.siteId || null,
        offlineAfterMin: Number(form.offlineAfterMin),
        enabled: form.enabled,
        transport: form.transport,
        mqttBrokerId: mqtt ? form.mqttBrokerId || null : null,
      });
      onSaved(result, form.name);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const minutes = Number(form.offlineAfterMin);
  const minutesOk = Number.isInteger(minutes) && minutes >= 2 && minutes <= 1440;
  return (
    <Dialog
      open={open}
      title={device ? t('sensors.edit') : t('sensors.add')}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={busy || !form.name.trim() || !minutesOk || (mqtt && !form.mqttBrokerId)} onClick={() => void save()}>
            {device ? t('common.save') : mqtt ? t('sensors.createMqtt') : t('sensors.create')}
          </Button>
        </>
      }
    >
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <TextField label={t('sensors.name')} required maxLength={80} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      {mqttOn && !device ? (
        <SelectField
          label={t('sensors.transport')}
          options={[
            { value: 'http', label: t('sensors.transports.http') },
            { value: 'mqtt', label: t('sensors.transports.mqtt') },
          ]}
          value={form.transport}
          onChange={(e) => setForm({ ...form, transport: e.target.value as 'http' | 'mqtt', mqttBrokerId: form.mqttBrokerId || brokers.data[0]?.id || '' })}
        />
      ) : null}
      {mqtt ? (
        <SelectField
          label={t('sensors.broker')}
          hint={brokers.data.length ? t('sensors.brokerHint') : t('sensors.noBrokers')}
          options={brokers.data.length ? brokers.data.map((b) => ({ value: b.id, label: b.name })) : [{ value: '', label: '—' }]}
          value={form.mqttBrokerId}
          onChange={(e) => setForm({ ...form, mqttBrokerId: e.target.value })}
        />
      ) : null}
      <SelectField
        label={t('sensors.site')}
        options={[{ value: '', label: t('sensors.noSite') }, ...sites.data.map((s) => ({ value: s.id, label: s.name }))]}
        value={form.siteId}
        onChange={(e) => setForm({ ...form, siteId: e.target.value })}
      />
      <TextField
        label={t('sensors.offlineAfter')}
        hint={t('sensors.offlineAfterHint')}
        type="number"
        min={2}
        max={1440}
        value={form.offlineAfterMin}
        error={minutesOk ? undefined : t('sensors.offlineAfterError')}
        onChange={(e) => setForm({ ...form, offlineAfterMin: e.target.value })}
      />
      {device ? (
        <label className="checkbox-row">
          <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
          {t('sensors.enabled')}
        </label>
      ) : null}
    </Dialog>
  );
}

function CopyButton({ text }: { text: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      onClick={() =>
        void navigator.clipboard.writeText(text).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          },
          () => undefined,
        )
      }
    >
      {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />} {copied ? t('sensors.copied') : t('sensors.copy')}
    </Button>
  );
}

/** Shows a freshly issued API key once, with the endpoint and an example request. */
export function ApiKeyDialog({ value, onClose }: { value: { name: string; apiKey: string } | null; onClose: () => void }) {
  const { t } = useTranslation();
  const example = value
    ? `curl -X POST ${ingestUrl()} \\\n  -H "Authorization: Bearer ${value.apiKey}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"readings":[{"channel":"temp","value":4.2}]}'`
    : '';
  return (
    <Dialog
      open={!!value}
      size="lg"
      title={t('sensors.keyTitle', { name: value?.name ?? '' })}
      onClose={onClose}
      footer={
        <Button variant="primary" onClick={onClose}>
          {t('sensors.keySaved')}
        </Button>
      }
    >
      <Alert tone="warning">{t('sensors.keyOnce')}</Alert>
      <div className="key-box">
        <code className="key-box__value">{value?.apiKey}</code>
        {value ? <CopyButton text={value.apiKey} /> : null}
      </div>
      <dl className="wxp-dl">
        <dt>{t('sensors.endpoint')}</dt>
        <dd>
          <code>{ingestUrl()}</code>
        </dd>
      </dl>
      <p className="wxp-muted">{t('sensors.keyHelp')}</p>
      <pre className="code-block">{example}</pre>
    </Dialog>
  );
}

interface ChannelForm {
  topic: string;
  path: string;
  channelId: string;
  name: string;
  unit: string;
  valueType: 'number' | 'boolean';
  min: string;
  max: string;
  staleAfterMin: string;
  alertRules: AlertRule[];
}

const num = (s: string) => (s.trim() === '' ? null : Number(s));

export function ChannelDialog({
  open,
  sensorDeviceId,
  channel,
  mqtt = false,
  onClose,
}: {
  open: boolean;
  sensorDeviceId: string;
  channel: SensorChannelDoc | null;
  /** The device reads from an MQTT broker: ask for the topic (and JSON field). */
  mqtt?: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { orgId } = useOrg();
  const [form, setForm] = useState<ChannelForm | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setErrors({});
    setError(null);
    setForm(
      channel
        ? {
            channelId: channel.id,
            name: channel.name,
            unit: channel.unit,
            valueType: channel.valueType,
            min: channel.min === null ? '' : String(channel.min),
            max: channel.max === null ? '' : String(channel.max),
            staleAfterMin: String(Math.round(channel.staleAfterSec / 60)),
            alertRules: channel.alertRules,
            topic: channel.mqtt?.topic ?? '',
            path: channel.mqtt?.path ?? '',
          }
        : { topic: '', path: '', channelId: '', name: '', unit: '', valueType: 'number', min: '', max: '', staleAfterMin: String(DEFAULT_STALE_AFTER_SEC / 60), alertRules: [] },
    );
  }, [open, channel]);

  if (!form) return null;
  const setRule = (i: number, patch: Partial<AlertRule>) =>
    setForm({ ...form, alertRules: form.alertRules.map((r, j) => (j === i ? { ...r, ...patch } : r)) });

  async function save() {
    if (!form) return;
    const input = {
      orgId,
      sensorDeviceId,
      channelId: form.channelId,
      isNew: !channel,
      name: form.name,
      unit: form.unit,
      valueType: form.valueType,
      min: form.valueType === 'number' ? num(form.min) : null,
      max: form.valueType === 'number' ? num(form.max) : null,
      staleAfterSec: Math.round(Number(form.staleAfterMin) * 60),
      alertRules: form.alertRules,
      mqtt: mqtt ? { topic: form.topic, path: form.path.trim() || null } : null,
    };
    const parsed = SaveSensorChannelInput.safeParse(input);
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error.issues));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await call('saveSensorChannel', parsed.data);
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
      title={channel ? t('channels.edit') : t('channels.add')}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={busy} onClick={() => void save()}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {mqtt ? (
        <div className="wxp-form__row">
          <TextField
            label={t('channels.topic')}
            hint={t('channels.topicHint')}
            required
            maxLength={200}
            value={form.topic}
            error={errors['mqtt.topic'] ?? errors.mqtt}
            onChange={(e) => setForm({ ...form, topic: e.target.value })}
          />
          <TextField
            label={t('channels.jsonField')}
            hint={t('channels.jsonFieldHint')}
            maxLength={100}
            value={form.path}
            error={errors['mqtt.path']}
            onChange={(e) => setForm({ ...form, path: e.target.value })}
          />
        </div>
      ) : null}
      <div className="wxp-form__row">
        <TextField
          label={t('channels.key')}
          hint={mqtt ? t('channels.keyHintMqtt') : t('channels.keyHint')}
          required
          disabled={!!channel}
          maxLength={32}
          value={form.channelId}
          error={errors.channelId}
          onChange={(e) => setForm({ ...form, channelId: e.target.value.toLowerCase() })}
        />
        <TextField label={t('channels.name')} required maxLength={60} value={form.name} error={errors.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </div>
      <div className="wxp-form__row">
        <SelectField
          label={t('channels.type')}
          options={['number', 'boolean'].map((v) => ({ value: v, label: t(`channels.types.${v}`) }))}
          value={form.valueType}
          onChange={(e) => setForm({ ...form, valueType: e.target.value as 'number' | 'boolean' })}
        />
        <TextField label={t('channels.unit')} maxLength={16} value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} />
      </div>
      {form.valueType === 'number' ? (
        <div className="wxp-form__row">
          <TextField label={t('channels.min')} hint={t('channels.rangeHint')} type="number" step="any" value={form.min} onChange={(e) => setForm({ ...form, min: e.target.value })} />
          <TextField label={t('channels.max')} type="number" step="any" value={form.max} error={errors.max} onChange={(e) => setForm({ ...form, max: e.target.value })} />
        </div>
      ) : null}
      <TextField
        label={t('channels.staleAfter')}
        hint={t('channels.staleAfterHint')}
        type="number"
        min={1}
        value={form.staleAfterMin}
        error={errors.staleAfterSec}
        onChange={(e) => setForm({ ...form, staleAfterMin: e.target.value })}
      />

      <fieldset className="rule-list">
        <legend className="wxp-field__label">{t('channels.rules')}</legend>
        <p className="wxp-muted">{form.valueType === 'boolean' ? t('channels.rulesHintBoolean') : t('channels.rulesHint')}</p>
        {errors.alertRules ? <p className="wxp-field__error">{errors.alertRules}</p> : null}
        {form.alertRules.length ? (
          <div className="rule-row rule-row--head" aria-hidden>
            <span>{t('channels.ruleName')}</span>
            <span>{t('channels.operator')}</span>
            <span>{t('channels.limit')}</span>
            <span>{t('channels.severity')}</span>
            <span>{t('channels.hysteresis')}</span>
            <span />
          </div>
        ) : null}
        {form.alertRules.map((r, i) => (
          <div key={r.id} className="rule-row">
            <input aria-label={t('channels.ruleLabel')} className="wxp-input" placeholder={t('channels.ruleLabel')} maxLength={60} value={r.label} onChange={(e) => setRule(i, { label: e.target.value })} />
            <select aria-label={t('channels.operator')} className="wxp-input rule-row__op" value={r.operator} onChange={(e) => setRule(i, { operator: e.target.value as AlertRule['operator'] })}>
              {ALERT_OPERATORS.map((op) => (
                <option key={op} value={op}>
                  {op}
                </option>
              ))}
            </select>
            <input aria-label={t('channels.limit')} className="wxp-input rule-row__num" type="number" step="any" value={r.value} onChange={(e) => setRule(i, { value: Number(e.target.value) })} />
            <select aria-label={t('channels.severity')} className="wxp-input" value={r.severity} onChange={(e) => setRule(i, { severity: e.target.value as AlertRule['severity'] })}>
              {ALERT_SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {t(`alerts.severity.${s}`)}
                </option>
              ))}
            </select>
            <input
              aria-label={t('channels.hysteresis')}
              title={t('channels.hysteresisHint')}
              placeholder={t('channels.hysteresis')}
              className="wxp-input rule-row__num"
              type="number"
              min={0}
              step="any"
              value={r.hysteresis}
              onChange={(e) => setRule(i, { hysteresis: Math.max(0, Number(e.target.value)) })}
            />
            <Button size="sm" variant="tertiary" aria-label={t('sensorWidgets.remove')} onClick={() => setForm({ ...form, alertRules: form.alertRules.filter((_, j) => j !== i) })}>
              <Trash2 size={14} aria-hidden />
            </Button>
          </div>
        ))}
        {form.alertRules.length < 5 ? (
          <Button
            size="sm"
            onClick={() =>
              setForm({
                ...form,
                alertRules: [
                  ...form.alertRules,
                  { id: newId(), label: '', operator: form.valueType === 'boolean' ? '==' : '>', value: form.valueType === 'boolean' ? 1 : 0, severity: 'warning', hysteresis: 0 },
                ],
              })
            }
          >
            <Plus size={14} aria-hidden /> {t('channels.addRule')}
          </Button>
        ) : null}
        <p className="wxp-muted rule-list__legend">{t('channels.hysteresisHint')}</p>
      </fieldset>
    </Dialog>
  );
}
