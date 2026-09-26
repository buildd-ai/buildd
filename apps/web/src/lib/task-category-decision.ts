/**
 * Shadow mode for the task category decision.
 *
 * `classifyTask` (./task-category.ts) picks a category with keyword regexes. This
 * module asks a decision model the same question, off the request path, and
 * logs whether the two agree. **It never changes the stored category** — the
 * keyword result is what the task row gets, with or without this module.
 *
 * The point is to collect agreement/confidence evidence cheaply before anything
 * is switched over. See `docs/design/decision-calls.md` → "Shadow: classifyTask".
 *
 * Off by default, twice over: the team must enable the `task_category_shadow`
 * inference capability, and an OpenRouter `decision_key` must resolve. With
 * either missing `decisionCall` returns before any network I/O and this module
 * logs nothing.
 *
 * Records go to the log as one `[decision-shadow]` JSON line per task, the same
 * observe-only pattern the worker lease used (`[lease-shadow]` in
 * ./stale-workers.ts). No schema change, no table. A line carries ids, labels
 * and numbers only — never the task's title or description.
 */
import { TaskCategory, type TaskCategoryValue } from '@buildd/shared';
// Types only at module scope. The client (and the DB layer behind it) is loaded
// lazily inside the run, so importing this module from the task route adds
// nothing to that route's static import graph.
import type {
  ChoiceQuestion,
  DecisionResult,
  decisionCall,
} from '@buildd/core/decision-client';

/** Whole-call ceiling for the shadow request. It runs after the response is sent. */
export const SHADOW_TIMEOUT_MS = 3_000;

/** Description is truncated: Jev's accuracy falls as irrelevant state grows. */
export const SHADOW_DESCRIPTION_CHARS = 1_500;

export const SHADOW_LOG_PREFIX = '[decision-shadow]';

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
      description: desc.length > SHADOW_DESCRIPTION_CHARS ? `${desc.slice(0, SHADOW_DESCRIPTION_CHARS)}…` : desc,
    },
  };
}

export interface TaskCategoryShadowInput {
  taskId: string;
  teamId: string;
  workspaceId: string;
  accountId?: string | null;
  title: string;
  description?: string | null;
  /** What `classifyTask` returned and the task row stores. */
  keywordCategory: TaskCategoryValue | null;
  /** `workspaces.gitConfig.dataClass`. Sensitive workspaces never send content out. */
  dataClass?: string | null;
}

/** The record written per shadowed task. Ids, labels and numbers only. */
export interface TaskCategoryShadowRecord {
  site: 'task_category';
  taskId: string;
  workspaceId: string;
  keyword: TaskCategoryValue | null;
  decision: TaskCategoryValue;
  confidence: number;
  /** null when the keyword classifier abstained. */
  agree: boolean | null;
  probabilities: Record<string, number>;
  model: string;
  latencyMs: number;
  inputTokens: number;
  costUsd: number | null;
}

type DecideFn = typeof decisionCall<typeof TASK_CATEGORY_QUESTIONS>;

/**
 * Run the shadow comparison for one task. Never throws, never writes to the
 * task. Returns the record it logged (or null), which is what tests assert on.
 */
export async function runTaskCategoryShadow(
  input: TaskCategoryShadowInput,
  deps: { decide?: DecideFn; log?: (line: string) => void } = {},
): Promise<TaskCategoryShadowRecord | null> {
  const log = deps.log ?? ((line: string) => console.log(line));
  try {
    // Task content must not leave the platform for a sensitive workspace.
    if (input.dataClass === 'sensitive') return null;

    const client = deps.decide ? null : await import('@buildd/core/decision-client');
    const decide = deps.decide ?? client!.decisionCall;
    const res: DecisionResult<typeof TASK_CATEGORY_QUESTIONS> = await decide({
      capability: 'task_category_shadow',
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      accountId: input.accountId ?? null,
      state: buildTaskCategoryState(input.title, input.description),
      questions: TASK_CATEGORY_QUESTIONS,
      timeoutMs: SHADOW_TIMEOUT_MS,
    });

    if (!res.ok) {
      // Not enabled / not configured is the default state: stay silent so the
      // log carries no per-task noise for teams that never opted in.
      if (res.error.kind !== 'capability_disabled' && res.error.kind !== 'missing_key') {
        log(`${SHADOW_LOG_PREFIX} ${JSON.stringify({
          site: 'task_category', taskId: input.taskId, workspaceId: input.workspaceId,
          error: res.error.kind, latencyMs: res.latencyMs,
          ...('status' in res.error ? { status: res.error.status } : {}),
        })}`);
      }
      return null;
    }

    const answer = res.answers.category;
    const record: TaskCategoryShadowRecord = {
      site: 'task_category',
      taskId: input.taskId,
      workspaceId: input.workspaceId,
      keyword: input.keywordCategory,
      decision: answer.choice,
      confidence: answer.confidence,
      agree: input.keywordCategory === null ? null : input.keywordCategory === answer.choice,
      probabilities: answer.probabilities,
      model: res.model,
      latencyMs: res.latencyMs,
      inputTokens: res.usage.inputTokens,
      costUsd: res.usage.costUsd,
    };
    log(`${SHADOW_LOG_PREFIX} ${JSON.stringify(record)}`);
    return record;
  } catch (err) {
    console.error(`${SHADOW_LOG_PREFIX} task_category failed (non-fatal, task unaffected):`, err);
    return null;
  }
}

/**
 * Schedule the shadow run after the response, so it can never delay or fail
 * task creation. `schedule` is `next/server`'s `after`; outside a request scope
 * (tests, scripts) it throws, and the run is fired and forgotten instead.
 */
export function scheduleTaskCategoryShadow(
  input: TaskCategoryShadowInput,
  schedule: (fn: () => Promise<unknown>) => void,
  deps: Parameters<typeof runTaskCategoryShadow>[1] = {},
): void {
  const run = () => runTaskCategoryShadow(input, deps);
  try {
    schedule(run);
  } catch {
    void run();
  }
}
