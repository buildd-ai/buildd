import { describe, it, expect } from 'bun:test';
import {
  formatHour,
  getHourOptions,
  validateActiveHours,
  DEFAULT_HEARTBEAT_CHECKLIST,
  HEARTBEAT_CRON_PRESETS,
} from './heartbeat-helpers';

describe('formatHour', () => {
  it('formats midnight as 12:00 AM', () => {
    expect(formatHour(0)).toBe('12:00 AM');
  });

  it('formats morning hours correctly', () => {
    expect(formatHour(1)).toBe('1:00 AM');
    expect(formatHour(8)).toBe('8:00 AM');
    expect(formatHour(11)).toBe('11:00 AM');
  });

  it('formats noon as 12:00 PM', () => {
    expect(formatHour(12)).toBe('12:00 PM');
  });

  it('formats afternoon/evening hours correctly', () => {
    expect(formatHour(13)).toBe('1:00 PM');
    expect(formatHour(17)).toBe('5:00 PM');
    expect(formatHour(22)).toBe('10:00 PM');
    expect(formatHour(23)).toBe('11:00 PM');
  });

  it('returns Invalid for out-of-range values', () => {
    expect(formatHour(-1)).toBe('Invalid');
    expect(formatHour(24)).toBe('Invalid');
    expect(formatHour(1.5)).toBe('Invalid');
  });
});

describe('getHourOptions', () => {
  it('returns 24 options', () => {
    const options = getHourOptions();
    expect(options).toHaveLength(24);
  });

  it('has correct first and last entries', () => {
    const options = getHourOptions();
    expect(options[0]).toEqual({ value: '0', label: '12:00 AM' });
    expect(options[23]).toEqual({ value: '23', label: '11:00 PM' });
  });
});

describe('validateActiveHours', () => {
  it('returns null for valid ranges', () => {
    expect(validateActiveHours(8, 22)).toBeNull();
    expect(validateActiveHours(0, 23)).toBeNull();
    // Wrapping ranges (e.g. 22-6 for night shift) are allowed
    expect(validateActiveHours(22, 6)).toBeNull();
  });

  it('rejects same start and end', () => {
    expect(validateActiveHours(8, 8)).toBe('Start and end hours cannot be the same');
  });

  it('rejects out-of-range hours', () => {
    expect(validateActiveHours(-1, 10)).toBe('Hours must be between 0 and 23');
    expect(validateActiveHours(8, 24)).toBe('Hours must be between 0 and 23');
  });
});

describe('DEFAULT_HEARTBEAT_CHECKLIST', () => {
  it('contains markdown heading and items', () => {
    expect(DEFAULT_HEARTBEAT_CHECKLIST).toContain('# Heartbeat Checklist');
    expect(DEFAULT_HEARTBEAT_CHECKLIST).toContain('- Check email');
  });
});

describe('HEARTBEAT_CRON_PRESETS', () => {
  it('has 3 heartbeat-appropriate presets', () => {
    expect(HEARTBEAT_CRON_PRESETS).toHaveLength(3);
    expect(HEARTBEAT_CRON_PRESETS.map(p => p.label)).toEqual([
      'Every 30 min',
      'Every hour',
      'Every 4 hours',
    ]);
  });
});
