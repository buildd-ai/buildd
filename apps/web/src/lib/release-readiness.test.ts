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
});
