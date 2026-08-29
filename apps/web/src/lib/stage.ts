/**
 * Stage derivation — the single source of truth for "what phase is this task in".
 *
 * Deliberately a plain module, not part of `@/components/StageChip`: Home and
 * the task list derive stages during the *server* render, and a function
 * exported from a `'use client'` module cannot be called there (it is a client
 * reference, so the call throws at runtime in a production build while `next
 * build` and `next dev` both stay quiet). `client-boundary.test.ts` guards it.
 */

// ─── Stage enum ───────────────────────────────────────────────────────────────

export type Stage =
  | 'SUBJECT_DEAD' // subject PR is dead — the claim gate excludes it; a human must intervene
  | 'MISSION_BUDGET' // parent mission is out of budget — the claim loop skips every task in it
  | 'BLOCKED'
  | 'QUEUED'
  | 'RUNNING'
  | 'WAITING_INPUT'
  | 'REVIEWING'   // agent review is in progress (caller must set explicitly)
  | 'OPEN'        // PR open, no active gate
  | 'CI'
  | 'MERGE'
  | 'VERIFY'
  | 'DONE'
  | 'FAILED'
  | 'CANCELLED';

// ─── Stage derivation ─────────────────────────────────────────────────────────

export interface StageInput {
  taskStatus: string;
  workerStatus?: string | null;
  prUrl?: string | null;
  prLifecycleStatus?: string | null;
  mergedAt?: string | null;
  isBlocked?: boolean;
  /**
   * The subject-liveness claim gate excludes this task (isSubjectDead() in
   * lib/subject-gate-contract.ts). It can never be picked up, so it must not
   * render as QUEUED — that identical-to-healthy row is what hid a 5-day stall.
   */
  isSubjectDead?: boolean;
  /**
   * The parent mission's status is `budget_exhausted`, so the claim loop skips
   * this task (mission gate #1). Only a human raising the mission budget clears
   * it — another unclaimable-but-looks-queued state.
   */
  isMissionBudgetExhausted?: boolean;
}

/**
 * Derive a Stage from task + worker state.
 * Single source of truth — callers must not fork this logic.
 * Returns OPEN (not REVIEWING) for completed+open-PR; callers with policy
 * context should override to REVIEWING when an agent review is in progress.
 */
export function deriveStage(input: StageInput): Stage {
  const { taskStatus, workerStatus, prUrl, prLifecycleStatus, mergedAt, isBlocked, isSubjectDead, isMissionBudgetExhausted } = input;

  if (taskStatus === 'failed') return 'FAILED';
  if (taskStatus === 'cancelled') return 'CANCELLED';

  // Live worker phase
  if (workerStatus === 'waiting_input') return 'WAITING_INPUT';
  if (workerStatus === 'running' || workerStatus === 'starting' || workerStatus === 'idle') {
    return 'RUNNING';
  }

  // Completed task with PR
  if (taskStatus === 'completed' && prUrl) {
    const isMerged = !!mergedAt || prLifecycleStatus === 'merged';
    const isClosed = prLifecycleStatus === 'closed';
    if (isMerged || isClosed) return 'DONE';
    if (prLifecycleStatus === 'ci_running') return 'CI';
    return 'OPEN';
  }

  if (taskStatus === 'completed') return 'DONE';

  // Pending family. SUBJECT_DEAD outranks BLOCKED: a blocked task clears when
  // its dependency merges, a subject-dead task never clears on its own.
  if (isSubjectDead) return 'SUBJECT_DEAD';
  // Mission budget wall: also unclaimable, but a human can lift it in one click,
  // so it ranks below SUBJECT_DEAD and above BLOCKED.
  if (isMissionBudgetExhausted) return 'MISSION_BUDGET';
  if (taskStatus === 'assigned') return 'QUEUED';
  if (isBlocked) return 'BLOCKED';

  return 'QUEUED';
}
