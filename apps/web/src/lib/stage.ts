/**
 * Stage derivation — the single source of truth for "what phase is this task in".
 *
 * Deliberately a plain module, not part of `@/components/StageChip`: Home and
 * the task list derive stages during the *server* render, and a function
 * exported from a `'use client'` module cannot be called there (it is a client
 * reference, so the call throws at runtime in a production build while `next
 * build` and `next dev` both stay quiet). `client-boundary.test.ts` guards it.
 */

import { derivePrDisplayState } from './pr-presentation';
import { deliveryReading, type DeliveryReadingInput, type DeliveryTone } from './workflow/delivery-display';

// ─── Stage enum ───────────────────────────────────────────────────────────────

export type Stage =
  | 'SUBJECT_DEAD' // subject PR is dead — the claim gate excludes it; a human must intervene
  | 'MISSION_BUDGET' // parent mission is out of budget — the claim loop skips every task in it
  | 'BLOCKED'
  | 'QUEUED'
  | 'RUNNING'
  | 'WAITING_INPUT'
  | 'REVIEWING'    // agent review is in progress (caller must set explicitly)
  | 'FIXING'       // kernel-owned PR moving under a non-human owner (fix, repair, review, push recovery, merge); its label is the delivery's
  | 'STALLED'      // kernel-owned PR the platform owns but is not moving on its own (a stalled conflict fix, a red base)
  | 'OPEN'         // PR open, no CI signal yet
  | 'CI'           // CI in progress (ci_running)
  | 'CI_FAILING'   // CI completed with at least one failure (ci_failed)
  | 'MERGE'        // CI passed, ready to merge (ci_green)
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
  /**
   * The kernel's reading of this task's delivery, when the task is the OWNER
   * of a kernel-owned delivery (workflow-state-kernel §17.5). It replaces the
   * PR branch below: a kernel-owned PR's stage never reads the fact-cache
   * columns. Absent for legacy-owned and PR-less tasks.
   */
  delivery?: DeliveryReadingInput | null;
}

/**
 * The chip palette for a delivery's canonical tone (`deliveryReading`). The
 * one table: the chip's words are the reading's label, never a stage name.
 */
export const STAGE_FOR_DELIVERY_TONE: Record<DeliveryTone, Stage> = {
  needs: 'WAITING_INPUT',
  live: 'FIXING',
  stalled: 'STALLED',
  landed: 'DONE',
  closed: 'DONE',
  failed: 'FAILED',
};

/**
 * A kernel-owned delivery's stage in the chip vocabulary. Null for
 * `working`: the delivery waits on the owner's own attempt, so the task's
 * execution state (running, queued) is the truthful reading.
 */
export function stageForDelivery(d: DeliveryReadingInput): Stage | null {
  const r = deliveryReading(d);
  return r ? STAGE_FOR_DELIVERY_TONE[r.tone] : null;
}

/**
 * `deriveStage` plus the chip's words: the delivery's canonical label when
 * the kernel decided the stage, else null (the stage's own label stands).
 */
export function deriveStageReading(input: StageInput): { stage: Stage; label: string | null } {
  const stage = deriveStage(input);
  const r = input.delivery && kernelDecides(input) ? deliveryReading(input.delivery) : null;
  return { stage, label: r ? r.label : null };
}

/** The kernel's reading wins unless a live worker or its own question leads. */
function kernelDecides({ taskStatus, workerStatus }: StageInput): boolean {
  if (taskStatus === 'cancelled') return false;
  if (workerStatus === 'waiting_input' && taskStatus !== 'failed') return false;
  const workerLive = workerStatus === 'running' || workerStatus === 'starting' || workerStatus === 'idle';
  return !(workerLive && taskStatus !== 'failed');
}

/**
 * Derive a Stage from task + worker state.
 * Single source of truth — callers must not fork this logic.
 * Returns OPEN (not REVIEWING) for completed+open-PR; callers with policy
 * context should override to REVIEWING when an agent review is in progress.
 */
export function deriveStage(input: StageInput): Stage {
  const { taskStatus, workerStatus, prUrl, prLifecycleStatus, mergedAt, isBlocked, isSubjectDead, isMissionBudgetExhausted, delivery } = input;

  if (taskStatus === 'cancelled') return 'CANCELLED';

  // Live worker phase. A worker's own question stays a question (§13.2 dev. 3).
  const workerLive = workerStatus === 'running' || workerStatus === 'starting' || workerStatus === 'idle';
  if (workerStatus === 'waiting_input' && taskStatus !== 'failed') return 'WAITING_INPUT';
  if (workerLive && taskStatus !== 'failed') return 'RUNNING';

  // Kernel-owned delivery: its stage, not the columns, and not a failed
  // owner attempt the delivery has already carried past (S35).
  const kernelStage = delivery ? stageForDelivery(delivery) : null;
  if (kernelStage) return kernelStage;

  if (taskStatus === 'failed') return 'FAILED';

  // Completed task with PR (legacy-owned): the one fact-cache mapping.
  if (taskStatus === 'completed' && prUrl) {
    switch (derivePrDisplayState(prLifecycleStatus, mergedAt)) {
      case 'merged':
      case 'closed': return 'DONE';
      case 'ci_running': return 'CI';
      case 'ci_failed': return 'CI_FAILING';
      case 'ci_passed': return 'MERGE';
      default: return 'OPEN';
    }
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
