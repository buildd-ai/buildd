/**
 * Self-review guard, recording stage (Living Spec f3742450, step T2).
 *
 * A PreToolUse hook on a successful complete_task. It builds the intent-only
 * checklist (self-review-checklist.ts) and RECORDS what it would have asked,
 * as one session milestone (the existing log path: milestones sync to the
 * server with the worker's other progress). It never denies a completion, and
 * every failure inside it fails open (AC-4, AC-7).
 *
 * Mode `off` (the default) creates no state and writes no log (AC-9). verify-guard
 * keeps priority: while a verify failure is open the stage stands down, so
 * the agent sees verify-guard's refusal and nothing from this stage (AC-1).
 */
import { isBuilddActionTool } from '@buildd/shared';
import { unrecoveredVerifyFailures, type OpenVerifyFailure } from './error-trace-scanner';
import {
  buildSelfReviewChecklist,
  selfReviewExemption,
  type SelfReviewTaskInput,
} from './self-review-checklist';
import type { LocalWorker, Milestone } from './types';

export type SelfReviewMode = 'off' | 'recording';

/** Workspace config (gitConfig.selfReview). Absent or unknown = off. */
export function resolveSelfReviewMode(gitConfig: { selfReview?: unknown } | null | undefined): SelfReviewMode {
  return gitConfig?.selfReview === 'recording' ? 'recording' : 'off';
}

export interface SelfReviewGuardDeps {
  worker: Pick<LocalWorker, 'id'> & Partial<Pick<LocalWorker, 'toolCalls' | 'tokenTally'>>;
  task: SelfReviewTaskInput & { roleSlug?: string | null; context?: Record<string, any> | null; outputRequirement?: string | null };
  mode: SelfReviewMode;
  /** Test seam; defaults to a deterministic draw on the worker id. */
  arm?: 'control' | 'treatment';
  addMilestone: (milestone: Milestone) => void;
  /** Test seam; defaults to the scanner's own state. */
  openFailures?: (workerId: string) => OpenVerifyFailure[];
  /** Turns so far, when the caller knows it. */
  turns?: () => number | undefined;
  log?: (line: string) => void;
}

/**
 * Deterministic control/treatment draw for a worker (propensity 0.5). Recording
 * never acts on it; it logs the arm the acting stage would have drawn, so the
 * control arm is a recorded fact rather than `none`. Hash of the worker id.
 */
export function drawSelfReviewArm(workerId: string): 'control' | 'treatment' {
  let h = 2166136261;
  for (let k = 0; k < workerId.length; k++) {
    h ^= workerId.charCodeAt(k);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h & 1) === 0 ? 'control' : 'treatment';
}

export function createSelfReviewGuardHook(deps: SelfReviewGuardDeps) {
  // Mode off: no closure state, nothing ever written.
  if (deps.mode === 'off') return async (_input: unknown): Promise<Record<string, unknown>> => ({});

  const openFailures = deps.openFailures ?? unrecoveredVerifyFailures;
  const log = deps.log ?? ((line: string) => console.log(`[Worker ${deps.worker.id}] ${line}`));
  let fired = false;

  return async (input: unknown): Promise<Record<string, unknown>> => {
    try {
      const i = (input ?? {}) as { hook_event_name?: string; tool_name?: string; tool_input?: Record<string, unknown> };
      if (fired || i.hook_event_name !== 'PreToolUse') return {};
      const toolInput = i.tool_input ?? {};
      if (!isBuilddActionTool(i.tool_name ?? '') || toolInput.action !== 'complete_task') return {};
      if (openFailures(deps.worker.id).length > 0) return {};
      fired = true;

      const params = (toolInput.params ?? {}) as Record<string, any>;
      const ctx = deps.task.context ?? {};
      const exemption = selfReviewExemption({
        error: params.error,
        blockedOnTaskId: params.blockedOnTaskId,
        discardEdits: params.discardEdits,
        roleSlug: deps.task.roleSlug,
        bookkeeping: Boolean(ctx.bookkeeping),
        planning: Boolean(ctx.planning),
        alreadyShippedIn: params.alreadyShippedIn,
        outputRequirement: deps.task.outputRequirement,
      });

      const tokens = (deps.worker.tokenTally?.inputTokens ?? 0) + (deps.worker.tokenTally?.outputTokens ?? 0);
      const turns = deps.turns?.();
      const common = `mode=${deps.mode} arm=${deps.arm ?? drawSelfReviewArm(deps.worker.id)} propensity=0.5 turns=${turns ?? 'unknown'} tokens=${tokens}`;
      let label: string;
      if (exemption) {
        label = `Self-review: ${common} exempt=${exemption}`;
      } else {
        const checklist = buildSelfReviewChecklist(deps.task);
        label = checklist
          ? `Self-review: ${common} version=${checklist.version} items=${checklist.items.map(it => it.id).join(',') || 'none'} checklist=${checklist.items.map(it => `[${it.id}] ${it.text}`).join(' | ')}`
          : `Self-review: ${common} builder-failed`;
      }
      deps.addMilestone({ type: 'status', label: label.slice(0, 2000), ts: Date.now() });
    } catch (err) {
      log(`Self-review recording failed open: ${err instanceof Error ? err.message : String(err)}`);
    }
    return {};
  };
}
