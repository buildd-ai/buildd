import { describe, expect, it } from 'bun:test';
import { computeReleaseWidgetDecision } from './release-readiness';

const val = (n: number) => ({ kind: 'value' as const, value: n });
const noBaseline = { kind: 'unavailable' as const, reason: 'no_baseline' as const };

describe('computeReleaseWidgetDecision', () => {
  it('(a) CI passing + 3 commits ahead → show', () => {
    expect(computeReleaseWidgetDecision(val(3), 'passing')).toBe('show');
  });

  it('(b) CI failing + 3 commits ahead → ci_blocking (hide main widget)', () => {
    const decision = computeReleaseWidgetDecision(val(3), 'failing');
    expect(decision).not.toBe('show');
    expect(decision).toBe('ci_blocking');
  });

  it('(c) CI passing + 0 commits → hide', () => {
    expect(computeReleaseWidgetDecision(val(0), 'passing')).toBe('hide');
  });

  it('CI pending + commits → ci_blocking', () => {
    expect(computeReleaseWidgetDecision(val(5), 'pending')).toBe('ci_blocking');
  });

  it('CI unknown (no releases yet) + commits → show optimistically', () => {
    expect(computeReleaseWidgetDecision(val(2), 'unknown')).toBe('show');
  });

  it('zero commits regardless of CI state → hide', () => {
    expect(computeReleaseWidgetDecision(val(0), 'failing')).toBe('hide');
    expect(computeReleaseWidgetDecision(val(0), 'pending')).toBe('hide');
    expect(computeReleaseWidgetDecision(val(0), 'unknown')).toBe('hide');
  });

  // Null-baseline regression: when no healthy releases row exists the queue
  // depth is structurally unavailable (no_baseline) — the widget must hide,
  // not show an epoch-inflated count or a misleading zero.
  it('null-baseline (no healthy releases row) → unavailable → hide', () => {
    expect(computeReleaseWidgetDecision(noBaseline, 'unknown')).toBe('hide');
    expect(computeReleaseWidgetDecision(noBaseline, 'passing')).toBe('hide');
    expect(computeReleaseWidgetDecision(noBaseline, 'failing')).toBe('hide');
  });

  it('genesis baseline + 4 merged workers → show', () => {
    expect(computeReleaseWidgetDecision(val(4), 'passing')).toBe('show');
    expect(computeReleaseWidgetDecision(val(4), 'unknown')).toBe('show');
  });

  // Failed-dispatch poisoning: a stale/failed CI reading must never suppress
  // the CTA, and a count that grossly disagrees with the last commits-ahead
  // snapshot must render as an error, not as a big number.
  it('CI reading resolved as unknown (stale or failed-derived) + commits ahead → show, never ci_blocking', () => {
    expect(computeReleaseWidgetDecision(val(24), 'unknown')).toBe('show');
  });

  it('regression guard: a healthy, fresh failing reading still blocks (the real gate is untouched)', () => {
    expect(computeReleaseWidgetDecision(val(24), 'failing')).toBe('ci_blocking');
  });

  it('count grossly exceeds the last commits-ahead snapshot → error, not a large number', () => {
    expect(computeReleaseWidgetDecision(val(859), 'passing', 4)).toBe('error');
  });

  it('count is a small fraction of the last commits-ahead snapshot → error', () => {
    expect(computeReleaseWidgetDecision(val(2), 'passing', 40)).toBe('error');
  });

  it('count within a trivial margin of the commits-ahead snapshot → show as usual', () => {
    expect(computeReleaseWidgetDecision(val(24), 'passing', 17)).toBe('show');
  });

  it('no commits-ahead snapshot available → divergence check is skipped', () => {
    expect(computeReleaseWidgetDecision(val(24), 'passing', null)).toBe('show');
    expect(computeReleaseWidgetDecision(val(24), 'passing')).toBe('show');
  });
});
