/**
 * The task category decision (docs/design/decision-calls.md → task category).
 *
 * `classifyTask` (./task-category.ts) picks a category with keyword regexes.
 * This module asks a decision model (Jev) the same question and, when it is
 * confident enough, stores its answer. Measured offline on merged work
 * (scripts/decision-benchmark.ts, gold = the PR's conventional-commit type):
 * the keyword rules were right on roughly half of held-out tasks, Jev on about
 * three quarters, and past 90% at the gates below.
 *
 * The gate (`gateTaskCategory`):
 *   - a category the caller supplied is never changed;
 *   - `review` is never written and never replaced: it is a behaviour flag
 *     (reviewer dispatch, claim-gate exemptions, completion), not a label;
 *   - the keyword rules abstained ⇒ Jev fills in at FILL_MIN_CONFIDENCE;
 *   - the keyword rules disagree ⇒ Jev replaces them at OVERRIDE_MIN_CONFIDENCE.
 *
 * Every task gets one look, recorded in `tasks.category_decision` with the
 * prompt/model version, the keyword result and the model's pick, so a write is
 * reversible and a later prompt can be re-scored. Two triggers share the one
 * function: task creation (POST /api/tasks, after the response) and a sweep in
 * the hourly schedules tick for every other creation path. The backfill script
 * runs the sweep over a wider window.
 *
 * A `built_in` capability: there is no per-team switch, it runs for every
 * team whenever a decision key resolves (packages/core/inference-policy.ts).
 * An off-by-default shadow is an `opt_in` capability instead, listed in
 * `teams.enabledDecisionShadows` (the role shadow, ./task-role-decision.ts).
 * Sensitive workspaces never send task content out.
 */
import { createHash } from 'node:crypto';
import { TaskCategory, type TaskCategoryValue } from '@buildd/shared';
import { isJevModel } from '@buildd/core/decision-model';
// Types only at module scope. The client (and the DB layer behind it) is loaded
// lazily inside the run, so importing this module from the task route adds
// nothing to that route's static import graph.
import type {
  ChoiceQuestion,
  DecisionResult,
  decisionCall,
} from '@buildd/core/decision-client';

/** Whole-call ceiling. It runs after the response is sent, or in a sweep. */
export const DECISION_TIMEOUT_MS = 3_000;

/** Description is truncated: Jev's accuracy falls as irrelevant state grows. */
export const DECISION_DESCRIPTION_CHARS = 1_500;

export const DECISION_LOG_PREFIX = '[task-category]';

/** The keyword rules abstained: fill in at this confidence (held-out ~92% accurate). */
export const FILL_MIN_CONFIDENCE = 0.8;
/** The keyword rules picked something else: replace it at this confidence (~94%). */
export const OVERRIDE_MIN_CONFIDENCE = 0.9;

/**
 * Bump when the question or any definition changes, and re-run the benchmark.
 * A test pins the prompt's hash to this version.
 */
export const TASK_CATEGORY_PROMPT_VERSION = 'tc1';

/**
 * Label definitions. Every category buildd stores, including `review`, which
 * the keyword classifier can never emit (it is missing from `CATEGORY_ORDER`).
 *
 * No catch-all label on purpose: a catch-all absorbs unfamiliar inputs. "None
 * fits" shows up as low confidence instead, which is what the gate is for.
 * Definitions are contrastive (what it is / what it is not) because overlapping
 * labels cost more accuracy than any threshold can win back.
 */
const CATEGORY_CRITERIA: Record<TaskCategoryValue, { what: string; not_for: string }> = {
  bug: {
    what: 'Something that used to work, or should work, is broken: a crash, wrong output, error, or regression to fix.',
    not_for: 'Adding new behaviour, or tidying code that works.',
  },
  feature: {
    what: 'Add new user-facing or API behaviour that does not exist yet.',
    not_for: 'Fixing broken behaviour, restructuring existing code, or docs/tests alone.',
  },
  refactor: {
    what: 'Restructure, rename, clean up or migrate existing code without changing what it does.',
    not_for: 'Fixing a bug or adding behaviour.',
  },
  chore: {
    what: 'Routine maintenance: dependency bumps, upgrades, version housekeeping.',
    not_for: 'CI/deploy pipeline or infrastructure work, or code restructuring.',
  },
  docs: {
    what: 'Write or change documentation, READMEs, specs, design docs or code comments that describe how something works or should work.',
    not_for: 'Changing the code or tests the documentation describes, or investigating an open question and reporting findings.',
  },
  test: {
    what: 'Add or change automated tests or test coverage, without changing product code.',
    not_for: 'Fixing the bug a test found, or building the feature it covers.',
  },
  infra: {
    what: 'CI, deploy pipelines, containers, hosting, environment and build configuration.',
    not_for: 'Application features, or dependency version bumps alone.',
  },
  design: {
    what: 'Visual or interaction design: UI, UX, layout, styling.',
    not_for: 'Backend or API changes that happen to be described as a "design".',
  },
  review: {
    what: 'Review a specific existing pull request, diff or proposed change that someone else made, and give a verdict or findings on that change.',
    not_for: 'Researching options, tools or vendors, or answering an open question where no change exists yet to review; or making the change itself.',
  },
  research: {
    what: 'Investigate an open question and report findings or a recommendation: compare options, evaluate tools, vendors or approaches, a spike or feasibility study. Nothing in the product is changed.',
    not_for: 'Diagnosing a specific failure (bug), reviewing an existing PR or change (review), or building the thing once it has been chosen.',
  },
};

export const TASK_CATEGORY_LABELS = Object.values(TaskCategory) as TaskCategoryValue[];

export const TASK_CATEGORY_QUESTIONS = {
  category: {
    type: 'choice',
    instructions: {
      question: 'Which category best describes the work requested in `task.title` and `task.description`?',
      rule: 'Follow the category definitions, even when a word in the title (such as "fix", "add" or "test") points elsewhere.',
    },
    criteria: CATEGORY_CRITERIA,
  } satisfies ChoiceQuestion<TaskCategoryValue>,
};

export function buildTaskCategoryState(title: string, description?: string | null) {
  const desc = (description ?? '').trim();
  return {
    task: {
      title: title.trim(),
      description: desc.length > DECISION_DESCRIPTION_CHARS ? `${desc.slice(0, DECISION_DESCRIPTION_CHARS)}…` : desc,
    },
  };
}

/** Hash of the prompt, pinned by a test to TASK_CATEGORY_PROMPT_VERSION. */
export function taskCategoryPromptHash(): string {
  return createHash('sha256').update(JSON.stringify(TASK_CATEGORY_QUESTIONS)).digest('hex').slice(0, 12);
}

export type TaskCategoryDecisionRecord = {
  v: string;
  source: 'caller' | 'keyword' | 'jev';
  keyword: string | null;
  jev: string | null;
  confidence: number | null;
  skipped?: 'sensitive' | 'unconfigured';
  at: string;
};

export interface GateInput {
  /** The category on the row now. */
  stored: TaskCategoryValue | null;
  /** Did the caller supply `stored` (vs the keyword rules)? */
  callerSet: boolean;
  keyword: TaskCategoryValue | null;
  decision: TaskCategoryValue;
  confidence: number;
}

/** What the row should say, and who decided it. Pure. */
export function gateTaskCategory(g: GateInput): { category: TaskCategoryValue | null; source: TaskCategoryDecisionRecord['source'] } {
  const keep = { category: g.stored, source: g.callerSet ? 'caller' as const : 'keyword' as const };
  if (g.callerSet || g.stored === 'review' || g.decision === 'review') return keep;
  if (g.decision === g.stored) return keep;
  const min = g.stored === null ? FILL_MIN_CONFIDENCE : OVERRIDE_MIN_CONFIDENCE;
  return g.confidence >= min ? { category: g.decision, source: 'jev' } : keep;
}

export interface CategorizeInput {
  taskId: string;
  teamId: string;
  workspaceId: string;
  accountId?: string | null;
  title: string;
  description?: string | null;
  /** The category on the row now. */
  stored: TaskCategoryValue | null;
  /** Did the caller supply `stored`? The route knows; the sweep infers it. */
  callerSet: boolean;
  /** `workspaces.gitConfig.dataClass`. Sensitive workspaces never send content out. */
  dataClass?: string | null;
}

type DecideFn = typeof decisionCall<typeof TASK_CATEGORY_QUESTIONS>;

/**
 * Writes the row. Optimistic: only while the category is still what was read,
 * and only once (category_decision IS NULL, or a look skipped for want of a
 * key), so a concurrent edit or a second
 * trigger never clobbers anything. Returns whether a row changed.
 */
export type WriteDecision = (taskId: string, expected: TaskCategoryValue | null, category: TaskCategoryValue | null, record: TaskCategoryDecisionRecord) => Promise<boolean>;

async function dbWrite(taskId: string, expected: TaskCategoryValue | null, category: TaskCategoryValue | null, record: TaskCategoryDecisionRecord): Promise<boolean> {
  const { db } = await import('@buildd/core/db');
  const { tasks } = await import('@buildd/core/db/schema');
  const { and, eq, isNull, or, sql } = await import('drizzle-orm');
  const rows = await db.update(tasks)
    .set({ category, categoryDecision: record })
    .where(and(
      eq(tasks.id, taskId),
      // Once per task; a look skipped for want of a key may be retried.
      or(isNull(tasks.categoryDecision), sql`${tasks.categoryDecision}->>'skipped' = 'unconfigured'`),
      expected === null ? isNull(tasks.category) : eq(tasks.category, expected),
    ))
    .returning({ id: tasks.id });
  return rows.length > 0;
}

export interface CategorizeResult {
  outcome: 'applied' | 'kept' | 'skipped' | 'lost_race' | 'error';
  record?: TaskCategoryDecisionRecord;
}

/**
 * Decide one task's category and record the look. Never throws. A transient
 * failure (timeout, 5xx) records nothing, so the sweep tries again.
 */
export async function categorizeTask(
  input: CategorizeInput,
  deps: { decide?: DecideFn; write?: WriteDecision; classify?: (title: string, description?: string | null) => TaskCategoryValue | null; now?: () => Date; log?: (line: string) => void } = {},
): Promise<CategorizeResult> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const write = deps.write ?? dbWrite;
  const at = (deps.now?.() ?? new Date()).toISOString();
  try {
    const classify = deps.classify ?? (await import('./task-category')).classifyTask as (t: string, d?: string | null) => TaskCategoryValue | null;
    const keyword = classify(input.title, input.description ?? undefined);
    const base = { keyword, at };
    const source = input.callerSet ? 'caller' as const : 'keyword' as const;

    // Nothing the gate could change: record the look, spend nothing.
    if (input.callerSet || input.stored === 'review') {
      const record: TaskCategoryDecisionRecord = { v: TASK_CATEGORY_PROMPT_VERSION, source, jev: null, confidence: null, ...base };
      return { outcome: (await write(input.taskId, input.stored, input.stored, record)) ? 'kept' : 'lost_race', record };
    }

    if (input.dataClass === 'sensitive') {
      const record: TaskCategoryDecisionRecord = { v: TASK_CATEGORY_PROMPT_VERSION, source, jev: null, confidence: null, skipped: 'sensitive', ...base };
      return { outcome: (await write(input.taskId, input.stored, input.stored, record)) ? 'skipped' : 'lost_race', record };
    }

    const client = deps.decide ? null : await import('@buildd/core/decision-client');
    const decide = deps.decide ?? client!.decisionCall;
    const res: DecisionResult<typeof TASK_CATEGORY_QUESTIONS> = await decide({
      capability: 'task_category',
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      accountId: input.accountId ?? null,
      state: buildTaskCategoryState(input.title, input.description),
      questions: TASK_CATEGORY_QUESTIONS,
      timeoutMs: DECISION_TIMEOUT_MS,
    });

    if (!res.ok) {
      if (res.error.kind === 'capability_disabled' || res.error.kind === 'missing_key') {
        // Not configured: record the look so the sweep doesn't ask again every
        // hour. The backfill re-asks once a key exists.
        const record: TaskCategoryDecisionRecord = { v: TASK_CATEGORY_PROMPT_VERSION, source, jev: null, confidence: null, skipped: 'unconfigured', ...base };
        return { outcome: (await write(input.taskId, input.stored, input.stored, record)) ? 'skipped' : 'lost_race', record };
      }
      log(`${DECISION_LOG_PREFIX} ${JSON.stringify({ taskId: input.taskId, error: res.error.kind, latencyMs: res.latencyMs })}`);
      return { outcome: 'error' };
    }

    const answer = res.answers.category;
    // The gates were measured on Jev. A team's own decision model is recorded,
    // never applied, until it has its own eval (decision-model.ts).
    const gated = isJevModel(res.model)
      ? gateTaskCategory({
        stored: input.stored, callerSet: input.callerSet, keyword, decision: answer.choice, confidence: answer.confidence,
      })
      : { category: input.stored, source: input.callerSet ? 'caller' as const : 'keyword' as const };
    const record: TaskCategoryDecisionRecord = {
      v: `${TASK_CATEGORY_PROMPT_VERSION}|${res.model}`,
      source: gated.source, jev: answer.choice, confidence: answer.confidence, ...base,
    };
    const wrote = await write(input.taskId, input.stored, gated.category, record);
    // Ids, labels and numbers only: never the task's title or description.
    log(`${DECISION_LOG_PREFIX} ${JSON.stringify({
      taskId: input.taskId, stored: input.stored, keyword, jev: answer.choice, confidence: answer.confidence,
      applied: wrote && gated.source === 'jev', costUsd: res.usage.costUsd,
    })}`);
    if (!wrote) return { outcome: 'lost_race', record };
    return { outcome: gated.source === 'jev' ? 'applied' : 'kept', record };
  } catch (err) {
    console.error(`${DECISION_LOG_PREFIX} failed (non-fatal, task unaffected):`, err);
    return { outcome: 'error' };
  }
}

/**
 * Run after the response, so it can never delay or fail task creation.
 * `schedule` is `next/server`'s `after`; outside a request scope it throws, and
 * the run is fired and forgotten instead.
 */
export function scheduleTaskCategorize(
  input: CategorizeInput,
  schedule: (fn: () => Promise<unknown>) => void,
  deps: Parameters<typeof categorizeTask>[1] = {},
): void {
  const run = () => categorizeTask(input, deps);
  try {
    schedule(run);
  } catch {
    void run();
  }
}
