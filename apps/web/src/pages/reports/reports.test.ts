import { describe, expect, it } from 'vitest';
import { periodRange, toCsv } from './PlaybackReports';

describe('playback report helpers', () => {
  it('turns period presets into date ranges', () => {
    expect(periodRange('today', '2026-10-14')).toEqual({ from: '2026-10-14', to: '2026-10-14' });
    expect(periodRange('yesterday', '2026-10-01')).toEqual({ from: '2026-09-30', to: '2026-09-30' });
    expect(periodRange('last7', '2026-10-14')).toEqual({ from: '2026-10-08', to: '2026-10-14' });
    expect(periodRange('last30', '2026-10-14')).toEqual({ from: '2026-09-15', to: '2026-10-14' });
    expect(periodRange('thisMonth', '2026-10-14')).toEqual({ from: '2026-10-01', to: '2026-10-14' });
    expect(periodRange('lastMonth', '2026-03-05')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(periodRange('lastMonth', '2026-01-10')).toEqual({ from: '2025-12-01', to: '2025-12-31' });
  });

  it('writes CSV that Excel opens, quoting where needed', () => {
    expect(toCsv([['Date', 'Content'], ['2026-10-01', 'Diwali, "big" offer'], ['2026-10-01', 'दिवाळी']])).toBe(
      '﻿Date,Content\r\n2026-10-01,"Diwali, ""big"" offer"\r\n2026-10-01,दिवाळी\r\n',
    );
  });
});
