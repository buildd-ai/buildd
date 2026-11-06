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
  addMilestone: (milestone: Milestone) => void;
  /** Test seam; defaults to the scanner's own state. */
  openFailures?: (workerId: string) => OpenVerifyFailure[];
  /** Turns so far, when the caller knows it. */
  turns?: () => number | undefined;
  log?: (line: string) => void;
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
      const common = `mode=${deps.mode} arm=none turns=${turns ?? 'unknown'} tokens=${tokens}`;
      let label: string;
      let checklist: ReturnType<typeof buildSelfReviewChecklist> | null = null;
      if (exemption) {
        label = `Self-review: ${common} exempt=${exemption}`;
      } else {
        checklist = buildSelfReviewChecklist(deps.task);
        label = checklist
          ? `Self-review: ${common} version=${checklist.version} items=${checklist.items.map(it => it.id).join(',') || 'none'}`
          : `Self-review: ${common} builder-failed`;
      }
      deps.addMilestone({ type: 'status', label: label.slice(0, 300), ts: Date.now() });

      // Structured answer record (R-6): the same fields the acting stage records.
      // Recording never asks, so there is no denial: addedTurns/addedTokens are 0
      // and nothing changed after one; `answers` is whatever the agent volunteered.
      const record = {
        mode: deps.mode,
        arm: 'none',
        exemption: exemption ?? null,
        outcome: exemption ? 'exempt' : checklist ? 'eligible' : 'failed_open',
        checklistVersion: checklist?.version ?? null,
        itemIds: checklist?.items.map(it => it.id) ?? [],
        answers: boundAnswers((params.structuredOutput as any)?.selfReview),
        toolCallsBetween: [],
        addedTurns: 0,
        addedTokens: 0,
        workChangedAfterDenial: false,
      };
      deps.addMilestone({ type: 'status', label: serializeRecord(record), ts: Date.now() });
    } catch (err) {
      log(`Self-review recording failed open: ${err instanceof Error ? err.message : String(err)}`);
    }
    return {};
  };
}

const RECORD_PREFIX = 'Self-review record: ';
const RECORD_MAX = 1000;
const MAX_ANSWERS = 12;
const MAX_FIELD = 80;

/** Keep id/answer/evidence per item, each bounded, so the record stays small. */
function boundAnswers(raw: unknown): unknown {
  if (raw == null) return null;
  const cap = (v: unknown) => (typeof v === 'string' ? v.slice(0, MAX_FIELD) : v);
  if (Array.isArray(raw)) {
    return raw.slice(0, MAX_ANSWERS).map(a =>
      a && typeof a === 'object'
        ? { id: cap((a as any).id), answer: cap((a as any).answer), evidence: cap((a as any).evidence) }
        : cap(a));
  }
  return cap(typeof raw === 'string' ? raw : JSON.stringify(raw));
}

/** Always returns `prefix + valid JSON` within RECORD_MAX; never a cut-off string. */
function serializeRecord(record: Record<string, unknown>): string {
  let out = RECORD_PREFIX + JSON.stringify(record);
  if (out.length <= RECORD_MAX) return out;
  out = RECORD_PREFIX + JSON.stringify({ ...record, answers: null, truncated: true });
  if (out.length <= RECORD_MAX) return out;
  return RECORD_PREFIX + JSON.stringify({ ...record, itemIds: [], answers: null, truncated: true });
}
