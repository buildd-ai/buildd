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
import { denyPreToolUse } from './hook-factory';
import { runnerDenial } from './runner-denial';
import { isBuilddActionTool } from '@buildd/shared';
import { resolveStagedReviewMode, assignStagedReviewArm, effectiveStagedArm } from '@buildd/core/staged-self-review';
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

/**
 * The record() sink: appends each staged task's full entry (checklist ids,
 * answers, toolCallsBetween, addedTurns/Tokens, workChangedAfterDenial) to
 * worker.stagedSelfReview, which the completion report copies into
 * resultMeta.stagedSelfReview for the readout. The milestone is only the short
 * human-readable pointer.
 */
export function createStagedRecorder(
  worker: { stagedSelfReview?: Array<Record<string, unknown>> },
  addMilestone: (m: { type: 'status'; label: string; ts: number }) => void,
  now: () => number = Date.now,
): (entry: StagedEntry) => void {
  return e => {
    (worker.stagedSelfReview ??= []).push({ ...e, ts: now() });
    addMilestone({ type: 'status', label: `Self-review: ${e.outcome} (${e.arm}, ${e.mode})`, ts: now() });
  };
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
      return denyPreToolUse(runnerDenial(reason(checklist)));
    } catch (err) {
      log(`Staged self-review failed open: ${err instanceof Error ? err.message : String(err)}`);
      try { rec('failed_open', null); } catch { /* never block */ }
      return {};
    }
  };
}

/**
 * Workspace config -> mode and arm. `gitConfig.selfReview` is off | recording |
 * acting; acting needs `gitConfig.selfReviewExperiment` ({ id, policyVersion,
 * treatmentFraction, checklistVersion? }) or every task draws control, so an
 * acting switch without a registered experiment denies nothing.
 */
export function resolveStagedConfig(
  gitConfig: { selfReview?: unknown; selfReviewExperiment?: any } | null | undefined,
  taskId: string,
): { mode: StagedMode; arm: StagedArm; propensity?: number } {
  const exp = gitConfig?.selfReviewExperiment;
  const mode = resolveStagedReviewMode(
    gitConfig?.selfReview === 'acting' || gitConfig?.selfReview === 'recording' ? { mode: String(gitConfig.selfReview), checklistVersion: exp?.checklistVersion } : null,
    { checklistVersion: undefined },
  );
  if (mode === 'off') return { mode, arm: 'control' };
  if (!exp?.id || !taskId) return { mode, arm: 'control', propensity: 1 };
  try {
    const drawn = assignStagedReviewArm({ taskId, experiment: { id: String(exp.id), policyVersion: exp.policyVersion ?? 1, treatmentFraction: exp.treatmentFraction } });
    return { mode, arm: effectiveStagedArm({ mode, arm: drawn.arm }), propensity: drawn.propensity };
  } catch {
    return { mode, arm: 'control', propensity: 1 };
  }
}

/**
 * The fetched workspace config, with the running experiment taken from the
 * claimed task's workspace. The claim route attaches `selfReviewExperiment`
 * there (claim/staged-arm.ts); getWorkspaceConfig never does, so
 * without this merge every acting task draws control at propensity 1.
 */
export function stagedGitConfig<T extends { selfReviewExperiment?: unknown } | null | undefined>(
  fetched: T,
  claimed: { selfReviewExperiment?: unknown } | null | undefined,
): T {
  const exp = claimed?.selfReviewExperiment;
  if (!exp) return fetched;
  return { ...(fetched ?? {}), selfReviewExperiment: exp } as T;
}

/**
 * The PreToolUse matcher entries the runner registers for acting mode: the
 * deny-once hook, then the tool-call counter. Empty for Codex (no PreToolUse
 * seam) and for any mode but acting. workers.ts spreads this into the chain
 * after the verify guard; tests drive the same function.
 */
export function stagedSelfReviewPreToolUse(opts: {
  cfg: { mode: StagedMode; arm: StagedArm; propensity?: number };
  isCodexTask: boolean;
  worker: StagedHookDeps['worker'];
  task: StagedTask;
  record: (entry: StagedEntry) => void;
  hookOverrides?: Partial<StagedHookDeps>;
}): { hooks: ((input: any) => Promise<Record<string, unknown>>)[] }[] {
  if (opts.isCodexTask || opts.cfg.mode !== 'acting') return [];
  return [
    { hooks: [createStagedSelfReviewHook({
      worker: opts.worker, task: opts.task, mode: opts.cfg.mode, arm: opts.cfg.arm,
      propensity: opts.cfg.propensity, record: opts.record, ...opts.hookOverrides,
    })] },
    { hooks: [async (input: any) => {
      if (input?.hook_event_name === 'PreToolUse' && input.tool_name) noteStagedToolCall(opts.worker.id, input.tool_name);
      return {};
    }] },
  ];
}
