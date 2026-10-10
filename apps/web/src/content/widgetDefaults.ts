import type { Widget } from '@visione-x/layout-spec';

export type EditableWidgetType = 'text' | 'clock' | 'qr' | 'table' | 'web';

/** Sensible starting configuration for each widget the editor offers. */
export function defaultWidget(type: EditableWidgetType, timezone: string): Widget {
  switch (type) {
    case 'text':
      return { type: 'text', text: 'Your message here', style: { color: '#FFFFFF', fontScale: 0.35, align: 'center', bold: true } };
    case 'clock':
      return { type: 'clock', format: 'time', timezone, seconds: false, style: { color: '#FFFFFF', fontScale: 0.45, align: 'center' } };
    case 'qr':
      return { type: 'qr', value: 'https://example.com', foreground: '#000000', background: '#FFFFFF' };
    case 'table':
      return {
        type: 'table',
        columns: ['Item', 'Price'],
        rows: [
          ['Masala chai', '₹30'],
          ['Filter coffee', '₹45'],
        ],
        style: { color: '#FFFFFF', fontScale: 0.08 },
      };
    case 'web':
      return { type: 'web', url: 'https://example.com' };
  }
}
