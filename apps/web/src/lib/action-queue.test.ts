import { describe, it, expect } from 'bun:test';
import { buildActionQueue, partitionEscalations } from './action-queue';
import type { WaitingOnYouRawItem, EscalationRawItem, ResolvedEscalationItem } from './action-queue';

const PR_URL_A = 'https://github.com/org/repo/pull/1480';
const PR_URL_B = 'https://github.com/org/repo/pull/1481';

function mergeItem(overrides?: Partial<WaitingOnYouRawItem>): WaitingOnYouRawItem {
  return {
    kind: 'merge',
    prUrl: PR_URL_A,
    prNumber: 1480,
    upstreamTaskId: 'task-1',
    upstreamTaskTitle: 'feat: subject anchors',
    unblockCount: 3,
    missionId: 'mission-1',
    missionTitle: 'Mission Alpha',
    ...overrides,
  };
}

function escalationItem(overrides?: Partial<EscalationRawItem>): EscalationRawItem {
  return {
    workerId: 'worker-1',
    taskId: 'task-1',
    taskTitle: 'feat: subject anchors',
    workspaceId: 'ws-1',
    workspaceName: 'buildd',
    prNumber: 1480,
    prUrl: PR_URL_A,
    policyTier: 'human',
    escalationReason: 'Human Gate — manual merge required',
    waitingMinutes: 15,
    ...overrides,
  };
}

describe('buildActionQueue', () => {
  it('deduplicates a PR in both waitingOnYou and escalationInbox into one card', () => {
    const result = buildActionQueue([mergeItem()], [escalationItem()]);
    expect(result).toHaveLength(1);
    expect(result[0].chip).toBe('MERGE');
    expect(result[0].prNumber).toBe(1480);
  });

  it('merged card carries unblockCount from waitingOnYou and task context from escalation', () => {
    const result = buildActionQueue([mergeItem()], [escalationItem()]);
    expect(result[0].unblockCount).toBe(3);
    expect(result[0].escalationReason).toBe('Human Gate — manual merge required');
    expect(result[0].waitingMinutes).toBe(15);
    expect(result[0].taskId).toBe('task-1');
  });

  it('emits separate cards for different PRs', () => {
    const woy: WaitingOnYouRawItem[] = [
      mergeItem({ prUrl: PR_URL_A, prNumber: 1480, upstreamTaskId: 'u1' }),
    ];
    const esc: EscalationRawItem[] = [
      escalationItem({ prUrl: PR_URL_B, prNumber: 1481, taskId: 'task-2' }),
    ];
    const result = buildActionQueue(woy, esc);
    expect(result).toHaveLength(2);
  });

  it('assigns REVIEW chip to agent-review policy tier', () => {
    const result = buildActionQueue([], [escalationItem({ policyTier: 'agent-review' })]);
    expect(result[0].chip).toBe('REVIEW');
  });

  it('assigns MERGE chip to human policy tier', () => {
    const result = buildActionQueue([], [escalationItem({ policyTier: 'human' })]);
    expect(result[0].chip).toBe('MERGE');
  });

  it('orders MERGE → REVIEW → QUESTION → APPROVE', () => {
    const woy: WaitingOnYouRawItem[] = [
      { kind: 'approve', taskId: 'plan-1', taskTitle: 'Plan A' },
      { kind: 'answer', workerId: 'w-1', taskId: 'task-q', taskTitle: 'Q Task', question: 'Is X ready?' },
      mergeItem({ prUrl: 'https://github.com/org/repo/pull/5', prNumber: 5, upstreamTaskId: 'u5' }),
    ];
    const esc: EscalationRawItem[] = [
      escalationItem({
        prUrl: 'https://github.com/org/repo/pull/10',
        prNumber: 10,
        taskId: 'task-r',
        policyTier: 'agent-review',
      }),
    ];
    const result = buildActionQueue(woy, esc);
    expect(result.map(r => r.chip)).toEqual(['MERGE', 'REVIEW', 'QUESTION', 'APPROVE']);
  });

  it('sorts MERGE items by unblockCount descending', () => {
    const woy: WaitingOnYouRawItem[] = [
      mergeItem({ prUrl: 'https://github.com/org/repo/pull/1', prNumber: 1, upstreamTaskId: 'u1', unblockCount: 1 }),
      mergeItem({ prUrl: 'https://github.com/org/repo/pull/2', prNumber: 2, upstreamTaskId: 'u2', unblockCount: 5 }),
    ];
    const result = buildActionQueue(woy, []);
    expect(result[0].prNumber).toBe(2);
    expect(result[1].prNumber).toBe(1);
  });

  it('returns empty array for empty inputs', () => {
    expect(buildActionQueue([], [])).toHaveLength(0);
  });

  it('does not overwrite escalation item with approve item sharing same task key', () => {
    const woy: WaitingOnYouRawItem[] = [
      { kind: 'approve', taskId: 'task-1', taskTitle: 'Plan A' },
    ];
    const esc: EscalationRawItem[] = [
      escalationItem({ taskId: 'task-1', prUrl: null, prNumber: null }),
    ];
    const result = buildActionQueue(woy, esc);
    expect(result).toHaveLength(1);
    expect(result[0].chip).toBe('MERGE');
  });

  it('includes missionTitle from waitingOnYou in merged card', () => {
    const result = buildActionQueue(
      [mergeItem({ missionTitle: 'Alpha' })],
      [escalationItem({ escalationReason: null })],
    );
    expect(result[0].missionTitle).toBe('Alpha');
  });

  it('preserves escalation missionTitle when both are set', () => {
    // escalation does not carry missionTitle, so waitingOnYou value wins
    const result = buildActionQueue(
      [mergeItem({ missionTitle: 'Upstream Mission' })],
      [escalationItem()],
    );
    expect(result[0].missionTitle).toBe('Upstream Mission');
  });

  it('standalone QUESTION item is included with correct fields', () => {
    const woy: WaitingOnYouRawItem[] = [
      { kind: 'answer', workerId: 'w-2', taskId: 'tq', taskTitle: 'Check deploy', question: 'Is prod green?' },
    ];
    const result = buildActionQueue(woy, []);
    expect(result).toHaveLength(1);
    expect(result[0].chip).toBe('QUESTION');
    expect(result[0].question).toBe('Is prod green?');
    expect(result[0].taskId).toBe('tq');
  });

  it('standalone APPROVE item is included with correct fields', () => {
    const woy: WaitingOnYouRawItem[] = [
      { kind: 'approve', taskId: 'plan-99', taskTitle: 'Migration plan' },
    ];
    const result = buildActionQueue(woy, []);
    expect(result).toHaveLength(1);
    expect(result[0].chip).toBe('APPROVE');
    expect(result[0].taskId).toBe('plan-99');
  });

  it('escalation item without PR gets key task:<taskId>', () => {
    const esc: EscalationRawItem[] = [
      escalationItem({ prUrl: null, prNumber: null, taskId: 'task-no-pr' }),
    ];
    const result = buildActionQueue([], esc);
    expect(result).toHaveLength(1);
    expect(result[0].prUrl).toBeUndefined();
  });

  it('passes prLifecycleStatus=merged through to ActionQueueItem', () => {
    const result = buildActionQueue([mergeItem({ prLifecycleStatus: 'merged' })], []);
    expect(result[0].prLifecycleStatus).toBe('merged');
  });

  it('passes prLifecycleStatus=closed through to ActionQueueItem', () => {
    const result = buildActionQueue([mergeItem({ prLifecycleStatus: 'closed' })], []);
    expect(result[0].prLifecycleStatus).toBe('closed');
  });

  it('leaves prLifecycleStatus undefined when not set on merge item', () => {
    const result = buildActionQueue([mergeItem()], []);
    expect(result[0].prLifecycleStatus).toBeUndefined();
  });

  it('preserves prLifecycleStatus when merging waitingOnYou into existing escalation item', () => {
    const result = buildActionQueue(
      [mergeItem({ prLifecycleStatus: 'merged' })],
      [escalationItem()],
    );
    expect(result[0].prLifecycleStatus).toBe('merged');
  });
});

// ── partitionEscalations ────────────────────────────────────────────────────

function baseResolved(overrides?: Partial<ResolvedEscalationItem>): ResolvedEscalationItem {
  return {
    workerId: 'w-1',
    taskId: 't-1',
    taskTitle: 'feat: some change',
    prNumber: 42,
    prUrl: 'https://github.com/org/repo/pull/42',
    prLifecycleStatus: 'merged',
    workspaceName: 'buildd',
    ...overrides,
  };
}

describe('buildActionQueue — reconnect items', () => {
  const reconnect = (over: Partial<WaitingOnYouRawItem> = {}): WaitingOnYouRawItem => ({
    kind: 'reconnect',
    connectorId: 'c-1',
    connectorName: 'Cue',
    ...over,
  });

  it('turns an expired connector into a RECONNECT item', () => {
    const [item] = buildActionQueue([reconnect()], []);
    expect(item.chip).toBe('RECONNECT');
    expect(item.connectorId).toBe('c-1');
    expect(item.connectorName).toBe('Cue');
    expect(item.subjectKey).toBe('connector:c-1');
  });

  it('dedupes repeated reports of the same connector', () => {
    const queue = buildActionQueue([reconnect(), reconnect()], []);
    expect(queue).toHaveLength(1);
  });

  it('ranks RECONNECT above REVIEW/QUESTION but below MERGE', () => {
    const queue = buildActionQueue(
      [
        { kind: 'answer', workerId: 'w-1', taskId: 't-1', taskTitle: 'q', question: 'why?' },
        reconnect(),
        { kind: 'merge', prUrl: 'https://github.com/x/y/pull/1', prNumber: 1 },
      ],
      [],
    );
    expect(queue.map(i => i.chip)).toEqual(['MERGE', 'RECONNECT', 'QUESTION']);
  });

  it('keeps one item per connector', () => {
    const queue = buildActionQueue(
      [
        reconnect({ connectorId: 'c-a', connectorName: 'Alpha' }),
        reconnect({ connectorId: 'c-b', connectorName: 'Beta' }),
      ],
      [],
    );
    expect(queue.map(i => i.connectorName)).toEqual(['Alpha', 'Beta']);
  });

  it('does not collide with task- or PR-keyed items', () => {
    const queue = buildActionQueue([reconnect({ connectorId: 't-1' })], [
      {
        workerId: 'w-1',
        taskId: 't-1',
        taskTitle: 'Task one',
        workspaceId: 'ws-1',
        workspaceName: 'buildd',
        prNumber: null,
        prUrl: null,
        policyTier: 'human-gate',
        escalationReason: null,
        waitingMinutes: 5,
      },
    ]);
    expect(queue).toHaveLength(2);
  });
});

describe('partitionEscalations', () => {
  it('treats null lifecycle as active (keep fallback)', () => {
    const { active, resolved } = partitionEscalations([
      { ...baseResolved(), prLifecycleStatus: null as any },
    ]);
    expect(active).toHaveLength(1);
    expect(resolved).toHaveLength(0);
  });

  it('treats merged lifecycle as resolved', () => {
    const { active, resolved } = partitionEscalations([
      baseResolved({ prLifecycleStatus: 'merged' }),
    ]);
    expect(active).toHaveLength(0);
    expect(resolved).toHaveLength(1);
  });

  it('treats closed lifecycle as resolved', () => {
    const { active, resolved } = partitionEscalations([
      baseResolved({ prLifecycleStatus: 'closed' }),
    ]);
    expect(active).toHaveLength(0);
    expect(resolved).toHaveLength(1);
  });

  it('treats any other lifecycle value as active', () => {
    const { active, resolved } = partitionEscalations([
      { ...baseResolved(), prLifecycleStatus: 'pr_open' as any },
      { ...baseResolved({ workerId: 'w-2' }), prLifecycleStatus: 'ci_green' as any },
    ]);
    expect(active).toHaveLength(2);
    expect(resolved).toHaveLength(0);
  });

  it('partitions a mixed list correctly', () => {
    const items = [
      baseResolved({ workerId: 'w-1', prLifecycleStatus: null as any }),
      baseResolved({ workerId: 'w-2', prLifecycleStatus: 'merged' }),
      baseResolved({ workerId: 'w-3', prLifecycleStatus: 'closed' }),
      baseResolved({ workerId: 'w-4', prLifecycleStatus: 'ci_green' as any }),
    ];
    const { active, resolved } = partitionEscalations(items);
    expect(active).toHaveLength(2);
    expect(resolved).toHaveLength(2);
    expect(resolved.map(r => r.workerId)).toEqual(['w-2', 'w-3']);
  });

  it('returns empty arrays for empty input', () => {
    const { active, resolved } = partitionEscalations([]);
    expect(active).toHaveLength(0);
    expect(resolved).toHaveLength(0);
  });

  it('preserves all item fields in both partitions', () => {
    const item = baseResolved({ workerId: 'w-x', taskTitle: 'Custom task', prNumber: 99 });
    const { resolved } = partitionEscalations([item]);
    expect(resolved[0]).toEqual(item);
  });
});
