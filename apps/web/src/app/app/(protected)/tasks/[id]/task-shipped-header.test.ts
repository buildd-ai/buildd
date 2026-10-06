import { describe, expect, it } from 'bun:test';
import { buildTaskShippedView, hiccupLabel, shippedEyebrow, type BuildTaskShippedViewInput } from './task-shipped-header';

const LEDE = 'A finished task now opens on a plain sentence about what changed.';
const PR_URL = 'https://github.com/acme/web/pull/416';

const input = (over: Partial<BuildTaskShippedViewInput> = {}): BuildTaskShippedViewInput => ({
  taskStatus: 'completed',
  taskMode: 'execution',
  conventionalType: 'feat',
  category: 'feature',
  record: { version: 1, lede: LEDE, changeType: 'frontend', offPlan: [], prNumber: 416, computedAt: '' },
  summary: 'Added `TaskShippedHeader` in apps/web/src/app/...',
  summarySource: 'agent',
  pr: { url: PR_URL, number: 416, lifecycle: 'ci_green', merged: false },
  heroShots: [],
  errorTraceCount: 0,
  inRelease: false,
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

describe('open PR', () => {
  it('says Done, waits on your merge, and offers Review & merge with checks and PR number under it', () => {
    const v = buildTaskShippedView(input())!;
    expect(v.eyebrow).toBe('What shipped · Feature');
    expect(v.chips.map(c => c.label)).toEqual(['Done', 'Ready to merge']);
    expect(v.action).toEqual({ label: 'Review & merge', href: PR_URL, tone: 'primary' });
    expect(v.actionMeta).toBe('Checks passing · PR #416');
    expect(v.mergedLine).toBeNull();
    expect(v.lede).toBe(LEDE);
    expect(v.changeTypeLabel).toBe('On screen');
  });

  it('red checks make the action reading the failures, in the danger tone', () => {
    const v = buildTaskShippedView(input({ pr: { url: PR_URL, number: 416, lifecycle: 'ci_failed', merged: false } }))!;
    expect(v.chips.map(c => c.label)).toEqual(['Done', 'Checks failing']);
    expect(v.action).toEqual({ label: 'View failing checks', href: `${PR_URL}/checks`, tone: 'danger' });
    expect(v.actionMeta).toBe('Checks failing · PR #416');
  });

  it('running checks still wait on you', () => {
    const v = buildTaskShippedView(input({ pr: { url: PR_URL, number: 416, lifecycle: 'ci_running', merged: false } }))!;
    expect(v.actionMeta).toBe('Checks running · PR #416');
    expect(v.action?.label).toBe('Review & merge');
  });
});

describe('open fix attempt', () => {
  const openAttempt = { taskId: 'fix-1', title: '[reviewer retry #1] Fix flaky date parsing', iteration: 1, maxIterations: 3, claimed: false };

  it('names the queued fix instead of inviting a merge the review gate would refuse', () => {
    const v = buildTaskShippedView(input({ openAttempt }))!;
    expect(v.chips.map(c => c.label)).toEqual(['Done', 'Fix 1 of 3 queued']);
    expect(v.action).toEqual({ label: 'View fix 1 of 3', href: '/app/tasks/fix-1', tone: 'primary' });
  });

  it('says "in progress" once a worker claims the fix', () => {
    const v = buildTaskShippedView(input({ openAttempt: { ...openAttempt, claimed: true } }))!;
    expect(v.chips.map(c => c.label)).toEqual(['Done', 'Fix 1 of 3 in progress']);
  });

  it('outranks a red-checks reading too — the fix is already in flight', () => {
    const v = buildTaskShippedView(input({
      pr: { url: PR_URL, number: 416, lifecycle: 'ci_failed', merged: false },
      openAttempt,
    }))!;
    expect(v.chips.map(c => c.label)).toEqual(['Done', 'Fix 1 of 3 queued']);
    expect(v.action?.href).toBe('/app/tasks/fix-1');
  });

  it('never applies once the PR has merged', () => {
    const v = buildTaskShippedView(input({
      pr: { url: PR_URL, number: 416, lifecycle: 'merged', merged: true },
      openAttempt,
    }))!;
    expect(v.chips.map(c => c.label)).toEqual(['Shipped']);
    expect(v.action).toBeNull();
  });
});

describe('merged', () => {
  it('says Shipped, offers no action, and names the PR quietly', () => {
    const v = buildTaskShippedView(input({ pr: { url: PR_URL, number: 416, lifecycle: 'merged', merged: true } }))!;
    expect(v.chips.map(c => c.label)).toEqual(['Shipped']);
    expect(v.action).toBeNull();
    expect(v.mergedLine).toEqual({ label: 'Merged · PR #416', href: PR_URL });
  });

  it('a task in a release is Shipped even without a merge stamp', () => {
    const v = buildTaskShippedView(input({ pr: null, inRelease: true }))!;
    expect(v.chips.map(c => c.label)).toEqual(['Shipped']);
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

describe('recovered errors', () => {
  it('become one quiet row linking to the traces', () => {
    expect(buildTaskShippedView(input({ errorTraceCount: 1 }))!.hiccup).toEqual({ label: 'One hiccup, already handled', href: '#agent-error-traces' });
    expect(buildTaskShippedView(input())!.hiccup).toBeNull();
  });

  it('count in words, then digits', () => {
    expect(hiccupLabel(0)).toBeNull();
    expect(hiccupLabel(3)).toBe('Three hiccups, already handled');
    expect(hiccupLabel(12)).toBe('12 hiccups, already handled');
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
