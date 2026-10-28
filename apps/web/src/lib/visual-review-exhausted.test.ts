import { describe, expect, it } from 'bun:test';
import type { VisualReviewExhaustedFinding } from '@buildd/shared';
import { buildVisualReviewFixtureModel } from './visual-review-model.fixtures';
import { planExhaustedFixes } from './visual-review-exhausted';

const f = (over: Partial<VisualReviewExhaustedFinding> = {}): VisualReviewExhaustedFinding => ({
  key: '/app/a|mobile|', route: '/app/a', viewport: 'mobile', variant: null, finding: 'Header overflows', artifactId: 'art-1', src: '/api/artifacts/art-1/download', ...over,
});

describe('exhausted findings in the model', () => {
  it('lists the screens still open when the round cap is reached', () => {
    const m = buildVisualReviewFixtureModel('needs_you', { needsYou: 'round_cap' });
    expect(m.roundCapOpen).toBe(true);
    expect(m.exhaustedFindings?.length).toBeGreaterThan(0);
    for (const e of m.exhaustedFindings!) expect(m.cells.find(c => c.key === e.key)?.standing).not.toBe('fine');
  });

  it('lists nothing while the automatic rounds still run', () => {
    expect(buildVisualReviewFixtureModel('fixing').exhaustedFindings ?? []).toEqual([]);
  });
});

describe('planExhaustedFixes', () => {
  it('files one [surface fix] per route, phone and desktop together', () => {
    const drafts = planExhaustedFixes('12345678-aaaa-bbbb', [f(), f({ key: '/app/a|desktop|', viewport: 'desktop', artifactId: 'art-2' }), f({ route: '/app/b', key: '/app/b|mobile|', artifactId: 'art-3' })]);
    expect(drafts.map(d => d.route)).toEqual(['/app/a', '/app/b']);
    expect(drafts[0].title).toBe('[surface fix] /app/a: Header overflows');
    expect(drafts[0].artifactIds).toEqual(['art-1', 'art-2']);
    expect(drafts[0].description).toContain('12345678');
    expect(drafts[0].description).not.toContain('12345678-aaaa-bbbb');
  });

  it('files nothing when no finding is exhausted', () => {
    expect(planExhaustedFixes('m', [])).toEqual([]);
  });

  it('bounds a long finding in the title', () => {
    expect(planExhaustedFixes('m', [f({ finding: 'x'.repeat(400) })])[0].title.length).toBeLessThanOrEqual(200);
  });
});
