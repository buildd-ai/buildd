/**
 * The Delivery stepper model (docs/design/mission-feed-mobile-continuity.md,
 * W2 "Delivery", addendum D5): one line that replaces the progress card, the
 * mission PR card, the release card, the budget cards and the completion stat
 * tiles. Empty steps are hidden.
 */
import { describe, expect, it } from 'bun:test';
import { buildDeliverySteps, deliveryReleaseInput, formatDeliverySummary, type DeliveryInput } from './mission-delivery';

const base: DeliveryInput = {
  missionStatus: 'active',
  totalTasks: 6,
  completedTasks: 4,
  awaitingMerge: 0,
  integrationPr: null,
  criteria: { total: 0, passed: null, overall: null },
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

  it('shows Shipped as "after next release" while the workspace queue holds merged work (D6)', () => {
    const shipped = buildDeliverySteps({ ...base, release: { visible: true } }).find(s => s.key === 'shipped')!;
    expect(shipped.state).toBe('todo');
    expect(shipped.detail).toBe('after next release');
    // Workspace-level queue depth is not a mission fact: it never reaches the step.
    expect(shipped.detail).not.toMatch(/unshipped/);
  });

  it('shows Shipped done once the queue is clean and the work landed', () => {
    const shipped = buildDeliverySteps({ ...base, completedTasks: 6, release: { visible: false } }).find(s => s.key === 'shipped')!;
    expect(shipped.state).toBe('done');
  });

  it('hides Shipped when nothing has merged and the queue is clean, and for a workspace with no release flow', () => {
    expect(keys({ ...base, completedTasks: 0, release: { visible: false } })).not.toContain('shipped');
    expect(keys({ ...base, release: null })).not.toContain('shipped');
  });

  it('shows Budget only when it blocks or is close to the cap', () => {
    expect(keys({ ...base, budget: { budgetUsd: 10, spendUsd: 2, exhausted: false } })).not.toContain('budget');
    const near = buildDeliverySteps({ ...base, budget: { budgetUsd: 10, spendUsd: 8.5, exhausted: false } }).find(s => s.key === 'budget')!;
    expect(near).toMatchObject({ state: 'partial', value: '85%' });
    const capped = buildDeliverySteps({ ...base, budget: { budgetUsd: 10, spendUsd: 10, exhausted: true } }).find(s => s.key === 'budget')!;
    expect(capped).toMatchObject({ state: 'blocked', detail: 'paused at cap' });
  });

  it('orders steps Integrated → Verified → Shipped → Budget', () => {
    expect(keys({
      ...base,
      criteria: { total: 2, passed: 1, overall: 'UNVERIFIED' },
      release: { visible: true },
      budget: { budgetUsd: 10, spendUsd: 10, exhausted: true },
    })).toEqual(['integrated', 'verified', 'shipped', 'budget']);
  });
});

describe('deliveryReleaseInput', () => {
  it('reads a gated queue with merged work as waiting for the next release', () => {
    expect(deliveryReleaseInput({
      state: 'unseeded', archetype: 'gated', seeded: true, baselineSource: 'healthy',
      queueDepth: 3, oldestMergedAt: null, releaseId: null,
    })).toEqual({ visible: true });
  });

  it('reads a clean gated queue as released', () => {
    expect(deliveryReleaseInput({ state: 'clean', reason: 'zero_queue' })).toEqual({ visible: false });
  });

  it('reads a healthy continuous deploy as released, and any other deploy state as unknown', () => {
    const continuous = (deployState: string) => ({
      state: 'unseeded' as const, archetype: 'continuous' as const, seeded: deployState === 'healthy',
      deployState, deployedAt: null, healthyAt: null, releaseId: null,
    });
    expect(deliveryReleaseInput(continuous('healthy'))).toEqual({ visible: false });
    expect(deliveryReleaseInput(continuous('failed'))).toBeNull();
  });

  it('claims nothing when there is no release flow or no baseline', () => {
    expect(deliveryReleaseInput({ state: 'none' })).toBeNull();
    expect(deliveryReleaseInput({ state: 'clean', reason: 'no_baseline' })).toBeNull();
    expect(deliveryReleaseInput({ state: 'clean', reason: 'no_pipeline' })).toBeNull();
  });
});

describe('formatDeliverySummary', () => {
  it('joins every visible step into one line with its state glyph', () => {
    const line = formatDeliverySummary(buildDeliverySteps({
      ...base,
      criteria: { total: 3, passed: 2, overall: 'UNVERIFIED' },
      release: { visible: true },
    }));
    expect(line).toBe('Integrated ◐ 4/6 · Verified ◐ 2/3 · Shipped ○ –');
  });

  it('is empty for no steps', () => {
    expect(formatDeliverySummary([])).toBe('');
  });
});
