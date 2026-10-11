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

describe('the heading says what this result is (docs/specs/task-page.md)', () => {
  const SCREENSHOT = JSON.stringify({ summary: 'Both PRs land.\n\nRecovery is unblocked.', verdict: 'approve', confidence: 0.8 });

  it('AC-1: a review run is headed "Review of PR #N", never What shipped, with its summary as prose', () => {
    const v = buildTaskShippedView(input({ record: null, conventionalType: null, summary: SCREENSHOT, subject: { kind: 'review', prNumber: 4413 }, shipped: false }))!;
    expect(v.eyebrow).toBe('Review of PR #4413');
    expect(v.resultProse).toBe('Both PRs land.\n\nRecovery is unblocked.');
    // The prose leads the body, so the Technical summary does not repeat it, and no JSON is shown as a summary.
    expect(v.technicalSummary).toBeNull();
    expect(v.raw).toEqual({ summary: 'Both PRs land.\n\nRecovery is unblocked.', verdict: 'approve', confidence: 0.8 });
  });

  it('an unmerged deliverable is a Result, not What shipped', () => {
    expect(buildTaskShippedView(input({ shipped: false }))!.eyebrow).toBe('Result · Feature');
    expect(buildTaskShippedView(input({ shipped: true }))!.eyebrow).toBe('What shipped · Feature');
  });

  it('a fix run is headed as a fix for the PR', () => {
    expect(buildTaskShippedView(input({ subject: { kind: 'fix', prNumber: 7 }, shipped: false }))!.eyebrow).toBe('Fix for PR #7');
  });

  it('a JSON summary on a deliverable reads as prose in the Technical summary, raw kept aside', () => {
    const v = buildTaskShippedView(input({ summary: '{"summary":"Did the thing.","confidence":0.5}' }))!;
    expect(v.technicalSummary).toBe('Did the thing.');
    expect(v.raw).toEqual({ summary: 'Did the thing.', confidence: 0.5 });
  });

  it('structuredOutput never becomes the summary text', () => {
    const v = buildTaskShippedView(input({ summary: 'Plain prose.', structuredOutput: { verdict: 'approve', confidence: 0.8 } }))!;
    expect(v.technicalSummary).toBe('Plain prose.');
    expect(v.raw).toEqual({ verdict: 'approve', confidence: 0.8 });
  });
});
