import { describe, it, expect } from 'bun:test';

// Pure module: no db, no schema, no orm mocks. That is the point — mission
// detail is a server component, and the derivation it needs must not drag a DB
// import into anything that might one day be a client component.
import {
  deriveMissionIntegrationPr,
  describeMissionDelivery,
  deriveMissionProgressSubline,
  shouldRenderMissionPrBlock,
  type MissionPrTaskLike,
} from './mission-integration-pr';

const BRANCH = 'mission/ship-the-thing-1a2b3c4d';
const OPTED_IN = { workingBranch: BRANCH, integrationBranchEnabled: true };

/** A deliverable task whose PR merged into the integration branch. */
function landedTask(n: number): MissionPrTaskLike {
  return {
    id: `task-${n}`,
    title: `Deliverable ${n}`,
    taskClass: 'work',
    workers: [{ prUrl: `https://example.invalid/pr/${n}`, prNumber: n, mergedAt: new Date('2026-09-05T10:00:00Z'), prLifecycleStatus: 'merged' }],
  };
}

/** The bookkeeping task `openMissionIntegrationPr` creates to own the mission PR. */
function missionPrTask(over: Partial<{ prNumber: number; mergedAt: Date | null; prLifecycleStatus: string }> = {}): MissionPrTaskLike {
  const { prNumber = 90, mergedAt = null, prLifecycleStatus = 'pr_open' } = over;
  return {
    id: 'task-mission-pr',
    title: 'Ship mission: Ship the thing',
    taskClass: 'bookkeeping',
    workers: [{ prUrl: `https://example.invalid/pr/${prNumber}`, prNumber, mergedAt, prLifecycleStatus }],
  };
}

describe('deriveMissionIntegrationPr', () => {
  it('is null for a mission that never opted in — nothing on that surface changes', () => {
    expect(deriveMissionIntegrationPr({ mission: { workingBranch: BRANCH, integrationBranchEnabled: false }, tasks: [landedTask(1)] })).toBeNull();
    expect(deriveMissionIntegrationPr({ mission: null, tasks: [] })).toBeNull();
  });

  it('is null when the mission opted in but has no integration branch to point at', () => {
    expect(deriveMissionIntegrationPr({ mission: { workingBranch: null, integrationBranchEnabled: true }, tasks: [] })).toBeNull();
  });

  it('finds the open mission PR and ignores the task PRs that fed the branch', () => {
    const view = deriveMissionIntegrationPr({
      mission: OPTED_IN,
      tasks: [landedTask(1), landedTask(2), missionPrTask({ prNumber: 90 })],
    });

    expect(view).toEqual({
      branch: BRANCH,
      state: 'open',
      prNumber: 90,
      prUrl: 'https://example.invalid/pr/90',
      taskId: 'task-mission-pr',
    });
  });

  it('reports not_opened when the work landed but no mission PR row exists yet', () => {
    const view = deriveMissionIntegrationPr({ mission: OPTED_IN, tasks: [landedTask(1)] });

    expect(view).toMatchObject({ branch: BRANCH, state: 'not_opened', prNumber: null, prUrl: null });
  });

  it('reads merged and closed off the owning worker', () => {
    expect(
      deriveMissionIntegrationPr({ mission: OPTED_IN, tasks: [missionPrTask({ mergedAt: new Date('2026-09-05T12:00:00Z'), prLifecycleStatus: 'merged' })] })!.state,
    ).toBe('merged');
    expect(
      deriveMissionIntegrationPr({ mission: OPTED_IN, tasks: [missionPrTask({ prLifecycleStatus: 'closed' })] })!.state,
    ).toBe('closed');
  });

  it('does not mistake a bookkeeping task with another title for the mission PR', () => {
    const decoy: MissionPrTaskLike = {
      id: 'task-decoy',
      title: 'Aggregate results: something',
      taskClass: 'bookkeeping',
      workers: [{ prUrl: 'https://example.invalid/pr/77', prNumber: 77, mergedAt: null, prLifecycleStatus: 'pr_open' }],
    };

    expect(deriveMissionIntegrationPr({ mission: OPTED_IN, tasks: [decoy] })!.state).toBe('not_opened');
  });
});

describe('shouldRenderMissionPrBlock', () => {
  it('renders nothing for a mission that never opted in', () => {
    expect(shouldRenderMissionPrBlock(null, { workLanded: true })).toBe(false);
  });

  it('renders for any PR that exists, in any state', () => {
    for (const tasks of [
      [missionPrTask()],
      [missionPrTask({ mergedAt: new Date(), prLifecycleStatus: 'merged' })],
      [missionPrTask({ prLifecycleStatus: 'closed' })],
    ]) {
      const pr = deriveMissionIntegrationPr({ mission: OPTED_IN, tasks });
      expect(shouldRenderMissionPrBlock(pr, { workLanded: false })).toBe(true);
    }
  });

  it('renders `not_opened` only once the work has landed — otherwise it is chrome', () => {
    const pr = deriveMissionIntegrationPr({ mission: OPTED_IN, tasks: [landedTask(1)] });
    expect(shouldRenderMissionPrBlock(pr, { workLanded: false })).toBe(false);
    expect(shouldRenderMissionPrBlock(pr, { workLanded: true })).toBe(true);
  });
});

describe('deriveMissionProgressSubline', () => {
  const done = { missionStatus: 'active', totalTasks: 3, completedTasks: 3, awaitingMerge: 0 };

  // The P4 regression, stated as a value: `awaitingMerge` counts TASK PRs, and
  // for an integration-branch mission they have all merged into
  // `mission/<slug>`, so it correctly reads 0 while none of the mission's diff
  // is on trunk. Without the mission PR in this line the header says the
  // mission is finished and points at nothing.
  it('names the open mission PR when every task PR has merged into the integration branch', () => {
    const line = deriveMissionProgressSubline({
      ...done,
      integrationPr: deriveMissionIntegrationPr({ mission: OPTED_IN, tasks: [landedTask(1), landedTask(2), landedTask(3), missionPrTask({ prNumber: 90 })] }),
    });

    expect(line).toContain('mission PR #90');
    expect(line).toContain('awaiting merge');
    expect(line).not.toBe('3 of 3 tasks complete');
  });

  it('says the mission PR is not open yet when the work has landed and nothing opened it', () => {
    const line = deriveMissionProgressSubline({
      ...done,
      integrationPr: deriveMissionIntegrationPr({ mission: OPTED_IN, tasks: [landedTask(1), landedTask(2), landedTask(3)] }),
    });

    expect(line).toContain('3 of 3 tasks complete');
    expect(line).toContain('mission PR not open yet');
  });

  it('keeps the existing wording for a mission with no integration PR', () => {
    expect(deriveMissionProgressSubline({ ...done, integrationPr: null })).toBe('3 of 3 tasks complete');
    expect(
      deriveMissionProgressSubline({ missionStatus: 'active', totalTasks: 3, completedTasks: 1, awaitingMerge: 2, integrationPr: null }),
    ).toBe('1/3 done · 2 awaiting merge');
    expect(
      deriveMissionProgressSubline({ missionStatus: 'completed', totalTasks: 3, completedTasks: 3, awaitingMerge: 0, integrationPr: null }),
    ).toBe('3 tasks · 3 completed');
  });

  it('adds nothing once the mission PR has merged — the diff is on trunk', () => {
    const line = deriveMissionProgressSubline({
      ...done,
      integrationPr: deriveMissionIntegrationPr({ mission: OPTED_IN, tasks: [landedTask(1), landedTask(2), landedTask(3), missionPrTask({ mergedAt: new Date(), prLifecycleStatus: 'merged' })] }),
    });

    expect(line).toBe('3 of 3 tasks complete');
  });

  it('still names the task PRs awaiting merge while work is in flight', () => {
    const line = deriveMissionProgressSubline({
      missionStatus: 'active',
      totalTasks: 3,
      completedTasks: 1,
      awaitingMerge: 2,
      integrationPr: deriveMissionIntegrationPr({ mission: OPTED_IN, tasks: [landedTask(1)] }),
    });

    expect(line).toContain('2 awaiting merge');
  });
});

// Scenario 8 (task f3bda4e1; workflow-kernel-library.md §6): with delivery
// records, the surface shows the mission's current delivery and names the
// shipped ones beside it. "Delivery 1 merged" is a fact, never the mission's verdict.
describe('deriveMissionIntegrationPr with delivery records', () => {
  const d = (epoch: number, state: 'open' | 'merged', prNumber: number | null, branch = epoch === 1 ? BRANCH : `${BRANCH}-delivery-${epoch}`) =>
    ({ epoch, branch, state, prNumber, repoFullName: 'acme/app' });

  it('delivery 1 merged, delivery 2 open with no PR yet: the view is delivery 2, never "merged"', () => {
    // The owner rows alone read merged: the shipped delivery's PR is the only one on record.
    const tasks = [landedTask(1), missionPrTask({ prNumber: 10, mergedAt: new Date(), prLifecycleStatus: 'merged' })];
    const v = deriveMissionIntegrationPr({ mission: OPTED_IN, tasks, deliveries: [d(1, 'merged', 10), d(2, 'open', null)] })!;
    expect(v).toMatchObject({ state: 'not_opened', delivery: 2, branch: `${BRANCH}-delivery-2`, prNumber: null });
    expect(v.shippedDeliveries).toEqual([{ delivery: 1, prNumber: 10, prUrl: 'https://github.com/acme/app/pull/10' }]);
    const words = describeMissionDelivery(v);
    expect(words.heading).toBe('Delivery 2');
    expect(words.earlier).toBe('Delivery 1 merged (#10).');
    expect(words.line).not.toMatch(/reached the target branch/);
    // Without delivery records the same rows read as a shipped mission: the old screenshot.
    expect(deriveMissionIntegrationPr({ mission: OPTED_IN, tasks })!.state).toBe('merged');
  });

  it('delivery 2 has its PR open: awaiting merge, by its own number', () => {
    const v = deriveMissionIntegrationPr({ mission: OPTED_IN, tasks: [], deliveries: [d(1, 'merged', 10), d(2, 'open', 11)] })!;
    expect(v).toMatchObject({ state: 'open', delivery: 2, prNumber: 11 });
    expect(deriveMissionProgressSubline({ missionStatus: 'active', totalTasks: 3, completedTasks: 3, awaitingMerge: 0, integrationPr: v }))
      .toBe('3 of 3 tasks complete · delivery 2 PR #11 awaiting merge');
  });

  it('every delivery merged: the newest is the view, the earlier ones named', () => {
    const v = deriveMissionIntegrationPr({ mission: OPTED_IN, tasks: [], deliveries: [d(1, 'merged', 10), d(2, 'merged', 11)] })!;
    expect(v).toMatchObject({ state: 'merged', delivery: 2 });
    expect(describeMissionDelivery(v).line).toContain('Delivery 2 reached the target branch');
    expect(describeMissionDelivery(v).earlier).toBe('Delivery 1 merged (#10).');
  });

  it('while work is still running, the subline says the earlier delivery shipped, not that the mission did', () => {
    const v = deriveMissionIntegrationPr({ mission: OPTED_IN, tasks: [], deliveries: [d(1, 'merged', 10), d(2, 'open', null)] })!;
    expect(deriveMissionProgressSubline({ missionStatus: 'active', totalTasks: 4, completedTasks: 2, awaitingMerge: 0, integrationPr: v }))
      .toBe('2 of 4 tasks complete · delivery 1 shipped');
  });

  it('delivery 1 with a single open delivery uses delivery-specific wording', () => {
    const v = deriveMissionIntegrationPr({ mission: OPTED_IN, tasks: [], deliveries: [d(1, 'open', 11)] })!;
    expect(v).toMatchObject({ state: 'open', delivery: 1, prNumber: 11 });
    const words = describeMissionDelivery(v);
    expect(words.heading).toBe('Delivery 1');
    expect(words.line).toContain("Delivery 1's work ships in this PR");
    expect(words.earlier).toBeNull();
  });
});
