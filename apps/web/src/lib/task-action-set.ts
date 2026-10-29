/** Server-safe: the pure action-set derivation behind `task-actions` (a 'use client' module). */
import { deriveTaskPhase, type TaskPhase } from './task-presentation';
import type { TaskFailureKind, TaskTrouble } from './task-failure-kind';

// ── Action set ───────────────────────────────────────────────────────────────

export type Backend = 'claude' | 'codex';
export type MissionExecutor = 'runner' | 'local';

/** Phases where nothing is running and a person can ask for a start. */
export const STARTABLE_PHASES: ReadonlySet<TaskPhase> = new Set<TaskPhase>([
  'pending', 'budget_paused', 'mission_budget_exhausted', 'subject_dead',
]);

/**
 * What a task's state offers, in render order. The renderer draws exactly
 * these, and the parity test compares them across surfaces:
 * - `answer`: reply to the agent's open question;
 * - `retry` / `switch_backend` / `history`: a task whose worker failed;
 * - `verification_failed` / `history`: a task whose work landed and whose audit
 *   failed — no retry of the build, the audit's own surface retries the audit;
 * - `waiting_on_failed` / `history`: a task that never ran because a task it
 *   depends on failed — no retry of its own, a link to that task (spec 072de598 I-14);
 * - `blocked`: the dependency notice (no action, by design);
 * - `start_anyway` / `cancel`: a task waiting on another task (R-20): start it
 *   past the wait, or drop it. Never Retry: it starts again by itself;
 * - `claim_hint`: `claim_task {taskId}` for a task only a local session claims;
 * - `retry_now`: a task buildd is retrying by itself (`trouble.kind ===
 *   'retrying'`): clears its scheduled start, nothing more. Replaces Run now;
 * - `run_now`: ask for a start now (a gate refusal becomes Force start inline).
 */
export type TaskActionId = 'answer' | 'retry' | 'switch_backend' | 'history' | 'verification_failed' | 'waiting_on_failed' | 'blocked' | 'start_anyway' | 'cancel' | 'claim_hint' | 'retry_now' | 'run_now';

export interface TaskActionState {
  phase: TaskPhase;
  isBlocked: boolean;
  backend: Backend | null;
  /** The live worker has a question waiting. */
  hasQuestion: boolean;
  /** The host can link to the full history (the sheet and drawer, not the page itself). */
  hasHistory: boolean;
  /** The task's mission executor; `local` means runners never claim it. */
  missionExecutor?: MissionExecutor | null;
  /**
   * Whether the other backend has a credential for this workspace. `false`
   * drops the switch (offering Codex to a team that never set it up only
   * produces a second failure); omitted means unknown and keeps it.
   */
  otherBackendAvailable?: boolean;
  /** `classifyTaskFailure`; `verification` swaps the build's recovery for the audit's, `dependency` drops it for a link to the failed task. */
  failureKind?: TaskFailureKind | null;
  /**
   * `classifyTaskTrouble`: who acts next. `waiting` (or a dead blocker) on a
   * pending task offers Start now anyway and Cancel; `retrying` offers Retry
   * now in place of Run now. Omitted: the action set is as before.
   */
  trouble?: TaskTrouble | null;
}

/** A backend as a product name: "Claude", "Codex". */
export function backendDisplayName(backend: Backend | string): string {
  if (backend === 'codex') return 'Codex';
  if (backend === 'claude') return 'Claude';
  return backend.charAt(0).toUpperCase() + backend.slice(1);
}

export function otherBackendOf(backend: Backend | null): Backend | null {
  return backend === 'codex' ? 'claude' : backend === 'claude' ? 'codex' : null;
}

export function taskActionSet(s: TaskActionState): TaskActionId[] {
  const out: TaskActionId[] = [];
  const waiting = s.phase === 'waiting_input';
  if (waiting && s.hasQuestion) out.push('answer');
  if (s.phase === 'failed' && !waiting && s.failureKind === 'verification') {
    out.push('verification_failed');
    if (s.hasHistory) out.push('history');
  } else if (s.phase === 'failed' && !waiting && s.failureKind === 'dependency') {
    out.push('waiting_on_failed');
    if (s.hasHistory) out.push('history');
  } else if (s.phase === 'failed' && !waiting) {
    out.push('retry', 'cancel');
    if (otherBackendOf(s.backend) && s.otherBackendAvailable !== false) out.push('switch_backend');
    if (s.hasHistory) out.push('history');
  }
  if (s.isBlocked) out.push('blocked');
  const t = s.trouble ?? null;
  const heldByTask = (s.phase === 'pending' || s.phase === 'blocked') && (t?.kind === 'waiting' || (t?.kind === 'needs_person' && !!t.on));
  if (heldByTask) {
    out.push('start_anyway', 'cancel');
  } else if (STARTABLE_PHASES.has(s.phase) && !s.isBlocked) {
    if (s.missionExecutor === 'local') out.push('claim_hint');
    out.push(s.phase === 'pending' && t?.kind === 'retrying' && t.resumesAt ? 'retry_now' : 'run_now');
  }
  return out;
}

/**
 * Phase and blocked flag for a task the host holds as a light row (the sheet's
 * summary, the board model). The full task page has more inputs and calls
 * `deriveTaskPhase` itself; both end in the same function.
 */
export function taskActionPhase(i: {
  taskStatus: string;
  taskMode?: string | null;
  workerStatus?: string | null;
  workerWaitingFor?: unknown;
  blockedByCount: number;
}): { phase: TaskPhase; isBlocked: boolean } {
  const isBlocked = i.taskStatus === 'pending' && i.blockedByCount > 0;
  const phase = deriveTaskPhase({
    taskStatus: i.taskStatus,
    taskMode: i.taskMode ?? null,
    workerStatus: i.workerStatus ?? null,
    workerWaitingFor: i.workerWaitingFor,
    isBlocked,
  });
  return { phase, isBlocked };
}
