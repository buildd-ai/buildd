/**
 * The Steer canvas (knowledge-base: buildd/design/chat-canvas.md's "Ask about this task", but
 * for telling a running agent something instead of asking about it): the
 * title it rescopes to, and the small presence strip under the header —
 * who's running, how fresh their last heartbeat is, and what they're doing
 * right now.
 *
 * Pure — the canvas supplies live values (the task object view, worker
 * heartbeats); this only formats them. `resolveRunnerDisplay` names the
 * runner the same way home's fleet and the mission Board do.
 */
import { formatAge } from '@/lib/mission-board';
import { resolveRunnerDisplay, type RunnerHeartbeatLike, type RunnerWorkerLike } from '@/lib/runner-display';

/** "Builder @ atlas / rates service": the kit's words, so every app titles a steer alike. */
export { steerTitle } from '@builddai/ai-kit/chat/react';

export interface SteerPresence {
  runnerLabel: string | null;
  /** "12s ago" / "3m ago"; null with no heartbeat to measure yet. */
  heartbeatLabel: string | null;
  actionLabel: string | null;
}

export function steerPresence(
  worker: RunnerWorkerLike,
  live: { lastHeartbeatAt: number | null; now: number; currentAction: string | null },
  heartbeats?: readonly RunnerHeartbeatLike[],
): SteerPresence {
  const runner = resolveRunnerDisplay(worker, heartbeats);
  const age = live.lastHeartbeatAt != null ? Math.max(0, live.now - live.lastHeartbeatAt) : null;
  return {
    runnerLabel: runner?.name ?? null,
    heartbeatLabel: age != null ? `${formatAge(age)} ago` : null,
    actionLabel: live.currentAction ?? null,
  };
}
