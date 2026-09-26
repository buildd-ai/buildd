import { afterAll, describe, expect, it } from 'bun:test';
import { formatInZone } from './zoned-time';

// 07:55:46 in New York (EDT), 11:55:46 UTC, 23:55:46 in Auckland — every
// process zone below lands the instant on a different wall clock, so a
// formatter that leaks the process zone fails at least one of them.
const EVALUATED_AT = '2026-09-24T11:55:46.000Z';
const originalTz = process.env.TZ;
afterAll(() => {
  process.env.TZ = originalTz;
});

for (const processTz of ['UTC', 'Pacific/Auckland']) {
  describe(`formatInZone under TZ=${processTz}`, () => {
    it('follows the zone it is given, not the process zone', () => {
      process.env.TZ = processTz;
      expect(formatInZone(EVALUATED_AT, 'America/New_York')).toBe('Sep 24, 2026, 7:55:46 AM EDT');
      expect(formatInZone(EVALUATED_AT, 'America/New_York', 'time')).toBe('7:55 AM');
      expect(formatInZone(EVALUATED_AT, 'America/New_York', 'date')).toBe('Sep 24, 2026');
      expect(formatInZone(EVALUATED_AT, 'America/New_York', 'datetime-short')).toBe('Sep 24, 7:55 AM');
      expect(formatInZone(EVALUATED_AT, 'UTC', 'time')).toBe('11:55 AM');
    });

    it('accepts epoch millis and Date objects', () => {
      process.env.TZ = processTz;
      const ms = Date.parse(EVALUATED_AT);
      expect(formatInZone(ms, 'America/New_York', 'time-seconds')).toBe('7:55:46 AM');
      expect(formatInZone(new Date(ms), 'America/New_York', 'time-seconds')).toBe('7:55:46 AM');
    });
  });
}

describe('formatInZone — bad input', () => {
  it('returns empty rather than falling back to the process zone', () => {
    expect(formatInZone(EVALUATED_AT, 'Not/AZone')).toBe('');
    expect(formatInZone('not a date', 'America/New_York')).toBe('');
  });

  it('never emits the ICU narrow no-break space (hydration-stable across engines)', () => {
    expect(formatInZone(EVALUATED_AT, 'America/New_York')).not.toMatch(/[   ]/);
  });
});
