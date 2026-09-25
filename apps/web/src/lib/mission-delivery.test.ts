/**
 * The Delivery stepper model (docs/design/mission-feed-mobile-continuity.md,
 * W2 "Delivery", addendum D5): one line that replaces the progress card, the
 * mission PR card, the release card, the budget cards and the completion stat
 * tiles. Empty steps are hidden.
 */
import { describe, expect, it } from 'bun:test';
import { buildDeliverySteps, deliveryReleaseInput, formatDeliverySummary, missionTrunkMergedAt, type DeliveryInput } from './mission-delivery';

const base: DeliveryInput = {
  missionStatus: 'active',
  totalTasks: 6,
  completedTasks: 4,
  awaitingMerge: 0,
  integrationPr: null,
  criteria: { total: 0, passed: null, overall: null },
  mergedAt: [],
  release: null,
  budget: null,
};

const keys = (input: DeliveryInput) => buildDeliverySteps(input).map(s => s.key);

describe('buildDeliverySteps', () => {
  it('shows only Integrated for a mission with tasks and nothing else to report', () => {
    const steps = buildDeliverySteps(base);
    expect(steps.map(s => s.key)).toEqual(['integrated']);
    expect(steps[0]).toMatchObject({ state: 'partial', value: '4/6' });
  });

  it('renders no steps at all for a mission with no tasks, no criteria and no budget', () => {
    expect(buildDeliverySteps({ ...base, totalTasks: 0, completedTasks: 0 })).toEqual([]);
  });

  it('marks Integrated done only when every task landed and no mission PR is still open', () => {
    expect(buildDeliverySteps({ ...base, completedTasks: 6 })[0].state).toBe('done');
    const openPr = buildDeliverySteps({
      ...base,
      completedTasks: 6,
      integrationPr: { branch: 'mission/example', state: 'open', prNumber: 7, prUrl: 'https://example.test/pr/7', taskId: null },
    })[0];
    expect(openPr.state).toBe('partial');
    expect(openPr.detail).toContain('mission PR #7');
  });

  it('marks Integrated todo when nothing has landed', () => {
    expect(buildDeliverySteps({ ...base, completedTasks: 0 })[0].state).toBe('todo');
  });

  it('carries the completion stats (PRs, duration) on the Integrated detail — D5, no stat tiles', () => {
    const step = buildDeliverySteps({ ...base, missionStatus: 'completed', completedTasks: 6, prCount: 5, durationLabel: '3h 20m' })[0];
    expect(step.detail).toContain('5 PRs');
    expect(step.detail).toContain('3h 20m');
  });

  it('adds Verified only when the mission has criteria, and reports an unevaluated gate as ?/N', () => {
    expect(keys({ ...base, criteria: { total: 3, passed: 2, overall: 'UNVERIFIED' } })).toEqual(['integrated', 'verified']);
    const unevaluated = buildDeliverySteps({ ...base, criteria: { total: 3, passed: null, overall: null } })[1];
    expect(unevaluated.value).toBe('?/3');
    expect(unevaluated.state).toBe('todo');
  });

  it('marks Verified done on pass and blocked on fail', () => {
    expect(buildDeliverySteps({ ...base, criteria: { total: 3, passed: 3, overall: 'pass' } })[1].state).toBe('done');
    expect(buildDeliverySteps({ ...base, criteria: { total: 3, passed: 1, overall: 'fail' } })[1].state).toBe('blocked');
  });

  // D6: the Shipped step reads THIS mission's merges against the release
  // baseline. The workspace queue depth is a workspace fact and never decides it.
  const BASELINE = '2026-03-10T12:00:00.000Z';
  const BEFORE = '2026-03-09T08:00:00.000Z';
  const AFTER = '2026-03-11T08:00:00.000Z';

  it('says "after next release" only when some mission merge is newer than the release baseline', () => {
    const shipped = buildDeliverySteps({ ...base, mergedAt: [BEFORE, AFTER], release: { releasedThrough: BASELINE } }).find(s => s.key === 'shipped')!;
    expect(shipped.detail).toBe('after next release');
    expect(shipped.state).toBe('partial');
    expect(shipped.detail).not.toMatch(/unshipped/);
    const none = buildDeliverySteps({ ...base, mergedAt: [AFTER], release: { releasedThrough: BASELINE } }).find(s => s.key === 'shipped')!;
    expect(none).toMatchObject({ state: 'todo', value: '–', detail: 'after next release' });
  });

  it('says released only when every mission merge is at or before the baseline', () => {
    const shipped = buildDeliverySteps({ ...base, completedTasks: 6, mergedAt: [BEFORE, BASELINE], release: { releasedThrough: BASELINE } }).find(s => s.key === 'shipped')!;
    expect(shipped).toMatchObject({ state: 'done', detail: 'released' });
    const partial = buildDeliverySteps({ ...base, mergedAt: [BEFORE], release: { releasedThrough: BASELINE } }).find(s => s.key === 'shipped')!;
    expect(partial.state).toBe('partial');
    expect(partial.detail).toMatch(/released/);
  });

  it('hides Shipped for a mission with nothing merged, even while another mission holds the queue (regression)', () => {
    // 0/6 completed, workspace gated queue non-empty because of OTHER missions.
    expect(keys({ ...base, completedTasks: 0, mergedAt: [], release: { releasedThrough: BASELINE } })).not.toContain('shipped');
    expect(keys({ ...base, completedTasks: 0, mergedAt: [], release: { releasedThrough: 'all' } })).not.toContain('shipped');
  });

  it('keeps a released mission released when another mission merges after the release (regression)', () => {
    // The workspace queue is non-empty (another mission merged AFTER), but this
    // mission's merges predate the baseline, so its step must not flip back.
    const shipped = buildDeliverySteps({ ...base, completedTasks: 6, mergedAt: [BEFORE], release: { releasedThrough: BASELINE } }).find(s => s.key === 'shipped')!;
    expect(shipped.detail).toBe('released');
  });

  it('does not call a deploy that predates the mission merge "released"', () => {
    const shipped = buildDeliverySteps({ ...base, completedTasks: 6, mergedAt: [AFTER], release: { releasedThrough: BASELINE } }).find(s => s.key === 'shipped')!;
    expect(shipped.detail).toBe('after next release');
  });

  it('reads a zero workspace queue as every merge released', () => {
    const shipped = buildDeliverySteps({ ...base, completedTasks: 6, mergedAt: [AFTER], release: { releasedThrough: 'all' } }).find(s => s.key === 'shipped')!;
    expect(shipped.state).toBe('done');
  });

  it('accepts Postgres ::text timestamps for both sides', () => {
    const shipped = buildDeliverySteps({ ...base, completedTasks: 6, mergedAt: ['2026-03-09 08:00:00.12+00'], release: { releasedThrough: '2026-03-10 12:00:00+00' } }).find(s => s.key === 'shipped')!;
    expect(shipped.detail).toBe('released');
  });

  it('hides Shipped for a workspace with no release flow or an unparseable baseline', () => {
    expect(keys({ ...base, mergedAt: [BEFORE], release: null })).not.toContain('shipped');
    expect(keys({ ...base, mergedAt: [BEFORE], release: { releasedThrough: 'not a date' } })).not.toContain('shipped');
  });

  it('shows Budget only when it blocks or is close to the cap', () => {
    expect(keys({ ...base, budget: { budgetUsd: 10, spendUsd: 2, exhausted: false } })).not.toContain('budget');
    const near = buildDeliverySteps({ ...base, budget: { budgetUsd: 10, spendUsd: 8.5, exhausted: false } }).find(s => s.key === 'budget')!;
    expect(near).toMatchObject({ state: 'partial', value: '85%' });
    const capped = buildDeliverySteps({ ...base, budget: { budgetUsd: 10, spendUsd: 10, exhausted: true } }).find(s => s.key === 'budget')!;
    expect(capped).toMatchObject({ state: 'blocked', detail: 'paused at cap' });
  });

  it('orders steps Integrated → Verified → Visual review → Shipped → Budget', () => {
    expect(keys({
      ...base,
      criteria: { total: 2, passed: 1, overall: 'UNVERIFIED' },
      visual: { shots: 4, ok: 4, issues: 0, unsure: 0 },
      mergedAt: [AFTER],
      release: { releasedThrough: BASELINE },
      budget: { budgetUsd: 10, spendUsd: 10, exhausted: true },
    })).toEqual(['integrated', 'verified', 'visual', 'shipped', 'budget']);
  });

  // docs/design/visual-qa-auditor.md, "Where the screenshots show". Verdicts
  // are advisory: only a boot failure blocks (and so auto-opens <details>).
  describe('Visual review step', () => {
    const visual = (v: NonNullable<DeliveryInput['visual']>) =>
      buildDeliverySteps({ ...base, visual: v }).find(s => s.key === 'visual');

    it('is hidden when the mission has no audit and no shots', () => {
      expect(keys({ ...base, visual: null })).not.toContain('visual');
      expect(keys(base)).not.toContain('visual');
    });

    it('is done with a shot count when every shot is ok', () => {
      expect(visual({ shots: 8, ok: 8, issues: 0, unsure: 0 })).toMatchObject({
        label: 'Visual review', state: 'done', value: '8 shots', detail: '8 shots, all ok',
      });
      expect(visual({ shots: 1, ok: 1, issues: 0, unsure: 0 })!.value).toBe('1 shot');
    });

    it('is partial, never blocked, when a shot has an issue or is unsure', () => {
      expect(visual({ shots: 12, ok: 9, issues: 2, unsure: 1 })).toMatchObject({
        state: 'partial', value: '2✕ 1?', detail: '12 shots · 2 issues · 1 unsure',
      });
      expect(visual({ shots: 4, ok: 3, issues: 1, unsure: 0 })).toMatchObject({ state: 'partial', value: '1✕', detail: '4 shots · 1 issue' });
      expect(visual({ shots: 4, ok: 3, issues: 0, unsure: 1 })).toMatchObject({ state: 'partial', value: '1?' });
    });

    it('is todo while the audit is open with no shots yet', () => {
      expect(visual({ shots: 0, ok: 0, issues: 0, unsure: 0 })).toMatchObject({ state: 'todo', value: '–', detail: 'waiting for the visual audit' });
    });

    it('is partial when fewer shots than required were captured', () => {
      expect(visual({ shots: 4, ok: 4, issues: 0, unsure: 0, required: 8 })).toMatchObject({
        state: 'partial', value: '4/8', detail: '4 of 8 required shots, all ok',
      });
      expect(visual({ shots: 8, ok: 8, issues: 0, unsure: 0, required: 8 })!.state).toBe('done');
    });

    // Coverage counts required route × viewport cells, not shots: a re-shoot or
    // an extra route the auditor added must not make "8 shots" read as 8/8.
    it('reads coverage from covered cells when known, not from the shot count', () => {
      expect(visual({ shots: 10, ok: 10, issues: 0, unsure: 0, required: 8, covered: 6 })).toMatchObject({
        state: 'partial', value: '6/8', detail: '6 of 8 required shots, all ok',
      });
      expect(visual({ shots: 9, ok: 9, issues: 0, unsure: 0, required: 8, covered: 8 })).toMatchObject({
        state: 'done', value: '9 shots',
      });
    });

    it('is blocked only when the app did not boot', () => {
      expect(visual({ shots: 0, ok: 0, issues: 0, unsure: 0, bootFailed: true })).toMatchObject({
        state: 'blocked', value: 'boot', detail: 'the app did not boot for the visual audit',
      });
    });
  });
});

describe('deliveryReleaseInput', () => {
  it('reads a gated queue as released through its baseline, never as "this mission waits"', () => {
    expect(deliveryReleaseInput({
      state: 'unseeded', archetype: 'gated', seeded: true, baselineSource: 'healthy',
      queueDepth: 3, oldestMergedAt: null, releaseId: null, baselineAsOf: '2026-03-10T12:00:00.000Z',
    })).toEqual({ releasedThrough: '2026-03-10T12:00:00.000Z' });
    expect(deliveryReleaseInput({
      state: 'unseeded', archetype: 'gated', seeded: true, baselineSource: 'healthy',
      queueDepth: 3, oldestMergedAt: null, releaseId: null,
    })).toBeNull();
  });

  it('reads a clean gated queue as every merge released', () => {
    expect(deliveryReleaseInput({ state: 'clean', reason: 'zero_queue' })).toEqual({ releasedThrough: 'all' });
  });

  it('reads a healthy continuous deploy as released through its deploy time, and any other deploy state as unknown', () => {
    const continuous = (deployState: string, healthyAt: string | null = '2026-03-10T12:00:00.000Z') => ({
      state: 'unseeded' as const, archetype: 'continuous' as const, seeded: deployState === 'healthy',
      deployState, deployedAt: '2026-03-10T11:50:00.000Z', healthyAt, releaseId: null,
    });
    expect(deliveryReleaseInput(continuous('healthy'))).toEqual({ releasedThrough: '2026-03-10T12:00:00.000Z' });
    expect(deliveryReleaseInput(continuous('healthy', null))).toEqual({ releasedThrough: '2026-03-10T11:50:00.000Z' });
    expect(deliveryReleaseInput(continuous('failed'))).toBeNull();
  });

  it('claims nothing when there is no release flow or no baseline', () => {
    expect(deliveryReleaseInput({ state: 'none' })).toBeNull();
    expect(deliveryReleaseInput({ state: 'clean', reason: 'no_baseline' })).toBeNull();
    expect(deliveryReleaseInput({ state: 'clean', reason: 'no_pipeline' })).toBeNull();
  });
});

describe('missionTrunkMergedAt', () => {
  const task = (id: string, mergedAt: string | null, taskClass = 'work') => ({ id, taskClass, workers: [{ mergedAt }] });

  it('lists every worker merge for a mission without an integration branch', () => {
    expect(missionTrunkMergedAt([task('a', '2026-03-01T00:00:00Z'), task('b', null)], null)).toEqual(['2026-03-01T00:00:00Z']);
  });

  it('normalises Date merges to ISO strings', () => {
    expect(missionTrunkMergedAt([{ id: 'a', workers: [{ mergedAt: new Date('2026-03-01T00:00:00Z') }] }], null)).toEqual(['2026-03-01T00:00:00.000Z']);
  });

  it('counts only the merged integration PR for an integration-branch mission', () => {
    const tasks = [task('a', '2026-03-01T00:00:00Z'), task('pr', '2026-03-05T00:00:00Z', 'bookkeeping')];
    const open = { branch: 'mission/example', state: 'open' as const, prNumber: 7, prUrl: null, taskId: 'pr' };
    expect(missionTrunkMergedAt(tasks, open)).toEqual([]);
    expect(missionTrunkMergedAt(tasks, { ...open, state: 'merged' as const })).toEqual(['2026-03-05T00:00:00Z']);
  });
});

describe('formatDeliverySummary', () => {
  it('joins every visible step into one line with its state glyph', () => {
    const line = formatDeliverySummary(buildDeliverySteps({
      ...base,
      criteria: { total: 3, passed: 2, overall: 'UNVERIFIED' },
      mergedAt: ['2026-03-11T08:00:00.000Z'],
      release: { releasedThrough: '2026-03-10T12:00:00.000Z' },
    }));
    expect(line).toBe('Integrated ◐ 4/6 · Verified ◐ 2/3 · Shipped ○ –');
  });

  it('is empty for no steps', () => {
    expect(formatDeliverySummary([])).toBe('');
  });
});
