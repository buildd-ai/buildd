import { describe, it, expect } from 'bun:test';
import {
  DEFAULT_TIMEZONE,
  isValidTimezone,
  resolveTimezone,
  formatStamp,
} from '../timezone';

const ISO = '2026-08-29T14:03:00Z';

describe('isValidTimezone', () => {
  it('accepts real IANA zones beyond any curated shortlist', () => {
    for (const tz of ['UTC', 'America/New_York', 'America/Toronto', 'Europe/Zurich', 'Asia/Kolkata']) {
      expect(isValidTimezone(tz)).toBe(true);
    }
  });

  it('rejects garbage, non-strings, and absurd lengths', () => {
    for (const tz of ['Mars/Olympus', '', 'not a zone', null, undefined, 42, {}, 'x'.repeat(200)]) {
      expect(isValidTimezone(tz)).toBe(false);
    }
  });
});

describe('resolveTimezone', () => {
  it('takes the first valid candidate', () => {
    expect(resolveTimezone('America/Denver', 'Europe/Berlin')).toBe('America/Denver');
  });

  it('skips null/undefined/invalid candidates', () => {
    expect(resolveTimezone(null, undefined, 'Mars/Olympus', 'Europe/Berlin')).toBe('Europe/Berlin');
  });

  it('falls back to UTC when nothing resolves', () => {
    expect(resolveTimezone(null, undefined)).toBe(DEFAULT_TIMEZONE);
    expect(resolveTimezone()).toBe('UTC');
  });
});

describe('formatStamp', () => {
  it('renders UTC identically to the previous hand-rolled formatter', () => {
    expect(formatStamp(ISO, 'UTC')).toBe('Aug 29, 14:03 UTC');
    expect(formatStamp(ISO, null)).toBe('Aug 29, 14:03 UTC');
  });

  it('shifts the wall clock into the requested zone and names it', () => {
    expect(formatStamp(ISO, 'America/New_York')).toBe('Aug 29, 10:03 EDT');
  });

  it('rolls the date when the zone crosses midnight', () => {
    expect(formatStamp(ISO, 'Australia/Sydney')).toStartWith('Aug 30, 00:03 ');
  });

  it('handles half-hour offsets', () => {
    expect(formatStamp(ISO, 'Asia/Kolkata')).toStartWith('Aug 29, 19:33 ');
  });

  it('always carries a zone label so a remote reader is not misled', () => {
    for (const tz of ['UTC', 'America/New_York', 'Europe/Berlin', 'Asia/Kolkata']) {
      expect(formatStamp(ISO, tz)).toMatch(/^[A-Z][a-z]{2} \d{1,2}, \d{2}:\d{2} \S+$/);
    }
  });

  it('falls back to UTC for an invalid zone rather than throwing', () => {
    expect(formatStamp(ISO, 'Mars/Olympus')).toBe('Aug 29, 14:03 UTC');
  });

  it('returns a placeholder for an unparseable timestamp', () => {
    expect(formatStamp('not-a-date', 'UTC')).toBe('unknown time');
    expect(formatStamp('', 'America/New_York')).toBe('unknown time');
  });
});
