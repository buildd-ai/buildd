'use client';

import type { LoopState } from '@buildd/shared';
import { LoopStatusChip } from '@/components/LoopStatus';
import type { Stage } from '@/lib/stage';

// Stage derivation lives in `@/lib/stage` so the server render can call it —
// see the header comment there. Re-exported as a type only: exporting the
// function from this client module is what broke /app/home.
export type { Stage, StageInput } from '@/lib/stage';

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
