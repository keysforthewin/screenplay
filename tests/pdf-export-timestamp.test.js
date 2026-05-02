import { describe, it, expect } from 'vitest';

const { formatExportTimestamp } = await import('../src/pdf/export.js');

describe('formatExportTimestamp', () => {
  it('formats a winter (EST) instant as month-dayth-hhmmpm-est', () => {
    // Jan 15 2026 12:30 PM America/New_York = 17:30 UTC
    const d = new Date(Date.UTC(2026, 0, 15, 17, 30, 0));
    expect(formatExportTimestamp(d)).toBe('jan-15th-1230pm-est');
  });

  it('uses Eastern time even when the host clock differs (summer day still labelled est)', () => {
    // Jul 4 2026 12:05 PM America/New_York (EDT) = 16:05 UTC
    const d = new Date(Date.UTC(2026, 6, 4, 16, 5, 0));
    expect(formatExportTimestamp(d)).toBe('jul-4th-1205pm-est');
  });

  it('uses am for morning instants', () => {
    // Mar 10 2026 09:15 AM America/New_York (EDT) = 13:15 UTC
    const d = new Date(Date.UTC(2026, 2, 10, 13, 15, 0));
    expect(formatExportTimestamp(d)).toBe('mar-10th-915am-est');
  });

  it('emits the right ordinal suffix for st/nd/rd/th edge cases', () => {
    // All times anchored at 17:00 UTC = 12:00 PM EST so we only vary the day.
    const ord = (year, monthIdx, day) =>
      formatExportTimestamp(new Date(Date.UTC(year, monthIdx, day, 17, 0, 0)));
    expect(ord(2026, 0, 1)).toBe('jan-1st-1200pm-est');
    expect(ord(2026, 0, 2)).toBe('jan-2nd-1200pm-est');
    expect(ord(2026, 0, 3)).toBe('jan-3rd-1200pm-est');
    expect(ord(2026, 0, 4)).toBe('jan-4th-1200pm-est');
    expect(ord(2026, 0, 11)).toBe('jan-11th-1200pm-est');
    expect(ord(2026, 0, 12)).toBe('jan-12th-1200pm-est');
    expect(ord(2026, 0, 13)).toBe('jan-13th-1200pm-est');
    expect(ord(2026, 0, 21)).toBe('jan-21st-1200pm-est');
    expect(ord(2026, 0, 22)).toBe('jan-22nd-1200pm-est');
    expect(ord(2026, 0, 23)).toBe('jan-23rd-1200pm-est');
    expect(ord(2026, 0, 31)).toBe('jan-31st-1200pm-est');
  });

  it('produces a string that fits the PDF filename validator charset', () => {
    expect(/^[a-z0-9-]+$/.test(formatExportTimestamp())).toBe(true);
  });
});
