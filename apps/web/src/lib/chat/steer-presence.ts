/**
 * The Steer canvas (docs/design/chat-canvas.md's "Ask about this task", but
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

/** "Builder @ atlas / rates service" — falls back gracefully with no role or no runner yet. */
export function steerTitle(roleName: string | null, runnerName: string | null, taskLabel: string): string {
  const who = [roleName ?? 'Agent', runnerName ? `@ ${runnerName}` : null].filter(Boolean).join(' ');
  return `${who} / ${taskLabel}`;
}

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
