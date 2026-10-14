import { SelectField, TextField } from '@wallx-play/ui';
import type { TextStyle, Widget } from '@wallx-play/layout-spec';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { DataSourceChoice } from './widgetSources';

type DataWidget = Extract<Widget, { type: 'weather' | 'rss' | 'aqi' }>;

const SOURCE_LABEL = { weather: 'dataWidgets.place', rss: 'dataWidgets.feed', aqi: 'dataWidgets.airPlace' } as const;

/** Properties of the weather, RSS and air quality widgets. */
export function DataWidgetEditor({
  widget,
  sources,
  readOnly,
  onChange,
  styleEditor,
}: {
  widget: DataWidget;
  sources: DataSourceChoice[];
  readOnly: boolean;
  onChange: (w: Widget) => void;
  styleEditor: (style: TextStyle | undefined, update: (s: TextStyle) => void, defaultScale: number, mode: 'full' | 'size' | 'colors') => ReactNode;
}) {
  const { t } = useTranslation();
  const known = sources.some((s) => s.id === widget.dataSourceId);
  const options = sources.map((s) => ({ value: s.id, label: s.name }));
  return (
    <>
      <SelectField
        label={t(SOURCE_LABEL[widget.type])}
        disabled={readOnly}
        error={known ? undefined : t('dataWidgets.missing')}
        options={known ? options : [{ value: widget.dataSourceId, label: t('dataWidgets.missing') }, ...options]}
        value={widget.dataSourceId}
        onChange={(e) => onChange({ ...widget, dataSourceId: e.target.value })}
      />
      {widget.type === 'weather' ? (
        <SelectField
          label={t('dataWidgets.show')}
          disabled={readOnly}
          options={(['current', 'forecast'] as const).map((v) => ({ value: v, label: t(`dataWidgets.layouts.${v}`) }))}
          value={widget.layout}
          onChange={(e) => onChange({ ...widget, layout: e.target.value as 'current' | 'forecast' })}
        />
      ) : widget.type === 'aqi' ? (
        <SelectField
          label={t('dataWidgets.show')}
          disabled={readOnly}
          options={(['compact', 'detailed'] as const).map((v) => ({ value: v, label: t(`dataWidgets.aqiLayouts.${v}`) }))}
          value={widget.layout}
          onChange={(e) => onChange({ ...widget, layout: e.target.value as 'compact' | 'detailed' })}
        />
      ) : (
        <>
          <TextField
            label={t('dataWidgets.itemDuration')}
            type="number"
            min={3}
            max={120}
            value={widget.itemDurationSec}
            disabled={readOnly}
            onChange={(e) => onChange({ ...widget, itemDurationSec: Math.min(120, Math.max(3, Number(e.target.value) || 8)) })}
          />
          <label className="checkbox-row">
            <input type="checkbox" checked={widget.showFeedTitle} disabled={readOnly} onChange={(e) => onChange({ ...widget, showFeedTitle: e.target.checked })} />
            {t('dataWidgets.showFeedTitle')}
          </label>
        </>
      )}
      {styleEditor(widget.style, (style) => onChange({ ...widget, style } as Widget), 0.14, widget.type === 'rss' ? 'size' : 'colors')}
    </>
  );
}
