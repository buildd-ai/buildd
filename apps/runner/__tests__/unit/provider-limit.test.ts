/**
 * Spec 0dc7c6de R-18, R-19, AC-9 (runner side): the provider's own warning holds new work on
 * that provider until its reset time; nothing is learned or stored beyond that time.
 */
import { describe, test, expect } from 'bun:test';
import { ProviderLimitHolds, limitFromEvent, providerOfBackend } from '../../src/provider-limit';

const NOW = Date.parse('2026-10-23T10:00:00Z');
const ev = (info: Record<string, unknown>) => ({ type: 'system', subtype: 'rate_limit', rate_limit_info: info });

describe('limitFromEvent', () => {
  test('a warning with a reset time holds that provider until the reset (unix seconds)', () => {
    const l = limitFromEvent(ev({ status: 'allowed_warning', rateLimitType: 'five_hour', resetsAt: (NOW + 3_600_000) / 1000 }), 'claude', NOW)!;
    expect(l).toMatchObject({ provider: 'claude', status: 'warning', kind: 'five_hour', untilMs: NOW + 3_600_000 });
  });
  test('milliseconds are accepted too', () => {
    expect(limitFromEvent(ev({ status: 'allowed_warning', resetsAt: NOW + 60_000 }), 'claude', NOW)!.untilMs).toBe(NOW + 60_000);
  });
  test('a warning without a reset holds nothing: that would be a guess', () => {
    expect(limitFromEvent(ev({ status: 'allowed_warning', utilization: 0.9 }), 'claude', NOW)).toBeNull();
  });
  test('a warning whose reset already passed holds nothing', () => {
    expect(limitFromEvent(ev({ status: 'allowed_warning', resetsAt: NOW - 1000 }), 'claude', NOW)).toBeNull();
  });
  test('allowed and utilization-only events hold nothing', () => {
    expect(limitFromEvent(ev({ status: 'allowed', resetsAt: NOW + 1e6 }), 'claude', NOW)).toBeNull();
    expect(limitFromEvent({ subtype: 'rate_limit', utilization: 0.99 }, 'claude', NOW)).toBeNull();
  });
  test('a rejection without a reset holds briefly, as a rejection', () => {
    const l = limitFromEvent(ev({ status: 'rejected', rateLimitType: 'seven_day' }), 'codex', NOW)!;
    expect(l).toMatchObject({ provider: 'codex', status: 'rejected', kind: 'seven_day' });
    expect(l.untilMs).toBeGreaterThan(NOW);
  });
});

describe('ProviderLimitHolds', () => {
  const claudeWarn = { provider: 'claude' as const, status: 'warning' as const, kind: 'five_hour', untilMs: NOW + 3_600_000 };

  test('a Claude hold leaves Codex free (AC-9, per provider)', () => {
    const h = new ProviderLimitHolds();
    h.hold(claudeWarn);
    expect(h.isHeld('claude', NOW)).toBe(true);
    expect(h.isHeld('codex', NOW)).toBe(false);
    expect(h.allHeld(NOW)).toBe(false);
  });

  test('the hold lifts at resetsAt by itself', () => {
    const h = new ProviderLimitHolds();
    h.hold(claudeWarn);
    expect(h.isHeld('claude', NOW + 3_599_999)).toBe(true);
    expect(h.isHeld('claude', NOW + 3_600_000)).toBe(false);
    expect(h.list(NOW + 3_600_000)).toEqual([]);
  });

  test('holds never shorten, and a rejection is kept over a later warning', () => {
    const h = new ProviderLimitHolds();
    h.hold({ ...claudeWarn, status: 'rejected' });
    h.hold({ ...claudeWarn, untilMs: NOW + 1000 });
    expect(h.heldUntil('claude', NOW)).toBe(NOW + 3_600_000);
    expect(h.report(NOW)[0].status).toBe('rejected');
  });

  test('state is the provider, kind, status and reset time and nothing else', () => {
    const h = new ProviderLimitHolds();
    h.hold(claudeWarn);
    h.hold({ ...claudeWarn, untilMs: NOW + 7_200_000 });
    expect(Object.keys(h.list(NOW)[0]).sort()).toEqual(['kind', 'provider', 'status', 'untilMs']);
    expect(h.list(NOW)).toHaveLength(1);
    expect(h.report(NOW)).toEqual([{ provider: 'claude', status: 'warning', kind: 'five_hour', resetsAt: new Date(NOW + 7_200_000).toISOString() }]);
  });

  test('providerOfBackend defaults to claude', () => {
    expect(providerOfBackend(undefined)).toBe('claude');
    expect(providerOfBackend('codex')).toBe('codex');
  });
});
