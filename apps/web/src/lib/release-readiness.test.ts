import { describe, expect, it } from 'bun:test';
import { computeReleaseWidgetDecision } from './release-readiness';

describe('computeReleaseWidgetDecision', () => {
  it('(a) CI passing + 3 commits ahead → show', () => {
    expect(computeReleaseWidgetDecision(3, 'passing')).toBe('show');
  });

  it('(b) CI failing + 3 commits ahead → ci_blocking (hide main widget)', () => {
    const decision = computeReleaseWidgetDecision(3, 'failing');
    expect(decision).not.toBe('show');
    expect(decision).toBe('ci_blocking');
  });

  it('(c) CI passing + 0 commits → hide', () => {
    expect(computeReleaseWidgetDecision(0, 'passing')).toBe('hide');
  });

  it('CI pending + commits → ci_blocking', () => {
    expect(computeReleaseWidgetDecision(5, 'pending')).toBe('ci_blocking');
  });

  it('CI unknown (no releases yet) + commits → show optimistically', () => {
    expect(computeReleaseWidgetDecision(2, 'unknown')).toBe('show');
  });

  it('zero commits regardless of CI state → hide', () => {
    expect(computeReleaseWidgetDecision(0, 'failing')).toBe('hide');
    expect(computeReleaseWidgetDecision(0, 'pending')).toBe('hide');
    expect(computeReleaseWidgetDecision(0, 'unknown')).toBe('hide');
  });

  // Null-baseline regression: when no healthy releases row exists the SQL
  // comparison `mergedAt > NULL` evaluates to NULL (no match), so queueDepth
  // comes back 0 from the DB — the widget must hide, not show an epoch-inflated
  // count (e.g. 859 unshipped based on the first-ever merged worker).
  it('null-baseline (no healthy releases row) → queueDepth 0 → hide', () => {
    // The DB layer returns 0 when there is no baseline; verify the decision gate.
    expect(computeReleaseWidgetDecision(0, 'unknown')).toBe('hide');
    expect(computeReleaseWidgetDecision(0, 'passing')).toBe('hide');
  });

  it('genesis baseline + 4 merged workers → show', () => {
    expect(computeReleaseWidgetDecision(4, 'passing')).toBe('show');
    expect(computeReleaseWidgetDecision(4, 'unknown')).toBe('show');
  });
});
