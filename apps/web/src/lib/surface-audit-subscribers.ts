/**
 * Visual QA module: what core facts mean for a mission's `[surface audit]`.
 *
 * `task.left_mission` (PATCH /api/tasks/[id]): the task stops holding the old
 * mission's pending audit, and an audit it was the last thing holding is
 * woken (lib/mission-surface-audit-membership.ts). The claim gate already
 * ignores an audit's non-member dependency, so this keeps the stored list,
 * and every surface that reads it, honest.
 */
import { subscriber, type AnySubscriber } from '@/lib/core-events';

export const surfaceAuditSubscribers: readonly AnySubscriber[] = [
  subscriber('visual-qa', 'task.left_mission', 'surface-audit-detach', async e => {
    const { onTaskLeftMission } = await import('@/lib/mission-surface-audit-membership');
    await onTaskLeftMission(e.missionId, e.taskId);
  }),
];
