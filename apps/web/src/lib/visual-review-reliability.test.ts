import { describe, expect, it } from 'bun:test';
import { formatVisualReviewReliability, reliabilityLine, visualReviewReliability } from './visual-review-reliability';

const NOW = new Date('2026-10-23T12:00:00Z').getTime();
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

// Spec 072de598 r15 AC-27.
describe('visual review reliability', () => {
  it('three missions in 7 days, one passed, one skipped as wrong or stuck, one shipped anyway: 2 of 3, and the cause is listed', () => {
    const r = visualReviewReliability({
      finishedAudits: [{ missionId: 'passed', at: daysAgo(1) }, { missionId: 'wrong', at: daysAgo(2) }],
      skips: [
        { missionId: 'wrong', at: daysAgo(2), skipReason: 'wrong_or_stuck', cause: 'app_boot_failed' },
        { missionId: 'ship', at: daysAgo(3), skipReason: 'ship_anyway', cause: 'findings_wrong' },
      ],
    }, NOW);
    const week = r.windows[0];
    expect(week).toMatchObject({ days: 7, missions: 3, reliable: 2, wrongOrStuck: 1, shipAnyway: 1 });
    expect(week.share).toBeCloseTo(2 / 3);
    expect(week.causes).toEqual([{ cause: 'app_boot_failed', count: 1, text: 'the app did not boot for the audit' }]);
    expect(reliabilityLine(week)).toBe('2 of 3 missions finished visual review without a wrong-or-stuck Skip in the last 7 days.');
    const text = formatVisualReviewReliability(r);
    expect(text).toContain('2 of 3 missions');
    expect(text).toContain('the app did not boot for the audit');
  });

  it('the 30-day window counts what the 7-day one leaves out; recurring causes are counted per Skip', () => {
    const r = visualReviewReliability({
      finishedAudits: [{ missionId: 'old', at: daysAgo(20) }],
      skips: [
        { missionId: 'a', at: daysAgo(10), skipReason: 'wrong_or_stuck', cause: 'stalled' },
        { missionId: 'b', at: daysAgo(12), skipReason: 'wrong_or_stuck', cause: 'stalled' },
        { missionId: 'c', at: daysAgo(40), skipReason: 'wrong_or_stuck', cause: 'stalled' },
      ],
    }, NOW);
    expect(r.windows[0]).toMatchObject({ missions: 0, share: null });
    expect(reliabilityLine(r.windows[0])).toBe('No mission finished visual review in the last 7 days.');
    expect(r.windows[1]).toMatchObject({ days: 30, missions: 3, reliable: 1, wrongOrStuck: 2 });
    expect(r.windows[1].causes).toEqual([{ cause: 'stalled', count: 2, text: 'the audit stalled' }]);
  });

  it('a free-text waiver counts as finished and is not a wrong-or-stuck Skip', () => {
    const r = visualReviewReliability({ finishedAudits: [], skips: [{ missionId: 'x', at: daysAgo(1), skipReason: null, cause: null }] }, NOW);
    expect(r.windows[0]).toMatchObject({ missions: 1, reliable: 1, wrongOrStuck: 0, shipAnyway: 0 });
  });
});
