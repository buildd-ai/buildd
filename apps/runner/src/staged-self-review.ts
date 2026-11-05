/**
 * Staged self-review, acting stage (Living Spec f3742450).
 *
 * A PreToolUse hook on a successful complete_task. In acting mode, treatment
 * arm, it denies ONCE per worker with an intent-only checklist; the agent's next
 * complete_task is the answer and goes through. Recording mode computes and logs
 * what it would ask and never denies. Off has no footprint. Everything fails open.
 * verify-guard keeps priority and is not touched: while a verify failure is open
 * this stage stands down and spends nothing. No model call lives here.
 */
import { isBuilddActionTool } from '@buildd/shared';
import { unrecoveredVerifyFailures, type OpenVerifyFailure } from './error-trace-scanner';
import { buildSelfReviewChecklist, selfReviewExemption, type SelfReviewTaskInput } from './self-review-checklist';

export type StagedMode = 'off' | 'recording' | 'acting';
export type StagedArm = 'control' | 'treatment';
export type StagedOutcome = 'exempt' | 'eligible' | 'control' | 'denied' | 'answered' | 'failed_open';

export interface StagedTask extends SelfReviewTaskInput {
  id?: string;
  roleSlug?: string | null;
  outputRequirement?: string | null;
  kind?: string | null;
  context?: Record<string, any> | null;
}

export interface IntentChecklist {
  version: string;
  items: { id: string; text: string }[];
}

export interface StagedEntry {
  mode: StagedMode;
  arm: StagedArm;
  exemption: string | null;
  outcome: StagedOutcome;
  propensity?: number;
  checklistVersion?: string;
  itemIds?: string[];
  answers?: unknown;
  toolCallsBetween?: string[];
  addedTurns?: number | null;
  addedTokens?: number | null;
  workChangedAfterDenial?: boolean;
}

export interface StagedHookDeps {
  worker: { id: string; tokenTally?: { inputTokens?: number; outputTokens?: number } | null };
  task: StagedTask;
  mode: StagedMode;
  arm: StagedArm;
  propensity?: number;
  backend?: string;
  /** Set when this worker was already staged (e.g. the hook was rebuilt on resume). */
  alreadyStaged?: boolean;
  openFailures?: (workerId: string) => OpenVerifyFailure[];
  buildChecklist?: (task: StagedTask) => IntentChecklist;
  turns?: () => number | undefined;
  record: (entry: StagedEntry) => void;
  log?: (line: string) => void;
}

const KIND_EXEMPT: Record<string, string> = {
  reviewer: 'reviewer',
  visual_auditor: 'visual-auditor',
  'visual-auditor': 'visual-auditor',
  bookkeeping: 'bookkeeping',
  planning: 'planning',
};

const EDIT_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit)$/;

/** Tool calls made between a denial and its answer, per worker. */
const between = new Map<string, string[]>();

/** Called by the runner for each tool call; only counts while a denial is open. */
export function noteStagedToolCall(workerId: string, tool: string): void {
  between.get(workerId)?.push(tool);
}

/** Intent-only checklist built from the task alone. Deterministic. */
export function buildIntentChecklist(task: StagedTask): IntentChecklist {
  const base = buildSelfReviewChecklist(task);
  if (!base) throw new Error('checklist build failed');
  const items = base.items.map(i => ({ id: i.id, text: i.text }));
  items.push(
    { id: 'every-requirement', text: 'Does the work cover every requirement the task states, including every sibling case it implies, not only the first one you found?' },
    { id: 'summary-claims', text: 'Does each claim in your summary match what the task asked and what you actually did, with nothing overclaimed?' },
  );
  return { version: `intent-v${base.version}`, items };
}

function reason(c: IntentChecklist): string {
  return [
    'Before completing, check the work against the task requirement and its scope. Answer each item, then call complete_task again.',
    ...c.items.map((i, n) => `${n + 1}. [${i.id}] ${i.text}`),
    'Put answers in structuredOutput.selfReview as [{ id, answer: "met" | "unmet" | "n/a", evidence }]. If an item is unmet, fix it first.',
  ].join('\n');
}

export function createStagedSelfReviewHook(deps: StagedHookDeps) {
  if (deps.mode === 'off') return async (_input: unknown): Promise<Record<string, unknown>> => ({});

  const openFailures = deps.openFailures ?? unrecoveredVerifyFailures;
  const build = deps.buildChecklist ?? buildIntentChecklist;
  const log = deps.log ?? ((l: string) => console.log(`[Worker ${deps.worker.id}] ${l}`));
  let staged = Boolean(deps.alreadyStaged);
  let denialAt: { turns?: number; tokens: number; summary: unknown; version: string; ids: string[] } | null = null;
  const tokens = () => (deps.worker.tokenTally?.inputTokens ?? 0) + (deps.worker.tokenTally?.outputTokens ?? 0);
  const rec = (outcome: StagedOutcome, exemption: string | null, extra: Partial<StagedEntry> = {}) =>
    deps.record({ mode: deps.mode, arm: deps.arm, exemption, outcome, propensity: deps.propensity, ...extra });

  return async (input: unknown): Promise<Record<string, unknown>> => {
    try {
      const i = (input ?? {}) as { hook_event_name?: string; tool_name?: string; tool_input?: Record<string, unknown> };
      if (i.hook_event_name !== 'PreToolUse') return {};
      const ti = i.tool_input ?? {};
      if (!isBuilddActionTool(i.tool_name ?? '') || ti.action !== 'complete_task') return {};
      const params = (ti.params ?? {}) as Record<string, any>;

      // Answer to our own denial: record and let it through.
      if (denialAt) {
        const calls = between.get(deps.worker.id) ?? [];
        between.delete(deps.worker.id);
        const d = denialAt;
        denialAt = null;
        const turnsNow = deps.turns?.();
        rec('answered', null, {
          checklistVersion: d.version,
          itemIds: d.ids,
          answers: params.structuredOutput?.selfReview ?? null,
          toolCallsBetween: calls,
          addedTurns: turnsNow !== undefined && d.turns !== undefined ? turnsNow - d.turns : null,
          addedTokens: tokens() - d.tokens,
          workChangedAfterDenial: calls.some(c => EDIT_TOOLS.test(c)) || params.summary !== d.summary,
        });
        return {};
      }
      if (staged) return {};

      if (deps.backend === 'codex') { rec('exempt', 'exempt:codex'); return {}; }
      if (openFailures(deps.worker.id).length > 0) return {};

      const ctx = deps.task.context ?? {};
      const kind = deps.task.kind ? KIND_EXEMPT[deps.task.kind] : undefined;
      const reasonStr = kind ?? selfReviewExemption({
        error: params.error,
        blockedOnTaskId: params.blockedOnTaskId,
        discardEdits: params.discardEdits,
        roleSlug: deps.task.roleSlug,
        bookkeeping: Boolean(ctx.bookkeeping),
        planning: Boolean(ctx.planning),
        alreadyShippedIn: params.alreadyShippedIn,
        outputRequirement: deps.task.outputRequirement,
      });
      if (reasonStr) { rec('exempt', `exempt:${reasonStr}`); return {}; }

      let checklist: IntentChecklist;
      try {
        checklist = build(deps.task);
      } catch (err) {
        log(`Staged self-review failed open: ${err instanceof Error ? err.message : String(err)}`);
        rec('failed_open', null);
        return {};
      }
      const ids = checklist.items.map(x => x.id);
      if (deps.mode === 'recording') { rec('eligible', null, { checklistVersion: checklist.version, itemIds: ids }); return {}; }
      if (deps.arm !== 'treatment') { rec('control', null); return {}; }

      staged = true;
      denialAt = { turns: deps.turns?.(), tokens: tokens(), summary: params.summary, version: checklist.version, ids };
      between.set(deps.worker.id, []);
      rec('denied', null, { checklistVersion: checklist.version, itemIds: ids });
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: reason(checklist),
        },
      };
    } catch (err) {
      log(`Staged self-review failed open: ${err instanceof Error ? err.message : String(err)}`);
      try { rec('failed_open', null); } catch { /* never block */ }
      return {};
    }
  };
}
