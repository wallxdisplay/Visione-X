import { Button, SelectField, TextField } from '@wallx-play/ui';
import type { DataBinding, TextStyle, Threshold, Widget } from '@wallx-play/layout-spec';
import { Plus, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { bindingFor, type ChannelChoice } from './widgetDefaults';

type SensorWidget = Extract<Widget, { type: 'sensorValue' | 'gauge' | 'chart' | 'status' }>;

const keyOf = (b: Pick<DataBinding, 'sourceId' | 'field'>) => `${b.sourceId}/${b.field}`;
const WINDOWS = [15, 60, 360, 720, 1440];

/** Channel picker; keeps a missing (deleted) channel visible so the problem is obvious. */
function ChannelSelect({
  label,
  binding,
  channels,
  readOnly,
  onChange,
}: {
  label: string;
  binding: DataBinding;
  channels: ChannelChoice[];
  readOnly: boolean;
  onChange: (b: DataBinding) => void;
}) {
  const { t } = useTranslation();
  const options = channels.map((c) => ({ value: keyOf({ sourceId: c.sensorDeviceId, field: c.channelId }), label: c.name }));
  const known = options.some((o) => o.value === keyOf(binding));
  return (
    <SelectField
      label={label}
      disabled={readOnly}
      error={known ? undefined : t('sensorWidgets.missingChannel')}
      options={known ? options : [{ value: keyOf(binding), label: t('sensorWidgets.missingChannel') }, ...options]}
      value={keyOf(binding)}
      onChange={(e) => {
        const c = channels.find((x) => keyOf({ sourceId: x.sensorDeviceId, field: x.channelId }) === e.target.value);
        if (c) onChange({ ...bindingFor(c), ...(binding.decimals !== undefined ? { decimals: binding.decimals } : {}) });
      }}
    />
  );
}

function ThresholdsEditor({ value, readOnly, onChange }: { value: Threshold[]; readOnly: boolean; onChange: (t: Threshold[]) => void }) {
  const { t } = useTranslation();
  const set = (i: number, patch: Partial<Threshold>) => onChange(value.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <fieldset className="sensor-editor__group">
      <legend className="wxp-field__label">{t('sensorWidgets.bands')}</legend>
      <p className="wxp-muted sensor-editor__hint">{t('sensorWidgets.bandsHint')}</p>
      {value.map((b, i) => (
        <div key={i} className="sensor-editor__row">
          <select aria-label={t('sensorWidgets.operator')} className="wxp-input sensor-editor__op" value={b.operator} disabled={readOnly} onChange={(e) => set(i, { operator: e.target.value as Threshold['operator'] })}>
            {['>', '>=', '<', '<='].map((op) => (
              <option key={op} value={op}>
                {op}
              </option>
            ))}
          </select>
          <input aria-label={t('sensorWidgets.value')} className="wxp-input sensor-editor__num" type="number" step="any" value={b.value} disabled={readOnly} onChange={(e) => set(i, { value: Number(e.target.value) })} />
          <input aria-label={t('studio.color')} type="color" className="color-input" value={b.color.slice(0, 7)} disabled={readOnly} onChange={(e) => set(i, { color: e.target.value.toUpperCase() })} />
          <input aria-label={t('sensorWidgets.bandLabel')} className="wxp-input" placeholder={t('sensorWidgets.bandLabel')} maxLength={40} value={b.label} disabled={readOnly} onChange={(e) => set(i, { label: e.target.value })} />
          {!readOnly ? (
            <Button size="sm" variant="tertiary" aria-label={t('sensorWidgets.remove')} onClick={() => onChange(value.filter((_, j) => j !== i))}>
              <Trash2 size={14} aria-hidden />
            </Button>
          ) : null}
        </div>
      ))}
      {!readOnly && value.length < 5 ? (
        <Button size="sm" onClick={() => onChange([...value, { label: '', operator: '>=', value: 0, color: '#DC2626' }])}>
          <Plus size={14} aria-hidden /> {t('sensorWidgets.addBand')}
        </Button>
      ) : null}
    </fieldset>
  );
}

/** Properties of the four sensor widgets (value, gauge, chart, status). */
export function SensorWidgetEditor({
  widget,
  channels,
  readOnly,
  onChange,
  styleEditor,
}: {
  widget: SensorWidget;
  channels: ChannelChoice[];
  readOnly: boolean;
  onChange: (w: Widget) => void;
  styleEditor: (style: TextStyle | undefined, update: (s: TextStyle) => void, defaultScale: number, mode: 'size' | 'colors') => ReactNode;
}) {
  const { t } = useTranslation();
  const decimalsField = (binding: DataBinding, update: (b: DataBinding) => void) => (
    <SelectField
      label={t('sensorWidgets.decimals')}
      disabled={readOnly}
      options={[{ value: '', label: t('sensorWidgets.decimalsAuto') }, ...[0, 1, 2, 3].map((d) => ({ value: String(d), label: String(d) }))]}
      value={binding.decimals === undefined ? '' : String(binding.decimals)}
      onChange={(e) => {
        const { decimals: _drop, ...rest } = binding;
        void _drop;
        update(e.target.value === '' ? rest : { ...rest, decimals: Number(e.target.value) });
      }}
    />
  );
  const labelField = (
    <TextField label={t('sensorWidgets.label')} maxLength={60} value={widget.label} disabled={readOnly} onChange={(e) => onChange({ ...widget, label: e.target.value })} />
  );

  if (widget.type === 'chart') {
    const setBinding = (i: number, b: DataBinding) => onChange({ ...widget, bindings: widget.bindings.map((x, j) => (j === i ? b : x)) });
    return (
      <>
        {widget.bindings.map((b, i) => (
          <div key={i} className="sensor-editor__chan">
            <ChannelSelect label={t('sensorWidgets.seriesN', { n: i + 1 })} binding={b} channels={channels} readOnly={readOnly} onChange={(nb) => setBinding(i, nb)} />
            {!readOnly && widget.bindings.length > 1 ? (
              <Button size="sm" variant="tertiary" aria-label={t('sensorWidgets.remove')} onClick={() => onChange({ ...widget, bindings: widget.bindings.filter((_, j) => j !== i) })}>
                <Trash2 size={14} aria-hidden />
              </Button>
            ) : null}
          </div>
        ))}
        {!readOnly && widget.bindings.length < 3 && channels[0] ? (
          <Button size="sm" onClick={() => onChange({ ...widget, bindings: [...widget.bindings, bindingFor(channels[0]!)] })}>
            <Plus size={14} aria-hidden /> {t('sensorWidgets.addSeries')}
          </Button>
        ) : null}
        {labelField}
        <div className="wxp-form__row">
          <SelectField
            label={t('sensorWidgets.chartKind')}
            disabled={readOnly}
            options={['line', 'bar'].map((k) => ({ value: k, label: t(`sensorWidgets.kinds.${k}`) }))}
            value={widget.kind}
            onChange={(e) => onChange({ ...widget, kind: e.target.value as 'line' | 'bar' })}
          />
          <SelectField
            label={t('sensorWidgets.window')}
            disabled={readOnly}
            options={WINDOWS.map((m) => ({ value: String(m), label: t('sensorWidgets.windowOption', { count: m >= 60 ? m / 60 : m, context: m >= 60 ? 'hours' : 'minutes' }) }))}
            value={String(widget.windowMinutes)}
            onChange={(e) => onChange({ ...widget, windowMinutes: Number(e.target.value) })}
          />
        </div>
        {decimalsField(widget.bindings[0]!, (b) => setBinding(0, b))}
        {styleEditor(widget.style, (style) => onChange({ ...widget, style }), 0.3, 'colors')}
      </>
    );
  }

  const setBinding = (binding: DataBinding) => onChange({ ...widget, binding } as Widget);
  return (
    <>
      <ChannelSelect label={t('sensorWidgets.channel')} binding={widget.binding} channels={channels} readOnly={readOnly} onChange={setBinding} />
      {labelField}
      {widget.type !== 'status' ? (
        <div className="wxp-form__row">
          <TextField label={t('sensorWidgets.unit')} maxLength={16} value={widget.unit} disabled={readOnly} onChange={(e) => onChange({ ...widget, unit: e.target.value })} />
          {decimalsField(widget.binding, setBinding)}
        </div>
      ) : null}
      {widget.type === 'gauge' ? (
        <div className="wxp-form__row">
          <TextField label={t('sensorWidgets.min')} type="number" step="any" value={widget.min} disabled={readOnly} onChange={(e) => onChange({ ...widget, min: Number(e.target.value) })} />
          <TextField
            label={t('sensorWidgets.max')}
            type="number"
            step="any"
            value={widget.max}
            disabled={readOnly}
            error={widget.max > widget.min ? undefined : t('sensorWidgets.maxAboveMin')}
            onChange={(e) => onChange({ ...widget, max: Number(e.target.value) })}
          />
        </div>
      ) : null}
      {widget.type === 'sensorValue' || widget.type === 'gauge' ? (
        <ThresholdsEditor value={widget.thresholds} readOnly={readOnly} onChange={(thresholds) => onChange({ ...widget, thresholds })} />
      ) : null}
      {widget.type === 'status' ? (
        <fieldset className="sensor-editor__group">
          <legend className="wxp-field__label">{t('sensorWidgets.states')}</legend>
          <p className="wxp-muted sensor-editor__hint">{t('sensorWidgets.statesHint')}</p>
          {widget.states.map((s, i) => {
            const set = (patch: Partial<typeof s>) => onChange({ ...widget, states: widget.states.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
            return (
              <div key={i} className="sensor-editor__row">
                <input aria-label={t('sensorWidgets.match')} className="wxp-input sensor-editor__num" maxLength={20} value={s.match} disabled={readOnly} onChange={(e) => set({ match: e.target.value })} />
                <input aria-label={t('studio.color')} type="color" className="color-input" value={s.color.slice(0, 7)} disabled={readOnly} onChange={(e) => set({ color: e.target.value.toUpperCase() })} />
                <input aria-label={t('sensorWidgets.stateLabel')} className="wxp-input" maxLength={40} value={s.label} disabled={readOnly} onChange={(e) => set({ label: e.target.value })} />
                {!readOnly && widget.states.length > 1 ? (
                  <Button size="sm" variant="tertiary" aria-label={t('sensorWidgets.remove')} onClick={() => onChange({ ...widget, states: widget.states.filter((_, j) => j !== i) })}>
                    <Trash2 size={14} aria-hidden />
                  </Button>
                ) : null}
              </div>
            );
          })}
          {!readOnly && widget.states.length < 8 ? (
            <Button size="sm" onClick={() => onChange({ ...widget, states: [...widget.states, { match: String(widget.states.length), label: '', color: '#475569' }] })}>
              <Plus size={14} aria-hidden /> {t('sensorWidgets.addState')}
            </Button>
          ) : null}
        </fieldset>
      ) : null}
      {styleEditor(widget.style, (style) => onChange({ ...widget, style } as Widget), widget.type === 'status' ? 0.3 : 0.4, widget.type === 'gauge' ? 'colors' : 'size')}
    </>
  );
}
