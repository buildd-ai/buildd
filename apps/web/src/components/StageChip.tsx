'use client';

import type { LoopState } from '@buildd/shared';
import { LoopStatusChip } from '@/components/LoopStatus';

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

// ─── Visual config ────────────────────────────────────────────────────────────

interface ChipConfig {
  label: string;
  /**
   * filled = solid bg, white text (urgent/active states)
   * soft   = 10% opacity bg, colored text, no border (informational states)
   * muted  = text only, no bg/border (terminal/quiet states)
   */
  variant: 'filled' | 'soft' | 'muted';
  colorCls: string;
  pulse?: boolean;
}

const STAGE_CONFIG: Record<Stage, ChipConfig> = {
  SUBJECT_DEAD: { label: 'Subject Closed', variant: 'soft', colorCls: 'bg-status-error/12 text-status-error' },
  MISSION_BUDGET: { label: 'Budget Exhausted', variant: 'soft', colorCls: 'bg-status-error/12 text-status-error' },
  BLOCKED:      { label: 'Blocked',    variant: 'filled', colorCls: 'bg-status-warning text-white' },
  QUEUED:       { label: 'Queued',     variant: 'muted',  colorCls: 'text-text-muted' },
  RUNNING:      { label: 'Running',    variant: 'filled', colorCls: 'bg-status-running text-white', pulse: true },
  WAITING_INPUT:{ label: 'Needs Input',variant: 'filled', colorCls: 'bg-status-warning text-white' },
  REVIEWING:    { label: 'Reviewing',  variant: 'soft',   colorCls: 'bg-status-info/10 text-status-info', pulse: true },
  OPEN:         { label: 'Open',       variant: 'soft',   colorCls: 'bg-accent/10 text-accent-text' },
  CI:           { label: 'CI',         variant: 'soft',   colorCls: 'bg-status-info/10 text-status-info' },
  MERGE:        { label: 'Merge',      variant: 'soft',   colorCls: 'bg-accent/10 text-accent-text' },
  VERIFY:       { label: 'Verify',     variant: 'soft',   colorCls: 'bg-status-warning/10 text-status-warning' },
  DONE:         { label: 'Done',       variant: 'soft',   colorCls: 'bg-status-success/10 text-status-success' },
  FAILED:       { label: 'Failed',     variant: 'filled', colorCls: 'bg-status-error text-white' },
  CANCELLED:    { label: 'Cancelled',  variant: 'muted',  colorCls: 'text-text-muted' },
};

// ─── StageChip component ──────────────────────────────────────────────────────

export interface StageChipProps {
  stage: Stage;
  prNumber?: number | null;
  startAt?: string | null;
  loopIteration?: number | null;
  loopState?: LoopState | null;
  loopMaxLoops?: number | null;
  /** Exit condition type from loopConfig — used to show 'WAITING · MERGE' for pr_merged waits. */
  loopExitConditionType?: string | null;
}

/**
 * Canonical stage chip — the only chip implementation for task status.
 * filled = active/urgent (pre-PR). soft = informational (has PR artifact). muted = terminal/quiet.
 * No border treatment on any variant — badges, not buttons.
 */
export function StageChip({ stage, prNumber, startAt, loopIteration, loopState, loopMaxLoops, loopExitConditionType }: StageChipProps) {
  // Loop chip overrides stage chip when the loop is in flight
  if (loopMaxLoops && loopState !== 'satisfied' && loopState !== 'exhausted') {
    return (
      <LoopStatusChip
        loopIteration={loopIteration ?? 0}
        maxLoops={loopMaxLoops}
        loopState={loopState ?? null}
        startAt={startAt}
        exitConditionType={loopExitConditionType}
      />
    );
  }

  // Scheduled start overrides QUEUED label
  if (stage === 'QUEUED' && startAt && new Date(startAt).getTime() > Date.now()) {
    return (
      <span className="inline-flex items-center px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wide bg-status-info/10 text-status-info shrink-0">
        Starts {new Date(startAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
      </span>
    );
  }

  const cfg = STAGE_CONFIG[stage];

  if (cfg.variant === 'filled') {
    return (
      <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wide shrink-0 ${cfg.colorCls}`}>
        {cfg.pulse && <span className="w-1.5 h-1.5 bg-current animate-status-pulse flex-shrink-0" />}
        {cfg.label}
      </span>
    );
  }

  if (cfg.variant === 'soft') {
    return (
      <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wide shrink-0 ${cfg.colorCls}`}>
        {cfg.pulse && <span className="w-1.5 h-1.5 bg-current animate-status-pulse flex-shrink-0" />}
        {cfg.label}
        {prNumber && <span className="opacity-70">#{prNumber}</span>}
      </span>
    );
  }

  // muted — text only, no bg/border
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wide shrink-0 ${cfg.colorCls}`}>
      {cfg.label}
    </span>
  );
}
