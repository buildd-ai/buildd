import { describe, it, expect } from 'vitest';
import { scheduleMoveNeedsYouItems } from './schedule-move-needs-you';
import { buildActionQueue, isActionableChip, type ScheduleMoveCard } from './action-queue';
import { resolveQueueAttention } from './home-attention';

const card = (over: Partial<ScheduleMoveCard> = {}): ScheduleMoveCard => ({
  proposalId: 'p1', scheduleId: 's1', scheduleName: 'Nightly report',
  fromWorkspaceId: 'w-a', fromWorkspaceName: 'App', toWorkspaceId: 'w-b', toWorkspaceName: 'Data',
  reason: 'Its reads keep coming back FORBIDDEN', origin: 'task', ...over,
});

describe('schedule move cards (D-2)', () => {
  it('one Home decision per open proposal, with the two homes and the reason', () => {
    const queue = buildActionQueue(scheduleMoveNeedsYouItems([card(), card()]), []);
    expect(queue).toHaveLength(1);
    expect(queue[0]!.chip).toBe('SCHEDULE_MOVE');
    expect(isActionableChip(queue[0]!.chip)).toBe(true);
    const resolved = resolveQueueAttention(queue[0]!)!;
    expect(resolved.title).toBe('Move "Nightly report" to Data?');
    expect(resolved.sentence).toContain('App');
    expect(resolved.sentence).toContain('FORBIDDEN');
    expect(resolved.primary?.href).toBe('/app/workspaces/w-a/schedules');
  });

  it('says so when the schedule proposed it itself', () => {
    const queue = buildActionQueue(scheduleMoveNeedsYouItems([card({ origin: 'auto' })]), []);
    expect(resolveQueueAttention(queue[0]!)!.sentence).toContain('keep being refused');
  });

  it('two schedules are two cards', () => {
    const queue = buildActionQueue(scheduleMoveNeedsYouItems([card(), card({ proposalId: 'p2', scheduleId: 's2' })]), []);
    expect(queue).toHaveLength(2);
  });
});
