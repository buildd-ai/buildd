import { describe, expect, it } from 'bun:test';
import { timeZoneLabel } from './timezone-label';

const JULY = new Date('2026-07-01T12:00:00Z');
const JAN = new Date('2026-01-15T12:00:00Z');

describe('timeZoneLabel', () => {
  it('turns an IANA id into a city and the short zone name', () => {
    expect(timeZoneLabel('America/Chicago', JULY)).toBe('Chicago (CDT)');
    expect(timeZoneLabel('America/Chicago', JAN)).toBe('Chicago (CST)');
    expect(timeZoneLabel('America/New_York', JAN)).toBe('New York (EST)');
  });

  it('keeps UTC short', () => {
    expect(timeZoneLabel('UTC', JULY)).toBe('UTC');
  });

  it('keeps the city first for zones without a letter abbreviation', () => {
    expect(timeZoneLabel('Asia/Kolkata', JULY)).toMatch(/^Kolkata/);
  });

  it('returns an unknown id as given instead of throwing', () => {
    expect(timeZoneLabel('Not/AZone', JULY)).toBe('Not/AZone');
  });
});
