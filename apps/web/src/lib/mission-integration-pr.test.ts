import { describe, it, expect } from 'bun:test';

// Pure module: no db, no schema, no orm mocks. That is the point — mission
// detail is a server component, and the derivation it needs must not drag a DB
// import into anything that might one day be a client component.
import {
  deriveMissionIntegrationPr,
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
