import { describe, expect, it } from 'bun:test';
import { buildTaskShippedView, shippedEyebrow, type BuildTaskShippedViewInput } from './task-shipped-header';

const LEDE = 'A finished task now opens on a plain sentence about what changed.';

const input = (over: Partial<BuildTaskShippedViewInput> = {}): BuildTaskShippedViewInput => ({
  taskStatus: 'completed',
  taskMode: 'execution',
  conventionalType: 'feat',
  category: 'feature',
  record: { version: 1, lede: LEDE, changeType: 'frontend', offPlan: [], prNumber: 416, computedAt: '' },
  summary: 'Added `TaskShippedHeader` in apps/web/src/app/...',
  summarySource: 'agent',
  heroShots: [],
  ...over,
});

describe('when the header applies', () => {
  it('only on a completed, non-planning task', () => {
    expect(buildTaskShippedView(input({ taskStatus: 'failed' }))).toBeNull();
    expect(buildTaskShippedView(input({ taskStatus: 'pending' }))).toBeNull();
    expect(buildTaskShippedView(input({ taskMode: 'planning' }))).toBeNull();
    expect(buildTaskShippedView(input())).not.toBeNull();
  });
});

describe('the lede card', () => {
  it('carries the lede and where the change shows; no status chips or actions (the verdict owns those)', () => {
    const v = buildTaskShippedView(input())!;
    expect(v.eyebrow).toBe('What shipped · Feature');
    expect(v.lede).toBe(LEDE);
    expect(v.changeTypeLabel).toBe('On screen');
    expect(Object.keys(v)).not.toContain('chips');
    expect(Object.keys(v)).not.toContain('action');
    expect(Object.keys(v)).not.toContain('hiccup');
  });
});

describe('no lede', () => {
  it('shows the title only and keeps the raw handoff for the Technical summary', () => {
    const v = buildTaskShippedView(input({ record: null }))!;
    expect(v.lede).toBeNull();
    expect(v.changeTypeLabel).toBeNull();
    expect(v.technicalSummary).toContain('TaskShippedHeader');
  });

  it('drops off-plan lines with the lede', () => {
    const v = buildTaskShippedView(input({ record: { version: 1, lede: null, changeType: 'backend', offPlan: ['x'], prNumber: 1, computedAt: '' } }))!;
    expect(v.offPlan).toEqual([]);
    expect(v.changeTypeLabel).toBe('Behind the scenes');
  });

  it('marks a runner-captured summary as unauthored', () => {
    expect(buildTaskShippedView(input({ summarySource: 'fallback' }))!.technicalSummaryIsFallback).toBe(true);
  });
});

describe('eyebrow', () => {
  it('names the conventional type, then falls back to the category', () => {
    expect(shippedEyebrow('fix', 'feature')).toBe('What shipped · Fix');
    expect(shippedEyebrow(null, 'research')).toBe('What shipped · Research');
    expect(shippedEyebrow('wip', null)).toBe('What shipped');
  });
});

describe('hero shots', () => {
  it('shows at most three', () => {
    const shot = (n: number) => ({ artifactId: `s${n}`, route: '/app', viewport: 'mobile' as const, verdict: 'ok' as const });
    expect(buildTaskShippedView(input({ heroShots: [1, 2, 3, 4].map(shot) }))!.heroShots).toHaveLength(3);
  });
});
