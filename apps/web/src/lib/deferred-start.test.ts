import { describe, expect, it } from 'bun:test';
import { laterStartAt, resolveDeferredStart } from './deferred-start';

const NOW = new Date('2026-07-24T12:00:00.000Z');

describe('resolveDeferredStart', () => {
  it('resolves relative minutes, hours, and days from the server clock', () => {
    expect(resolveDeferredStart({ startIn: '45m', now: NOW }).startAt?.toISOString())
      .toBe('2026-07-24T12:45:00.000Z');
    expect(resolveDeferredStart({ startIn: '3h', now: NOW }).startAt?.toISOString())
      .toBe('2026-07-24T15:00:00.000Z');
    expect(resolveDeferredStart({ startIn: '2d', now: NOW }).startAt?.toISOString())
      .toBe('2026-07-26T12:00:00.000Z');
  });

  it('uses a known future budget reset for the budget_reset anchor', () => {
    const result = resolveDeferredStart({
      startAfter: 'budget_reset',
      knownBudgetResetAt: new Date('2026-07-24T14:30:00.000Z'),
      now: NOW,
    });
    expect(result.startAt?.toISOString()).toBe('2026-07-24T14:30:00.000Z');
    expect(result.resolution).toBe('known_budget_reset');
  });

  it('falls back to the configurable five-hour window without an active reset', () => {
    const result = resolveDeferredStart({ startAfter: 'budget_reset', now: NOW });
    expect(result.startAt?.toISOString()).toBe('2026-07-24T17:00:00.000Z');
    expect(result.resolution).toBe('default_budget_window');
  });

  it('rejects ambiguous, malformed, and past inputs', () => {
    expect(() => resolveDeferredStart({ startAt: NOW.toISOString(), startIn: '3h', now: NOW }))
      .toThrow('only one');
    expect(() => resolveDeferredStart({ startIn: 'later', now: NOW })).toThrow('startIn');
    expect(() => resolveDeferredStart({ startAt: '2026-07-24T11:00:00Z', now: NOW }))
      .toThrow('future');
  });
});

describe('laterStartAt', () => {
  it('keeps the later of explicit, mission, and budget resume floors', () => {
    expect(laterStartAt(
      new Date('2026-07-24T13:00:00Z'),
      new Date('2026-07-24T15:00:00Z'),
    )?.toISOString()).toBe('2026-07-24T15:00:00.000Z');
  });
});
