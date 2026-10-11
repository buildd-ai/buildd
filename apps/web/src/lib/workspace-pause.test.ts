import { describe, expect, it } from 'bun:test';
import { MAX_PAUSE_MS, isPaused, resolvePauseUntil } from './workspace-pause';

const NOW = new Date('2030-01-01T12:00:00.000Z');

describe('resolvePauseUntil', () => {
  it('a duration counts from now', () => {
    expect(resolvePauseUntil({ for: '4h' }, NOW)).toEqual({ until: new Date('2030-01-01T16:00:00.000Z') });
  });
  it('an explicit time is taken as is', () => {
    expect(resolvePauseUntil({ until: '2030-01-02T09:00:00.000Z' }, NOW)).toEqual({ until: new Date('2030-01-02T09:00:00.000Z') });
  });
  it('until: null resumes now', () => {
    expect(resolvePauseUntil({ until: null }, NOW)).toEqual({ until: null });
  });
  it('refuses a past time, a bad duration, both at once, nothing, and longer than the cap', () => {
    expect(resolvePauseUntil({ until: '2029-12-31T00:00:00.000Z' }, NOW)).toHaveProperty('error');
    expect(resolvePauseUntil({ for: 'soon' }, NOW)).toHaveProperty('error');
    expect(resolvePauseUntil({ for: '1h', until: '2030-01-02T09:00:00.000Z' }, NOW)).toHaveProperty('error');
    expect(resolvePauseUntil({}, NOW)).toHaveProperty('error');
    expect(resolvePauseUntil({ until: new Date(NOW.getTime() + MAX_PAUSE_MS + 60_000).toISOString() }, NOW)).toHaveProperty('error');
  });
});

describe('isPaused', () => {
  it('only a time still ahead is a pause', () => {
    expect(isPaused(null, NOW)).toBe(false);
    expect(isPaused(new Date('2030-01-01T11:59:00.000Z'), NOW)).toBe(false);
    expect(isPaused(new Date('2030-01-01T12:01:00.000Z'), NOW)).toBe(true);
  });
});
