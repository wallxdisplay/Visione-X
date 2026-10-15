import { Button, Dialog, SelectField, TextAreaField, TextField } from '@wallx-play/ui';
import type { DataBinding, TextStyle, Widget } from '@wallx-play/layout-spec';
import { Plus, Radio, Table2, Trash2, Type } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { timezoneOptions } from '../lib/format';
import { DataWidgetEditor } from './DataWidgetEditor';
import { SensorWidgetEditor } from './SensorWidgetEditor';
import {
  bindingFor,
  DATA_WIDGET_TYPES,
  SENSOR_WIDGET_TYPES,
  type ChannelChoice,
  type DataWidgetType,
  type EditableWidgetType,
  type SensorWidgetType,
} from './widgetDefaults';
import type { WidgetSources } from './widgetSources';

export type WidgetChoice = EditableWidgetType | SensorWidgetType | DataWidgetType;

export const isSensorChoice = (c: string): c is SensorWidgetType => (SENSOR_WIDGET_TYPES as string[]).includes(c);
export const isDataChoice = (c: string): c is DataWidgetType => (DATA_WIDGET_TYPES as string[]).includes(c);

/**
 * Widget types to offer, in menu order. Sensor and data widgets appear only when the plan has
 * them, and are disabled until a channel / data source exists. Buttons are offered for layout
 * zones (`zone`) on plans with touch screens.
 */
export function widgetChoices({ sensors, dataSources, touch }: WidgetSources, { zone = false } = {}): Array<{ type: WidgetChoice; disabled: boolean }> {
  const core: EditableWidgetType[] = ['text', 'clock', 'qr', 'table', 'web', ...(zone && touch ? (['button'] as const) : [])];
  return [
    ...core.map((type) => ({ type, disabled: false })),
    ...(sensors ? SENSOR_WIDGET_TYPES.map((type) => ({ type, disabled: !sensors.length })) : []),
    ...DATA_WIDGET_TYPES.filter((d) => dataSources[d]).map((type) => ({ type, disabled: !dataSources[type]!.length })),
  ];
}

/** Why some offered widget types are disabled (no channels / no data sources yet), if any. */
export function widgetChoicesHint({ sensors, dataSources }: WidgetSources, t: (key: string) => string): string | undefined {
  if (sensors && !sensors.length) return t('sensorWidgets.noChannels');
  if (DATA_WIDGET_TYPES.some((d) => dataSources[d] && !dataSources[d]!.length)) return t('dataWidgets.noSources');
  return undefined;
}

export type StyleEditor = (
  style: TextStyle | undefined,
  update: (s: TextStyle) => void,
  defaultScale: number,
  mode?: 'full' | 'size' | 'colors',
) => ReactNode;

/** Colour, background, size and alignment controls shared by the widget editors. */
export function useStyleEditor(readOnly: boolean): StyleEditor {
  const { t } = useTranslation();
  return (style, update, defaultScale, mode = 'full') => (
    <>
      <div className="wxp-form__row">
        <label className="wxp-field">
          <span className="wxp-field__label">{t('studio.color')}</span>
          <input type="color" className="color-input" value={style?.color ?? '#FFFFFF'} disabled={readOnly} onChange={(e) => update({ ...style, color: e.target.value.toUpperCase() })} />
        </label>
        <label className="wxp-field">
          <span className="wxp-field__label">{t('studio.background')}</span>
          <span className="color-row">
            <input
              type="color"
              className="color-input"
              value={style?.background ?? '#000000'}
              disabled={readOnly}
              onChange={(e) => update({ ...style, background: e.target.value.toUpperCase() })}
            />
            {style?.background ? (
              <Button size="sm" variant="tertiary" disabled={readOnly} onClick={() => update({ ...style, background: undefined })}>
                {t('studio.transparent')}
              </Button>
            ) : null}
          </span>
        </label>
      </div>
      {mode !== 'colors' ? (
        <label className="wxp-field">
          <span className="wxp-field__label">
            {t('studio.textSize')} <span className="wxp-muted">{Math.round((style?.fontScale ?? defaultScale) * 100)}%</span>
          </span>
          <input
            type="range"
            min={2}
            max={100}
            value={Math.round((style?.fontScale ?? defaultScale) * 100)}
            disabled={readOnly}
            onChange={(e) => update({ ...style, fontScale: Number(e.target.value) / 100 })}
          />
        </label>
      ) : null}
      {mode === 'full' ? (
        <div className="wxp-form__row">
          <SelectField
            label={t('studio.align')}
            options={['start', 'center', 'end'].map((a) => ({ value: a, label: t(`studio.alignOptions.${a}`) }))}
            value={style?.align ?? 'center'}
            disabled={readOnly}
            onChange={(e) => update({ ...style, align: e.target.value as TextStyle['align'] })}
          />
          <label className="checkbox-row">
            <input type="checkbox" checked={!!style?.bold} disabled={readOnly} onChange={(e) => update({ ...style, bold: e.target.checked })} />
            {t('studio.bold')}
          </label>
        </div>
      ) : null}
    </>
  );
}

/**
 * Settings of one widget, for Layout Studio zones and full-screen playlist items.
 * `compact` (narrow panels) opens the table grid in its own dialog instead of inline.
 */
export function WidgetEditor({
  widget,
  sources,
  readOnly,
  compact = false,
  onChange,
}: {
  widget: Widget;
  sources: WidgetSources;
  readOnly: boolean;
  compact?: boolean;
  onChange: (w: Widget) => void;
}) {
  const { t } = useTranslation();
  const styleEditor = useStyleEditor(readOnly);
  const timezones = useMemo(timezoneOptions, []);
  const w = widget;

  switch (w.type) {
    case 'weather':
    case 'rss':
    case 'aqi':
      return <DataWidgetEditor widget={w} sources={sources.dataSources[w.type] ?? []} readOnly={readOnly} onChange={onChange} styleEditor={(s, u, d, m) => styleEditor(s, u, d, m)} />;
    case 'sensorValue':
    case 'gauge':
    case 'chart':
    case 'status':
      return <SensorWidgetEditor widget={w} channels={sources.sensors ?? []} readOnly={readOnly} onChange={onChange} styleEditor={(s, u, d, m) => styleEditor(s, u, d, m)} />;
    case 'text':
      return (
        <>
          <TextAreaField label={t('studio.text')} hint={t('studio.textHint')} value={w.text} disabled={readOnly} maxLength={2000} onChange={(e) => onChange({ ...w, text: e.target.value })} />
          {styleEditor(w.style, (style) => onChange({ ...w, style }), 0.4)}
        </>
      );
    case 'button':
      return (
        <>
          <TextField label={t('studio.buttonLabel')} hint={t('studio.buttonHint')} value={w.label} disabled={readOnly} maxLength={80} onChange={(e) => onChange({ ...w, label: e.target.value })} />
          {styleEditor(w.style, (style) => onChange({ ...w, style }), 0.36)}
        </>
      );
    case 'clock':
      return (
        <>
          <SelectField
            label={t('studio.clockFormat')}
            disabled={readOnly}
            options={['time', 'date', 'datetime'].map((f) => ({ value: f, label: t(`studio.clockFormats.${f}`) }))}
            value={w.format}
            onChange={(e) => onChange({ ...w, format: e.target.value as typeof w.format })}
          />
          <SelectField label={t('studio.timezone')} disabled={readOnly} options={timezones} value={w.timezone} onChange={(e) => onChange({ ...w, timezone: e.target.value })} />
          <label className="checkbox-row">
            <input type="checkbox" checked={w.seconds} disabled={readOnly} onChange={(e) => onChange({ ...w, seconds: e.target.checked })} />
            {t('studio.showSeconds')}
          </label>
          {styleEditor(w.style, (style) => onChange({ ...w, style }), 0.45)}
        </>
      );
    case 'qr':
      return (
        <>
          <TextField label={t('studio.qrValue')} hint={t('studio.qrHint')} value={w.value} disabled={readOnly} maxLength={1000} onChange={(e) => onChange({ ...w, value: e.target.value })} />
          <div className="wxp-form__row">
            <label className="wxp-field">
              <span className="wxp-field__label">{t('studio.color')}</span>
              <input type="color" className="color-input" value={w.foreground} disabled={readOnly} onChange={(e) => onChange({ ...w, foreground: e.target.value.toUpperCase() })} />
            </label>
            <label className="wxp-field">
              <span className="wxp-field__label">{t('studio.background')}</span>
              <input type="color" className="color-input" value={w.background} disabled={readOnly} onChange={(e) => onChange({ ...w, background: e.target.value.toUpperCase() })} />
            </label>
          </div>
        </>
      );
    case 'table':
      return (
        <>
          {compact ? <TableDialogButton widget={w} channels={sources.sensors} readOnly={readOnly} onChange={onChange} /> : <TableGrid widget={w} channels={sources.sensors} readOnly={readOnly} onChange={onChange} />}
          {styleEditor(w.style, (style) => onChange({ ...w, style }), 0.06)}
        </>
      );
    case 'web':
      return (
        <>
          <TextField label={t('studio.url')} hint={t('studio.urlHint')} type="url" value={w.url} disabled={readOnly} onChange={(e) => onChange({ ...w, url: e.target.value })} />
          <TextField
            label={t('studio.refresh')}
            type="number"
            min={30}
            value={w.refreshSec ?? ''}
            disabled={readOnly}
            onChange={(e) => onChange({ ...w, refreshSec: e.target.value ? Math.max(30, Number(e.target.value)) : undefined })}
          />
        </>
      );
  }
}

type TableWidget = Extract<Widget, { type: 'table' }>;
type Cell = TableWidget['rows'][number]['cells'][number];

const MAX_COLUMNS = 10;
const MAX_ROWS = 50;

/** Narrow panels: a summary and a button that opens the grid in a dialog. */
function TableDialogButton(props: { widget: TableWidget; channels: ChannelChoice[] | null; readOnly: boolean; onChange: (w: Widget) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const { widget } = props;
  return (
    <div className="wxp-field">
      <span className="wxp-field__label">{t('studio.tableData')}</span>
      <span className="wxp-muted">{t('studio.tableSize', { columns: widget.columns.length, rows: widget.rows.length })}</span>
      <div>
        <Button size="sm" onClick={() => setOpen(true)}>
          <Table2 size={14} aria-hidden /> {props.readOnly ? t('studio.viewTable') : t('studio.editTable')}
        </Button>
      </div>
      <Dialog open={open} size="lg" title={t('studio.tableData')} onClose={() => setOpen(false)} footer={<Button variant="primary" onClick={() => setOpen(false)}>{t('common.done')}</Button>}>
        <TableGrid {...props} />
      </Dialog>
    </div>
  );
}

/** Spreadsheet-style table editor; each cell is text or a live sensor value. */
function TableGrid({ widget, channels, readOnly, onChange }: { widget: TableWidget; channels: ChannelChoice[] | null; readOnly: boolean; onChange: (w: Widget) => void }) {
  const { t } = useTranslation();
  const cols = widget.columns.length;
  // Edited as a plain grid; stored as { cells } rows.
  const rows: Cell[][] = widget.rows.map((r) => Array.from({ length: cols }, (_, c) => r.cells[c] ?? ''));
  const set = (patch: { columns?: string[]; rows?: Cell[][] }) =>
    onChange({ ...widget, columns: patch.columns ?? widget.columns, rows: (patch.rows ?? rows).map((cells) => ({ cells })) });
  const setCell = (r: number, c: number, cell: Cell) => set({ rows: rows.map((row, i) => (i === r ? row.map((x, j) => (j === c ? cell : x)) : row)) });
  const channelKey = (b: DataBinding) => `${b.sourceId}/${b.field}`;
  const canBind = !!channels?.length;

  return (
    <div className="table-grid">
      <div className="table-grid__scroll">
        <table>
          <thead>
            <tr>
              {widget.columns.map((col, c) => (
                <th key={c}>
                  <span className="table-grid__cell">
                    <input
                      className="wxp-input"
                      aria-label={t('studio.columnName', { n: c + 1 })}
                      value={col}
                      maxLength={80}
                      disabled={readOnly}
                      onChange={(e) => set({ columns: widget.columns.map((x, j) => (j === c ? e.target.value : x)) })}
                    />
                    {!readOnly && cols > 1 ? (
                      <Button
                        size="sm"
                        variant="tertiary"
                        aria-label={t('studio.removeColumn', { n: c + 1 })}
                        onClick={() => set({ columns: widget.columns.filter((_, j) => j !== c), rows: rows.map((row) => row.filter((_, j) => j !== c)) })}
                      >
                        <Trash2 size={13} />
                      </Button>
                    ) : null}
                  </span>
                </th>
              ))}
              <th aria-hidden />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r}>
                {row.map((cell, c) => {
                  const label = t('studio.cellName', { row: r + 1, column: c + 1 });
                  return (
                    <td key={c}>
                      <span className="table-grid__cell">
                        {typeof cell === 'string' ? (
                          <input className="wxp-input" aria-label={label} value={cell} maxLength={200} disabled={readOnly} onChange={(e) => setCell(r, c, e.target.value)} />
                        ) : (
                          <select
                            className="wxp-input"
                            aria-label={label}
                            value={channelKey(cell)}
                            disabled={readOnly}
                            onChange={(e) => {
                              const ch = channels?.find((x) => `${x.sensorDeviceId}/${x.channelId}` === e.target.value);
                              if (ch) setCell(r, c, { ...bindingFor(ch), ...(cell.decimals !== undefined ? { decimals: cell.decimals } : {}) });
                            }}
                          >
                            {channels?.some((x) => `${x.sensorDeviceId}/${x.channelId}` === channelKey(cell)) ? null : <option value={channelKey(cell)}>{t('studio.missingSensor')}</option>}
                            {channels?.map((x) => (
                              <option key={`${x.sensorDeviceId}/${x.channelId}`} value={`${x.sensorDeviceId}/${x.channelId}`}>
                                {x.name}
                              </option>
                            ))}
                          </select>
                        )}
                        {!readOnly && (canBind || typeof cell !== 'string') ? (
                          <Button
                            size="sm"
                            variant="tertiary"
                            aria-label={typeof cell === 'string' ? t('studio.cellToSensor', { cell: label }) : t('studio.cellToText', { cell: label })}
                            title={typeof cell === 'string' ? t('studio.showSensorValue') : t('studio.showText')}
                            onClick={() => setCell(r, c, typeof cell === 'string' ? bindingFor(channels![0]!) : '')}
                          >
                            {typeof cell === 'string' ? <Radio size={13} /> : <Type size={13} />}
                          </Button>
                        ) : null}
                      </span>
                    </td>
                  );
                })}
                <td>
                  {!readOnly ? (
                    <Button size="sm" variant="tertiary" aria-label={t('studio.removeRow', { n: r + 1 })} onClick={() => set({ rows: rows.filter((_, i) => i !== r) })}>
                      <Trash2 size={13} />
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!readOnly ? (
        <div className="wxp-toolbar" style={{ margin: '8px 0 0' }}>
          <Button size="sm" disabled={rows.length >= MAX_ROWS} onClick={() => set({ rows: [...rows, Array.from({ length: cols }, () => '')] })}>
            <Plus size={14} aria-hidden /> {t('studio.addRow')}
          </Button>
          <Button size="sm" disabled={cols >= MAX_COLUMNS} onClick={() => set({ columns: [...widget.columns, ''], rows: rows.map((row) => [...row, '']) })}>
            <Plus size={14} aria-hidden /> {t('studio.addColumn')}
          </Button>
        </div>
      ) : null}
      <p className="wxp-field__hint">{canBind ? t('studio.tableSensorHint') : t('studio.tableHintGrid')}</p>
    </div>
  );
}
