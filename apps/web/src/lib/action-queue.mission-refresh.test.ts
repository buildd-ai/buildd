import { describe, it, expect } from 'bun:test';
import { buildActionQueue, isActionableChip, missionPrRoleOf } from './action-queue';
import type { EscalationRawItem } from './action-queue';

const SHIP_URL = 'https://github.com/org/repo/pull/2001';
const REFRESH_URL = 'https://github.com/org/repo/pull/2002';

function escalation(overrides: Partial<EscalationRawItem>): EscalationRawItem {
  return {
    workerId: 'w-ship',
    taskId: 't-ship',
    taskTitle: 'Ship mission: Widget Polish',
    workspaceId: 'ws-1',
    workspaceName: 'acme',
    prNumber: 2001,
    prUrl: SHIP_URL,
    policyTier: 'human',
    escalationReason: 'Human Gate — manual merge required',
    waitingMinutes: 10,
    prOpenedAt: new Date(),
    prLifecycleVerifiedAt: new Date(),
    missionId: 'm-1',
    missionTitle: 'Widget Polish',
    missionPrRole: 'ship',
    ...overrides,
  };
}

const refresh = (overrides: Partial<EscalationRawItem> = {}) => escalation({
  workerId: 'w-refresh',
  taskId: 't-refresh',
  taskTitle: 'chore(mission): merge dev into the Widget Polish integration branch',
  prNumber: 2002,
  prUrl: REFRESH_URL,
  missionPrRole: 'refresh',
  ...overrides,
});

describe('buildActionQueue — mission ship + refresh PRs fold into one card', () => {
  it('folds the refresh PR into the ship card as a "refresh first" dependency', () => {
    const q = buildActionQueue([], [escalation({}), refresh()]);
    expect(q).toHaveLength(1);
    expect(q[0].prUrl).toBe(SHIP_URL);
    expect(q[0].refreshFirst).toEqual({ prNumber: 2002, prUrl: REFRESH_URL, taskId: 't-refresh', chip: 'MERGE' });
  });

  it('counts the pair once among actionable items', () => {
    const q = buildActionQueue([], [escalation({}), refresh()]);
    expect(q.filter((i) => isActionableChip(i.chip))).toHaveLength(1);
  });

  it('folds regardless of input order', () => {
    const q = buildActionQueue([], [refresh(), escalation({})]);
    expect(q).toHaveLength(1);
    expect(q[0].refreshFirst?.prNumber).toBe(2002);
  });

  it('keeps a refresh PR whose mission has no ship card in the queue', () => {
    const q = buildActionQueue([], [refresh()]);
    expect(q).toHaveLength(1);
    expect(q[0].prUrl).toBe(REFRESH_URL);
    expect(q[0].refreshFirst ?? null).toBeNull();
  });

  it('never folds across missions', () => {
    const q = buildActionQueue([], [escalation({}), refresh({ missionId: 'm-2' })]);
    expect(q).toHaveLength(2);
    expect(q.every((i) => !i.refreshFirst)).toBe(true);
  });

  it('never folds across workspaces', () => {
    const q = buildActionQueue([], [escalation({}), refresh({ workspaceId: 'ws-2' })]);
    expect(q).toHaveLength(2);
  });

  it('leaves untagged PRs in the same mission alone', () => {
    const q = buildActionQueue([], [escalation({}), refresh({ missionPrRole: null })]);
    expect(q).toHaveLength(2);
  });

  it('shows the refresh card again when the ship card is snoozed', () => {
    const q = buildActionQueue([], [escalation({}), refresh()], { snoozedSubjectKeys: new Set([SHIP_URL]) });
    expect(q).toHaveLength(1);
    expect(q[0].prUrl).toBe(REFRESH_URL);
  });
});

describe('missionPrRoleOf', () => {
  it('reads a ship task from the bookkeeping mission-PR marker', () => {
    expect(missionPrRoleOf({ title: 'Ship mission: Widget Polish', taskClass: 'bookkeeping', missionId: 'm-1' })).toBe('ship');
  });

  it('reads a refresh task from context.refreshTrunk, not its title', () => {
    expect(missionPrRoleOf({ title: 'anything at all', taskClass: 'work', missionId: 'm-1', context: { refreshTrunk: 'dev' } })).toBe('refresh');
    expect(missionPrRoleOf({ title: 'chore(mission): merge dev into the Widget Polish integration branch', taskClass: 'work', missionId: 'm-1', context: {} })).toBeNull();
  });

  it('ignores a ship-titled task that is not bookkeeping', () => {
    expect(missionPrRoleOf({ title: 'Ship mission: Widget Polish', taskClass: 'work', missionId: 'm-1' })).toBeNull();
  });

  it('is null outside a mission', () => {
    expect(missionPrRoleOf({ title: 'x', taskClass: 'work', missionId: null, context: { refreshTrunk: 'dev' } })).toBeNull();
  });
});
