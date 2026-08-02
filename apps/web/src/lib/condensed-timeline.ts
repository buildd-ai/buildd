import { LIVE_WORKER_STATUSES, isGateSatisfied } from '@/lib/task-presentation';

// ─── Types ────────────────────────────────────────────────────────────────────

export type CondensedTaskWorker = {
  id: string;
  status: string;
  prUrl: string | null;
  prNumber: number | null;
  prLifecycleStatus: string | null;
  mergedAt: string | null;
  completedAt: string | null;
  startedAt: string | null;
  currentAction: string | null;
  branch: string | null;
  waitingFor: { type: string; prompt: string; options?: string[] } | null;
};

export type CondensedTask = {
  id: string;
  status: string;
  dependsOn: string[] | null;
  workers: CondensedTaskWorker[];
};

export type TimelineGroups<T extends CondensedTask = CondensedTask> = {
  /** Completed tasks with an open (non-merged, non-closed) PR. */
  waitingOnYou: T[];
  /** Tasks with a live worker (running / starting / idle / waiting_input). */
  running: T[];
  /** Pending tasks with all dependencies gate-satisfied — ready to claim. */
  nextQueued: T[];
  /** Pending tasks with at least one unsatisfied dependency. */
  blocked: T[];
  /** Completed tasks with a merged PR (or no PR produced). */
  done: T[];
  /** Failed tasks. */
  failed: T[];
};

// ─── Predicates ───────────────────────────────────────────────────────────────

function hasLiveWorker(task: CondensedTask): boolean {
  const latest = task.workers[0];
  if (!latest) return false;
  return (LIVE_WORKER_STATUSES as readonly string[]).includes(latest.status);
}

function isWaitingOnYou(task: CondensedTask): boolean {
  if (task.status !== 'completed') return false;
  const latest = task.workers[0];
  if (!latest?.prUrl) return false;
  if (latest.mergedAt) return false;
  if (latest.prLifecycleStatus === 'closed') return false;
  return true;
}

function allDepsGateSatisfied(task: CondensedTask, taskMap: Map<string, CondensedTask>): boolean {
  const deps = task.dependsOn ?? [];
  if (deps.length === 0) return true;
  for (const depId of deps) {
    const dep = taskMap.get(depId);
    if (!dep) continue; // Unknown dep — can't block on a task not in this mission
    if (!isGateSatisfied(dep, dep.workers)) return false;
  }
  return true;
}

// ─── Grouping function ────────────────────────────────────────────────────────

/**
 * Partition timeline tasks into the condensed-timeline hierarchy defined in
 * docs/design/mobile-decision-flow.md §3.1.
 *
 * Priority order (first match wins):
 *   1. Has live worker → running
 *   2. completed + open PR → waitingOnYou
 *   3. completed + merged PR / no PR → done
 *   4. failed → failed
 *   5. pending/assigned + all deps gate-satisfied → nextQueued
 *   6. pending/assigned + unresolved dep → blocked
 *
 * Generic so it works with enriched supertypes without losing type information.
 */
export function groupTimelineTasks<T extends CondensedTask>(
  tasks: T[],
  taskMap: Map<string, CondensedTask>,
): TimelineGroups<T> {
  const groups: TimelineGroups<T> = {
    waitingOnYou: [],
    running: [],
    nextQueued: [],
    blocked: [],
    done: [],
    failed: [],
  };

  for (const task of tasks) {
    if (hasLiveWorker(task)) {
      groups.running.push(task);
      continue;
    }

    if (task.status === 'completed') {
      if (isWaitingOnYou(task)) {
        groups.waitingOnYou.push(task);
      } else {
        groups.done.push(task);
      }
      continue;
    }

    if (task.status === 'failed') {
      groups.failed.push(task);
      continue;
    }

    if (task.status === 'pending' || task.status === 'assigned') {
      if (allDepsGateSatisfied(task, taskMap)) {
        groups.nextQueued.push(task);
      } else {
        groups.blocked.push(task);
      }
      continue;
    }
  }

  return groups;
}
