'use client';

import type { LoopState } from '@buildd/shared';
import { LoopStatusChip } from '@/components/LoopStatus';

// ─── Stage enum ───────────────────────────────────────────────────────────────

export type Stage =
  | 'BLOCKED'
  | 'QUEUED'
  | 'RUNNING'
  | 'WAITING_INPUT'
  | 'REVIEW'
  | 'CI'
  | 'MERGE'
  | 'VERIFY'
  | 'DONE'
  | 'CLOSED'
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
}

/**
 * Derive a Stage from task + worker state.
 * Single source of truth — callers must not fork this logic.
 */
export function deriveStage(input: StageInput): Stage {
  const { taskStatus, workerStatus, prUrl, prLifecycleStatus, mergedAt, isBlocked } = input;

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
    if (isMerged) return 'DONE';
    if (isClosed) return 'CLOSED';
    if (prLifecycleStatus === 'ci_running') return 'CI';
    return 'REVIEW';
  }

  if (taskStatus === 'completed') return 'DONE';

  // Pending family
  if (taskStatus === 'assigned') return 'QUEUED';
  if (isBlocked) return 'BLOCKED';

  return 'QUEUED';
}

// ─── Visual config ────────────────────────────────────────────────────────────

interface ChipConfig {
  label: string;
  /** filled = bg-color text-white; outlined = border + text only */
  variant: 'filled' | 'outlined' | 'muted';
  colorCls: string;
  pulse?: boolean;
}

const STAGE_CONFIG: Record<Stage, ChipConfig> = {
  BLOCKED:      { label: 'Blocked',     variant: 'filled',   colorCls: 'bg-status-warning text-white' },
  QUEUED:       { label: 'Queued',      variant: 'muted',    colorCls: 'text-text-muted border-border-default' },
  RUNNING:      { label: 'Running',     variant: 'filled',   colorCls: 'bg-status-running text-white', pulse: true },
  WAITING_INPUT:{ label: 'Needs Input', variant: 'filled',   colorCls: 'bg-status-warning text-white' },
  REVIEW:       { label: 'Review',      variant: 'outlined', colorCls: 'text-status-info border-status-info' },
  CI:           { label: 'CI',          variant: 'outlined', colorCls: 'text-status-info border-status-info' },
  MERGE:        { label: 'Merge',       variant: 'outlined', colorCls: 'text-accent-text border-accent' },
  VERIFY:       { label: 'Verify',      variant: 'outlined', colorCls: 'text-status-warning border-status-warning' },
  DONE:         { label: 'Done',        variant: 'muted',    colorCls: 'text-status-success border-status-success' },
  CLOSED:       { label: 'Closed',      variant: 'muted',    colorCls: 'text-text-muted border-border-default' },
  FAILED:       { label: 'Failed',      variant: 'filled',   colorCls: 'bg-status-error text-white' },
  CANCELLED:    { label: 'Cancelled',   variant: 'muted',    colorCls: 'text-text-muted border-border-default' },
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
 * Outlined = has a PR artifact. Filled = pre-PR, active. Muted = terminal.
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
      <span className="inline-flex items-center px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wide border text-status-info border-status-info shrink-0">
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

  if (cfg.variant === 'outlined') {
    return (
      <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wide border shrink-0 ${cfg.colorCls}`}>
        {cfg.label}
        {prNumber && <span className="opacity-70">#{prNumber}</span>}
      </span>
    );
  }

  // muted
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wide border shrink-0 ${cfg.colorCls}`}>
      {cfg.label}
    </span>
  );
}
