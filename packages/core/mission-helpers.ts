import type { GoalCriterion, GoalCriterionType, GoalCriteriaState, CriterionVerdict, InitiativeKPI, InitiativeKPIState } from '@buildd/shared';
export type { GoalCriterion, GoalCriterionType, GoalCriteriaState, CriterionVerdict, InitiativeKPI, InitiativeKPIState };
import { type DerivedMetric, derivedValue, derivedUnavailable } from './derived-metric';
import {
  isMissionIntegrationBase,
  isMissionPrTask,
  missionIntegrationBase,
} from './mission-integration';
export type { DerivedMetric } from './derived-metric';

// ─── Task type detection ───────────────────────────────────────────────────────

/** Derived task subtypes for display (no schema change — derived from title prefix + parentTaskId). */
export type TaskType = 'retry' | 'review' | 'review-retry';

/**
 * Derive a task's display type from its title prefix, parentTaskId, and mode.
 *
 * Taxonomy:
 * - prefix match ([CI Retry], [reviewer], [reviewer retry]) → attempt, regardless of mode
 * - parentTaskId IS NOT NULL + mode='execution' + no prefix → spawned builder (distinct deliverable) → null
 * - parentTaskId IS NOT NULL + no prefix + any other mode → legacy/unlabeled retry attempt → 'retry'
 * - parentTaskId IS NULL → root task → null
 *
 * Recognized prefixes are detected regardless of parentTaskId — this covers legacy
 * attempt tasks that predate the parentTaskId column and therefore have
 * parentTaskId IS NULL despite being retries.
 */
export function deriveTaskType(task: {
  title?: string | null;
  parentTaskId?: string | null;
  mode?: string | null;
}): TaskType | null {
  const title = task.title ?? '';
  // Check recognized prefixes first — these always classify the task as an attempt.
  if (/^\[reviewer retry/i.test(title)) return 'review-retry';
  if (/^\[reviewer\]/i.test(title)) return 'review';
  if (/^\[(?:CI )?retry/i.test(title)) return 'retry';
  // No recognized prefix.
  if (!task.parentTaskId) return null;
  // Spawned execution children (created by approve_plan) are distinct units of work.
  // They must be counted separately, not collapsed under their planning-task parent.
  if (task.mode === 'execution') return null;
  // Any other task with parentTaskId is a legacy/unlabeled retry attempt.
  return 'retry';
}

/**
 * Strip a leading bracketed prefix (e.g. "[CI Retry #1]", "[reviewer]") from a task title.
 * Used to clean up displayed titles when a TaskTypeBadge renders the type visually instead.
 */
export function stripTaskTypePrefix(title: string): string {
  return title.replace(/^\[[^\]]+\]\s*/, '').trim();
}

// ─── Goal criteria: form and folding ─────────────────────────────────────────

/**
 * Criterion types whose verdict comes from machinery, not from a model reading
 * prose. Preferred for every criterion: their verdict does not depend on an API
 * key, a token budget, or an LLM being reachable at the moment it is needed.
 */
export const MECHANICAL_CRITERION_TYPES = [
  'command',
  'all_prs_merged',
  'no_open_tasks',
  'artifact_exists',
] as const;

/** Ceiling on criteria per mission (shared by POST and PATCH /api/missions). */
export const MAX_GOAL_CRITERIA = 20;

/**
 * Identity of a criterion, independent of its position in the array.
 *
 * Array index is NOT identity: delete one criterion and every later one is
 * renumbered, so a verdict cached against index 1 would afterwards be read as
 * belonging to whatever moved into slot 1. Any reuse of a stored verdict — the
 * LLM carry-forward, a command criterion's write-back — must match on this
 * instead. Cheap non-cryptographic hash (djb2); collisions cost a re-evaluation,
 * never a wrong verdict transplant.
 */
export function criterionFingerprint(criterion: GoalCriterion): string {
  const parts: string[] = [criterion.type];
  if (criterion.type === 'command') parts.push(criterion.command);
  else if (criterion.type === 'description') parts.push(criterion.description);
  else if (criterion.type === 'metric') parts.push(criterion.query, criterion.operator, String(criterion.threshold));
  else if (criterion.type === 'artifact_exists') parts.push(criterion.key ?? '', criterion.artifactType ?? '');
  else if (criterion.type === 'all_prs_merged') parts.push(String(criterion.requireBranchDeleted ?? false));
  if (criterion.label) parts.push(criterion.label);

  const text = parts.join('\0');
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = (((hash << 5) + hash) ^ text.charCodeAt(i)) >>> 0;
  return `${criterion.type}:${hash.toString(36)}`;
}

/**
 * Fold per-criterion verdicts into the mission-level verdict.
 *
 * The only route to `pass` is every criterion passing. Absence of a verdict
 * (`PENDING`, `NOT_EVALUATED`) folds to `UNVERIFIED` — "we could not check this"
 * is not "this is satisfied". An empty criteria list passes: a mission with no
 * stated goal criteria is not gated by them.
 */
export function recalculateOverall(criteria: GoalCriteriaState['criteria']): CriterionVerdict {
  if (criteria.length === 0) return 'pass';
  if (criteria.some(r => r.verdict === 'fail')) return 'fail';
  if (criteria.every(r => r.verdict === 'pass')) return 'pass';
  return 'UNVERIFIED';
}

/**
 * Validate a `goalCriteria` array at the write boundary.
 *
 * Returns an error string for the first invalid criterion, or null when the
 * whole array is acceptable. Shared by POST and PATCH /api/missions so the two
 * routes cannot drift (the MCP `manage_missions` action posts through them).
 *
 * Beyond shape, this enforces one policy: a `description` criterion — the only
 * form whose verdict needs a live model — must say why no mechanical form could
 * express it. Prose is allowed, but not by default.
 */
export function validateGoalCriteria(
  criteria: unknown,
  opts: {
    /**
     * The mission's currently-stored criteria. Any incoming criterion that is
     * byte-identical to one already stored is grandfathered: the rules below are
     * applied to what the author is CHANGING, not to history. Without this, the
     * dashboard's save (which PATCHes the whole array) and any agent round-trip
     * would 400 forever on a mission holding a pre-gate prose criterion, and the
     * only editor that could fix it would be the one thing that cannot run.
     */
    stored?: unknown;
  } = {},
): string | null {
  if (!Array.isArray(criteria)) return 'goalCriteria must be an array';
  if (criteria.length > MAX_GOAL_CRITERIA) {
    return `goalCriteria must have at most ${MAX_GOAL_CRITERIA} criteria`;
  }

  const grandfathered = new Set(
    (Array.isArray(opts.stored) ? opts.stored : []).map(c => JSON.stringify(c)),
  );

  const validTypes: GoalCriterionType[] = [
    'all_prs_merged', 'command', 'no_open_tasks', 'artifact_exists', 'metric', 'description',
  ];

  for (let i = 0; i < criteria.length; i++) {
    const c = criteria[i];
    const at = `goalCriteria[${i}]`;
    if (typeof c !== 'object' || c === null || Array.isArray(c)) return `${at} must be an object`;
    const raw = c as Record<string, unknown>;
    if (typeof raw.type !== 'string' || !validTypes.includes(raw.type as GoalCriterionType)) {
      return `${at}.type must be one of: ${validTypes.join(', ')}`;
    }
    if (raw.label !== undefined && typeof raw.label !== 'string') {
      return `${at}.label must be a string`;
    }

    // Unchanged history passes through untouched — see opts.stored.
    if (grandfathered.has(JSON.stringify(c))) continue;

    switch (raw.type) {
      case 'command':
        if (typeof raw.command !== 'string' || raw.command.trim() === '') {
          return `${at}.command is required and must be a non-blank string`;
        }
        break;

      case 'metric':
        // No metric-query registry exists, so `evaluateGoalCriteria` returns
        // UNVERIFIED for every metric criterion — forever. Accepting one would be
        // handing the author a gate that can never open, which is worse than
        // having no gate. Rejected at the boundary until the registry ships.
        return (
          `${at}: metric criteria have no evaluator yet — they stay UNVERIFIED and would block ` +
          `completion permanently. Express the check as a command criterion (a script that exits 0) instead.`
        );

      case 'description': {
        if (typeof raw.description !== 'string' || raw.description.trim() === '') {
          return `${at}.description is required and must be a non-blank string`;
        }
        const reason = raw.notMechanizableReason;
        if (typeof reason !== 'string' || reason.trim().length < 10) {
          return (
            `${at} is a prose criterion, so its verdict depends on an LLM being reachable — ` +
            `set notMechanizableReason (10+ chars) explaining why none of ` +
            `${MECHANICAL_CRITERION_TYPES.join(', ')} can express it. ` +
            `Prefer a command criterion: a script that exits 0 needs no model to grade it.`
          );
        }
        break;
      }
    }
  }

  return null;
}

// ─── Goal criteria evaluator ──────────────────────────────────────────────────

/**
 * Evaluate a mission's goalCriteria against the provided context.
 *
 * This is a pure function — it does NOT write to the DB. The caller persists
 * the returned GoalCriteriaState. All criteria are evaluated in order; any
 * 'fail' or 'UNVERIFIED' makes the overall verdict non-pass.
 *
 * 'command' criteria are not executable here (they require a worker task).
 * They return UNVERIFIED; the caller must dispatch the task separately.
 *
 * 'metric' criteria are not implemented yet — they return UNVERIFIED with a
 * note (the field is reserved for a follow-on metric-query registry spec).
 */
export function evaluateGoalCriteria(
  mission: {
    id: string;
    workingBranch?: string | null;
    /**
     * Option A': the mission's task PRs are based on `workingBranch` and the
     * branch itself opens one PR into trunk. Absent or false is the "behave
     * exactly as today" answer, so a caller that never plumbs it keeps the
     * pre-A' semantics rather than getting a new failure mode.
     */
    integrationBranchEnabled?: boolean | null;
  },
  criteria: GoalCriterion[],
  context: {
    tasks: Array<{
      id: string;
      status: string;
      kind?: string | null;
      title?: string | null;
      mode?: string | null;
      // The stored deliverable/bookkeeping discriminator. `isDeliverableTask`
      // and `isMissionPrTask` both read it; it was reaching this function at
      // runtime already and simply was not declared.
      taskClass?: string | null;
      creationSource?: string | null;
      category?: string | null;
    }>;
    workers: Array<{
      taskId?: string | null;
      mergedAt?: string | Date | null;
      prUrl?: string | null;
      branchName?: string | null;
      /**
       * The PR's base ref as GitHub reports it. Null means **unknown**, never
       * trunk — see the Option A' arm below, where an unknown base cannot
       * satisfy "the mission PR landed on trunk".
       */
      prBaseRef?: string | null;
    }>;
    artifacts: Array<{
      key?: string | null;
      type?: string | null;
    }>;
    evaluatedBy: 'auto' | 'manual' | 'mcp';
    now?: string;
  },
): GoalCriteriaState {
  const evaluatedAt = context.now ?? new Date().toISOString();
  const results: GoalCriteriaState['criteria'] = [];

  for (let i = 0; i < criteria.length; i++) {
    const criterion = criteria[i];
    let verdict: CriterionVerdict = 'UNVERIFIED';
    let evidence: string | undefined;
    let workerTaskId: string | undefined;

    switch (criterion.type) {
      case 'all_prs_merged': {
        // Option A': when the mission has opted in, its task PRs are based on
        // the integration branch, so "every PR under this mission has merged"
        // becomes true with **nothing on trunk**. That was this criterion's one
        // inherited false green. The mission's own PR into trunk is now part of
        // the criterion.
        const integrationBase = missionIntegrationBase(mission);

        const prWorkers = context.workers.filter(w => w.prUrl);
        // Which of these PRs is the mission's own? Asked of the owning task, not
        // of the PR title, and answered by the one predicate `mission-pr.ts`
        // also uses to find the row it created.
        const missionPrTaskIds = new Set(context.tasks.filter(isMissionPrTask).map(t => t.id));
        const isMissionPrWorker = (w: { taskId?: string | null }) =>
          !!w.taskId && missionPrTaskIds.has(w.taskId);

        // Branch-deletion note: `requireBranchDeleted` is accepted and ignored.
        // No branch-deletion signal has ever existed in this schema, so the
        // option could only resolve to UNVERIFIED — a knob whose only effect was
        // to make a mission that ticked it permanently uncompletable. Under A'
        // the check people wanted ("the mission branch is done with") is the
        // mission PR into trunk, which is verified below for real.
        const branchNote = criterion.requireBranchDeleted === true
          ? ' (branch deletion is not verified — the option is retired)'
          : '';

        if (prWorkers.length === 0) {
          // UNVERIFIED, not fail: "no PRs exist yet" is an absence of evidence,
          // and a hard fail here made the criterion unsatisfiable for a mission
          // that legitimately produces no PRs (research, coordination). Either
          // way it does not pass, so completion is still gated — but the reason
          // now reads as something an operator can act on.
          verdict = 'UNVERIFIED';
          evidence = `No PRs found for this mission yet${branchNote}`;
          break;
        }

        const unmerged = prWorkers.filter(w => !w.mergedAt);
        if (unmerged.length > 0) {
          // Covers the mission PR too: while it is open this reads `fail`, the
          // same way an open task PR always has, and it clears when the PR
          // merges rather than needing anything to re-evaluate it.
          verdict = 'fail';
          evidence = `${unmerged.length} PR(s) not yet merged${branchNote}`;
          break;
        }

        if (!integrationBase) {
          // Not opted in — exactly the pre-A' answer, including for a mission
          // whose base refs happen to name a `mission/…` branch.
          verdict = 'pass';
          evidence = `All ${prWorkers.length} PR(s) merged${branchNote}`;
          break;
        }

        // Opted in. A merged mission PR counts only if we can see that it went
        // somewhere other than the integration branch: an unknown base ref is
        // unknown, and reading it as trunk is the one direction that invents a
        // green nobody can point at.
        const landedOnTrunk = prWorkers.filter(
          w =>
            isMissionPrWorker(w) &&
            !!w.prBaseRef?.trim() &&
            !isMissionIntegrationBase({ baseRef: w.prBaseRef, mission }),
        );

        if (landedOnTrunk.length === 0) {
          // UNVERIFIED rather than fail, for two reasons. It matches the "no PRs
          // yet" arm — absence of evidence is not a contradiction, and this state
          // is transient by construction, since the mission PR opens as soon as
          // the deliverable work lands. And a `fail` here would be actively
          // harmful: the caller suppresses command and prose grading once any
          // criterion fails, so the window between the last task PR merging and
          // the mission PR opening would silently stop every other criterion
          // being graded.
          verdict = 'UNVERIFIED';
          const anyMissionPr = prWorkers.some(isMissionPrWorker);
          evidence = anyMissionPr
            ? `All ${prWorkers.length} PR(s) merged, but the mission PR's base ref does not show it `
              + `landing outside \`${integrationBase}\``
            : `All ${prWorkers.length} PR(s) merged into \`${integrationBase}\`, but the mission has `
              + `no PR into trunk yet — nothing has reached the default branch`;
          evidence += branchNote;
          break;
        }

        verdict = 'pass';
        const taskPrCount = prWorkers.filter(w => !isMissionPrWorker(w)).length;
        evidence = `All ${taskPrCount} task PR(s) merged into \`${integrationBase}\`, and the mission PR `
          + `merged into \`${landedOnTrunk[0].prBaseRef}\`${branchNote}`;
        break;
      }

      case 'command': {
        // A command's verdict comes from running it, which this pure function
        // cannot do. NOT_EVALUATED (never checked) rather than UNVERIFIED
        // (checked, ambiguous) — the DB layer dispatches a verification task and
        // moves this criterion to PENDING, then to the command's own exit code.
        // It is never handed to the LLM: a model cannot know if `bun test` exits 0.
        verdict = 'NOT_EVALUATED';
        evidence = `Awaiting verification run: ${criterion.command}`;
        break;
      }

      case 'no_open_tasks': {
        const deliverable = context.tasks.filter(isDeliverableTask);
        const open = deliverable.filter(t =>
          !['completed', 'cancelled', 'failed'].includes(t.status)
        );
        verdict = open.length === 0 ? 'pass' : 'fail';
        evidence = open.length === 0
          ? `All ${deliverable.length} deliverable task(s) are closed`
          : `${open.length} task(s) still open: ${open.map(t => t.status).join(', ')}`;
        break;
      }

      case 'artifact_exists': {
        const matches = context.artifacts.filter(a => {
          if (criterion.key && a.key !== criterion.key) return false;
          if (criterion.artifactType && a.type !== criterion.artifactType) return false;
          return true;
        });
        verdict = matches.length > 0 ? 'pass' : 'fail';
        const filterDesc = [
          criterion.key ? `key="${criterion.key}"` : null,
          criterion.artifactType ? `type="${criterion.artifactType}"` : null,
        ].filter(Boolean).join(', ');
        evidence = matches.length > 0
          ? `Found ${matches.length} matching artifact(s) (${filterDesc || 'any'})`
          : `No artifact matching (${filterDesc || 'any'}) found`;
        break;
      }

      case 'metric': {
        // Metric query registry not yet implemented — always UNVERIFIED.
        verdict = 'UNVERIFIED';
        evidence = 'metric query not implemented — deferred to follow-on spec';
        break;
      }

      case 'description': {
        // Free-form criteria are evaluated by LLM in the evaluate route.
        // The pure evaluator marks NOT_EVALUATED so the route can distinguish
        // "never checked" from UNVERIFIED ("checked, ambiguous evidence").
        verdict = 'NOT_EVALUATED';
        evidence = 'Awaiting LLM evaluation';
        break;
      }

      default: {
        // Unknown type — stored by a client that predates this version.
        // Leave UNVERIFIED so the route's LLM evaluator can attempt a verdict.
        verdict = 'UNVERIFIED';
        evidence = `Unknown criterion type: ${(criterion as any).type}`;
        break;
      }
    }

    results.push({
      index: i,
      type: criterion.type,
      ...(criterion.label ? { label: criterion.label } : {}),
      verdict,
      ...(evidence ? { evidence } : {}),
      ...(workerTaskId ? { workerTaskId } : {}),
      fingerprint: criterionFingerprint(criterion),
    });
  }

  // One folding rule, defined once in recalculateOverall: absence of a verdict
  // is not a pass.
  return {
    evaluatedAt,
    evaluatedBy: context.evaluatedBy,
    overall: recalculateOverall(results),
    criteria: results,
  };
}

/**
 * Evaluate an initiative's KPIs.
 *
 * Accepts an optional MetricResolver; callers inject the DB-backed default resolver
 * (buildDefaultResolver) for production, or a mock for unit tests. Without a resolver
 * every KPI returns UNVERIFIED. Non-blocking KPIs are evaluated and stored but do not
 * affect the overall verdict.
 */
export async function evaluateInitiativeKPIs(
  initiativeId: string,
  kpis: InitiativeKPI[],
  opts: {
    evaluatedBy: 'auto' | 'manual' | 'mcp';
    now?: string;
    resolver?: import('./initiative-metric-registry').MetricResolver;
  },
): Promise<InitiativeKPIState> {
  const evaluatedAt = opts.now ?? new Date().toISOString();
  const results: InitiativeKPIState['kpis'] = [];

  for (let i = 0; i < kpis.length; i++) {
    const kpi = kpis[i];

    if (!opts.resolver) {
      results.push({
        index: i,
        name: kpi.name,
        verdict: 'UNVERIFIED',
        evidence: 'no resolver provided — metric queries require a database connection',
      });
      continue;
    }

    const result = await opts.resolver(kpi.metric, initiativeId);

    if ('unavailable' in result) {
      results.push({
        index: i,
        name: kpi.name,
        verdict: 'UNVERIFIED',
        evidence: result.unavailable,
      });
    } else {
      const passes = applyOperator(result.value, kpi.operator, kpi.threshold);
      results.push({
        index: i,
        name: kpi.name,
        verdict: passes ? 'pass' : 'fail',
        observedValue: result.value,
      });
    }
  }

  // Overall: all blocking KPIs must pass. Non-blocking KPIs are informational.
  const blockingResults = results.filter((_, i) => kpis[i].blocking !== false);
  const overall: CriterionVerdict =
    blockingResults.length === 0 ? 'pass'
    : blockingResults.every(r => r.verdict === 'pass') ? 'pass'
    : blockingResults.some(r => r.verdict === 'fail') ? 'fail'
    : 'UNVERIFIED';

  return { evaluatedAt, evaluatedBy: opts.evaluatedBy, overall, kpis: results };
}

function applyOperator(
  value: number,
  operator: InitiativeKPI['operator'],
  threshold: number,
): boolean {
  switch (operator) {
    case 'gt':  return value > threshold;
    case 'gte': return value >= threshold;
    case 'lt':  return value < threshold;
    case 'lte': return value <= threshold;
    case 'eq':  return value === threshold;
    case 'neq': return value !== threshold;
  }
}

// ─── Criteria/KPI gate presentation ──────────────────────────────────────────

/**
 * The four states a completion gate (mission goal criteria or initiative
 * KPIs) can present as. Deliberately NOT `Health`'s `BLOCKED` vocabulary —
 * that word is reserved for actual work-stopping states (an unmet
 * dependency, a human gate). An unverified or even a failing criterion does
 * not stop work; it only withholds a completion verdict, so it must never
 * render as "BLOCKED".
 */
export type CriteriaGateState = 'clear' | 'unverified' | 'failing' | 'refused';

export interface CriteriaGatePresentation {
  state: CriteriaGateState;
  label: string;
  tone: 'success' | 'neutral' | 'warning' | 'error';
  /** Names the specific criterion/KPI and its evidence, when known. */
  detail: string | null;
}

/** Token-only Tailwind classes per tone — no off-palette hex, no per-surface reinvention. */
export const CRITERIA_GATE_TONE_CLASS: Record<CriteriaGatePresentation['tone'], string> = {
  success: 'border-status-success/40 text-status-success',
  neutral: 'border-border-default text-text-muted',
  warning: 'border-status-warning/40 text-status-warning',
  error: 'border-status-error/40 text-status-error',
};

/**
 * Single source of truth for how a criteria/KPI gate renders — shared by the
 * mission card pill, the mission detail banner, and the initiative KPI chip.
 * Before this, each surface derived its own label/color from the same
 * `overall` verdict, and one of them used the word "BLOCKED" for a criterion
 * that had simply never run yet on a mission minutes old.
 *
 * `completionAttempted` is what separates "young mission, nothing has
 * evaluated" (quiet — `unverified`) from "the platform tried to close this
 * and the gate held it open" (prominent — `refused`): the same non-pass
 * verdict is newsworthy only once completion was actually on the table.
 */
export function deriveCriteriaGatePresentation(opts: {
  criteriaCount: number;
  /** Aggregate verdict, or null when never evaluated. */
  overall: CriterionVerdict | null;
  /** Per-criterion/per-KPI detail, when available, for naming the specific failure. */
  items?: Array<{ verdict: CriterionVerdict; label?: string; name?: string; type?: string; evidence?: string }>;
  /** True once the work is otherwise done and completion was actually proposed/attempted. */
  completionAttempted?: boolean;
}): CriteriaGatePresentation | null {
  if (opts.criteriaCount <= 0) return null;
  if (opts.overall === 'pass') {
    return { state: 'clear', label: 'Verified', tone: 'success', detail: null };
  }

  const items = opts.items ?? [];
  const nonPass = items.filter(c => c.verdict !== 'pass');
  const failing = nonPass.filter(c => c.verdict === 'fail');
  const isFailing = opts.overall === 'fail' || failing.length > 0;
  const named = failing.length > 0 ? failing : nonPass;

  const nameOf = (c: { label?: string; name?: string; type?: string }) => c.label ?? c.name ?? c.type ?? 'criterion';
  const describe = (list: typeof named): string | null => {
    if (list.length === 0) return null;
    if (list.length === 1) {
      const c = list[0];
      return c.evidence ? `${nameOf(c)}: ${c.evidence}` : nameOf(c);
    }
    return `${list.length} criteria`;
  };

  if (isFailing) {
    return opts.completionAttempted
      ? { state: 'refused', label: 'Completion refused', tone: 'error', detail: describe(named) }
      : { state: 'failing', label: 'Criteria failing', tone: 'warning', detail: describe(named) };
  }

  if (opts.completionAttempted) {
    return {
      state: 'refused',
      label: 'Completion refused',
      tone: 'error',
      detail: nonPass.length > 0 ? `${nonPass.length} criteria unverified` : `${opts.criteriaCount} criteria unverified`,
    };
  }

  return { state: 'unverified', label: 'Not yet verified', tone: 'neutral', detail: null };
}

// ─── Mission segment states ───────────────────────────────────────────────────

/** Segment states for the mission progress bar. Vocabulary shared with task-chain strip. */
export type MissionSegmentState = 'solid' | 'half' | 'ghost' | 'empty' | 'notch';

export interface MissionSegment {
  taskId: string;
  state: MissionSegmentState;
}

/** Worker statuses that indicate an in-flight (live) worker. Mirrors task-presentation.ts. */
export const MISSION_LIVE_WORKER_STATUSES = ['idle', 'running', 'starting', 'waiting_input'] as const;
const LIVE_SET = new Set(MISSION_LIVE_WORKER_STATUSES);

// ─── TaskClass selectors ──────────────────────────────────────────────────────

/** True when t is a genuine deliverable (counts in mission progress and TASKS tally). */
export const isWork = (t: { taskClass?: string | null }) => t.taskClass === 'work';

/** True when t is a coordination/housekeeping row (excluded from progress denominator). */
export const isBookkeeping = (t: { taskClass?: string | null }) => t.taskClass === 'bookkeeping';

/** True when t is a retry or review pass that collapses under its parent. */
export const isAttempt = (t: { taskClass?: string | null }) => t.taskClass === 'attempt';

/**
 * Build a map of parentTaskId → attempt tasks for attempt-nesting display.
 * Replaces the raw parentTaskId/childrenMap approach in computeMissionProgress.
 */
export function attachAttempts<T extends { id?: string; taskClass?: string | null; parentTaskId?: string | null }>(
  tasks: T[],
): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const t of tasks) {
    if (t.taskClass === 'attempt' && t.parentTaskId) {
      const bucket = map.get(t.parentTaskId) ?? [];
      bucket.push(t);
      map.set(t.parentTaskId, bucket);
    }
  }
  return map;
}

// ─── Deliverable predicate ────────────────────────────────────────────────────

/**
 * Returns true if the task counts as a deliverable for mission progress.
 *
 * Primary path: reads taskClass directly. Falls back to title/mode/kind
 * heuristics for rows that pre-date the backfill (taskClass IS NULL), so
 * the function degrades gracefully during the migration window.
 */
export function isDeliverableTask(task: {
  taskClass?: string | null;
  kind?: string | null;
  title?: string | null;
  mode?: string | null;
  creationSource?: string | null;
  category?: string | null;
}): boolean {
  // Fast path: use the stored discriminator.
  if (task.taskClass != null) return task.taskClass === 'work';
  // Fallback for pre-migration rows (taskClass IS NULL).
  if (task.category === 'review') return false;
  if (task.kind === 'coordination') return false;
  if (task.mode === 'planning') return false;
  if (task.title?.startsWith('Aggregate results:')) return false;
  if (task.title?.startsWith('Evaluate mission completion:')) return false;
  if (task.title?.startsWith('Mission:')) return false;
  if (task.title?.startsWith('Close mission')) return false;
  return true;
}

function deriveMissionSegmentState(task: {
  id?: string;
  status: string;
  workers?: Array<{ status: string; prUrl?: string | null; mergedAt?: string | Date | null; prLifecycleStatus?: string | null }>;
}): MissionSegmentState {
  const workers = task.workers ?? [];

  if (workers.some(w => LIVE_SET.has(w.status as any))) return 'ghost';

  if (task.status === 'completed') {
    const prWorker = workers.find(w => w.prUrl);
    if (!prWorker || prWorker.mergedAt) return 'solid';
    // A PR closed without merging is not "in progress toward merge" — the
    // deliverable never shipped. Fold it in with 'notch' (didn't land cleanly)
    // rather than 'half' (actively awaiting merge), so it doesn't inflate the
    // awaiting-merge count with dead PRs nobody is about to merge.
    if (prWorker.prLifecycleStatus === 'closed') return 'notch';
    return 'half';
  }

  if (task.status === 'failed') return 'notch';

  return 'empty';
}

/**
 * Compute mission progress from a list of tasks.
 *
 * Rules:
 * - Only deliverable tasks (as per isDeliverableTask) count.
 * - Cancelled tasks are excluded from the denominator — they're treated as
 *   "never happened" so duplicate-killing doesn't block 100% completion.
 * - Failed tasks DO count against progress; they represent unfinished intended work.
 * - Attempt tasks (deriveTaskType returns non-null) are collapsed into their parent:
 *   the parent's effective status is the best outcome across all attempts.
 *   Attempts do not count as separate deliverables.
 * - Spawned builder tasks (parentTaskId IS NOT NULL AND mode='execution') are NOT
 *   attempts — they are distinct units of work created by approve_plan and count
 *   as separate deliverables even though they carry a parentTaskId.
 *
 * When tasks include an `id` and optional `workers`, the return value also
 * contains per-task `segments` for the projected progress bar.
 *
 * `completedTasks` counts only `solid` segments (status='completed' AND
 * (no PR or the PR merged)) — a completed task whose PR is still open, or
 * closed without merging, is never counted as done (docs/specs/
 * mission-task-lifecycle.md, the awaiting-merge gate). `awaitingMerge` is
 * the `half`-segment count: status='completed', PR open/unmerged, not closed.
 */
export function computeMissionProgress(tasks: Array<{
  id?: string;
  status: string;
  taskClass?: string | null;
  kind?: string | null;
  title?: string | null;
  mode?: string | null;
  creationSource?: string | null;
  category?: string | null;
  parentTaskId?: string | null;
  workers?: Array<{ status: string; prUrl?: string | null; mergedAt?: string | Date | null; prLifecycleStatus?: string | null }>;
}>): { totalTasks: number; completedTasks: number; awaitingMerge: number; progress: number; segments: MissionSegment[] } {
  // Collapse attempt tasks under their parents.
  // Primary: use taskClass='attempt' (set by backfill on all existing rows).
  // Fallback: use deriveTaskType for any pre-migration row (taskClass IS NULL).
  const childrenMap = new Map<string, typeof tasks>();
  const rootTasks = tasks.filter(t => {
    const isAttemptRow = t.taskClass != null
      ? t.taskClass === 'attempt'
      : (t.parentTaskId != null && deriveTaskType(t) !== null);
    if (isAttemptRow && t.parentTaskId) {
      const bucket = childrenMap.get(t.parentTaskId) ?? [];
      bucket.push(t);
      childrenMap.set(t.parentTaskId, bucket);
      return false;
    }
    return true;
  });

  // Status preference: completed > pending/assigned > failed > cancelled
  const STATUS_RANK: Record<string, number> = {
    completed: 0,
    pending: 1,
    assigned: 2,
    failed: 3,
    cancelled: 4,
  };

  const resolvedTasks = rootTasks.map(t => {
    const children = childrenMap.get(t.id ?? '') ?? [];
    if (children.length === 0) return t;
    const allStatuses = [t.status, ...children.map(c => c.status)];
    const bestStatus = allStatuses.reduce(
      (best, s) => ((STATUS_RANK[s] ?? 5) < (STATUS_RANK[best] ?? 5) ? s : best),
      allStatuses[0],
    );
    // Merge workers from all attempts so segment rendering sees the full picture
    const mergedWorkers = [
      ...(t.workers ?? []),
      ...children.flatMap(c => c.workers ?? []),
    ];
    return { ...t, status: bestStatus, workers: mergedWorkers };
  });

  const countable = resolvedTasks
    .filter(t => {
      // Planning tasks (orchestrator) normally excluded, but count when they
      // produced a PR — in orchestrator-only missions the plan IS the deliverable.
      if (t.mode === 'planning' && t.workers?.some(w => w.prUrl)) return true;
      return isDeliverableTask(t);
    })
    .filter(t => t.status !== 'cancelled');
  const total = countable.length;
  const segments: MissionSegment[] = countable.map(t => ({
    taskId: t.id ?? '',
    state: deriveMissionSegmentState(t),
  }));
  const completed = segments.filter(s => s.state === 'solid').length;
  const awaitingMerge = segments.filter(s => s.state === 'half').length;
  return {
    totalTasks: total,
    completedTasks: completed,
    awaitingMerge,
    progress: total > 0 ? Math.round((completed / total) * 100) : 0,
    segments,
  };
}

/**
 * Derive mission progress as a DerivedMetric<number> (0-100).
 *
 * Returns `{ kind: 'unavailable', reason: 'no_scope' }` when there are no
 * countable tasks so callers must handle the empty case explicitly — never
 * silently 0 or forced 100. Do NOT apply a "completed ⇒ 100" override here;
 * the mission status does not change what the tasks actually are.
 */
export function deriveMissionProgressMetric(
  tasks: Parameters<typeof computeMissionProgress>[0],
): DerivedMetric<number> {
  const { totalTasks, completedTasks } = computeMissionProgress(tasks);
  if (totalTasks === 0) return derivedUnavailable('no_scope');
  return derivedValue(Math.round((completedTasks / totalTasks) * 100));
}

// ─── Initiative rollup ────────────────────────────────────────────────────────

/** Mission status vocabulary — mirrors missions.status in schema.ts. */
export type MissionStatus = 'active' | 'paused' | 'completed' | 'archived' | 'budget_exhausted';

/**
 * The per-child input to an initiative rollup: a mission's own status plus its
 * already-computed task tallies (from computeMissionProgress). The helper does
 * NOT query — callers pass these in.
 */
export interface ChildMissionProgress {
  status: MissionStatus;
  totalTasks: number;
  completedTasks: number;
}

export interface InitiativeProgress {
  /** Non-archived missions count. Archived missions are excluded from the denominator. */
  totalMissions: number;
  /** Missions with status='completed' (excludes archived). */
  completedMissions: number;
  /** Task sum across non-archived missions — for display only, not used in progress %. */
  totalTasks: number;
  /** Completed task sum across non-archived missions — for display only. */
  completedTasks: number;
  /** 0-100. Mission-weighted: completedMissions / totalMissions. Archived missions excluded. */
  progress: number;
  status: 'empty' | 'active' | 'blocked' | 'paused' | 'completed';
}

/**
 * Roll a set of child missions up into an initiative-level summary.
 *
 * - Progress is mission-weighted (completed missions / total missions). Archived
 *   missions are excluded from the denominator entirely — they're treated as if
 *   they never existed for progress purposes. This prevents the percentage from
 *   falling when an active mission is archived.
 * - Task counts (totalTasks, completedTasks) are kept for display as scope
 *   indicators but are NOT blended into the progress percentage.
 * - Status precedence (over non-archived missions): any budget_exhausted →
 *   'blocked'; any active → 'active'; any paused → 'paused'; else 'completed'.
 *   No non-archived missions → 'empty'.
 * - completedMissions counts mission STATUS === 'completed', independent of task
 *   completion (a mission with all tasks done but still active is not complete).
 */
export function computeInitiativeProgress(children: ChildMissionProgress[]): InitiativeProgress {
  if (children.length === 0) {
    return { totalMissions: 0, completedMissions: 0, totalTasks: 0, completedTasks: 0, progress: 0, status: 'empty' };
  }

  // Archived missions are excluded from the denominator entirely.
  const activeMissions = children.filter(c => c.status !== 'archived');
  const totalMissions = activeMissions.length;
  const completedMissions = activeMissions.filter(c => c.status === 'completed').length;

  // Task totals are summed over non-archived missions only (display-only; not used for %).
  const totalTasks = activeMissions.reduce((n, c) => n + c.totalTasks, 0);
  const completedTasks = activeMissions.reduce((n, c) => n + c.completedTasks, 0);

  const status: InitiativeProgress['status'] =
    totalMissions === 0 ? 'empty'
    : activeMissions.some(c => c.status === 'budget_exhausted') ? 'blocked'
    : activeMissions.some(c => c.status === 'active') ? 'active'
    : activeMissions.some(c => c.status === 'paused') ? 'paused'
    : 'completed';

  const progress = totalMissions > 0 ? Math.round((completedMissions / totalMissions) * 100) : 0;

  return { totalMissions, completedMissions, totalTasks, completedTasks, progress, status };
}

/**
 * Flatten child missions' progress bars into one aggregate segment run for an
 * initiative-level SegmentStrip. Segments are concatenated in child order; each
 * segment keeps its own task's `taskId` (globally unique), so the strip has
 * stable keys and no per-surface renderer is introduced — the initiative bar is
 * the same primitive as the mission bar, just longer. Missions with no countable
 * tasks contribute nothing (empty initiative → empty array → SegmentStrip renders
 * null).
 */
export function computeInitiativeSegments(
  children: Array<{ segments?: MissionSegment[] }>,
): MissionSegment[] {
  return children.flatMap((c) => c.segments ?? []);
}

/** Progress milestones (%) an initiative rollup can "cross" for the arc headline. */
export const INITIATIVE_MILESTONES = [25, 50, 75, 90, 100] as const;

/**
 * The highest milestone crossed moving from `prev` progress to `curr` — i.e. the
 * largest threshold `m` with `prev < m <= curr`. Returns null when nothing was
 * crossed (including any non-increase, so a stalled or regressed initiative never
 * produces a headline). Callers seed `prev` from a persisted per-user snapshot;
 * a first-ever view (no snapshot) must NOT call this with prev=0 or every arc
 * would spuriously "cross" on first load — seed the baseline silently instead.
 */
export function crossedMilestone(prev: number, curr: number): number | null {
  if (curr <= prev) return null;
  let hit: number | null = null;
  for (const m of INITIATIVE_MILESTONES) {
    if (prev < m && m <= curr) hit = m; // ascending list → last match is the highest
  }
  return hit;
}

// ─── Mission skyline chart ────────────────────────────────────────────────────

const SKYLINE_SLOT_MS = 15 * 60 * 1000; // 15-minute quantization
const SKYLINE_MAX_LANES = 4;

export type SkylineBlockState = 'merged' | 'awaiting' | 'failed';

export interface SkylineBlock {
  lane: number;
  startSlot: number;
  endSlot: number; // exclusive
  state: SkylineBlockState;
}

export interface MissionSkylineData {
  totalSlots: number;
  blocks: SkylineBlock[];
  peakLanes: number;
  foldedLanes: number;
  activeSpanMin: number;
  agentTimeMin: number;
  parallelFactor: number;
  peakConcurrency: number;
  reviewTailMin: number | null;
}

type WorkerSpan = {
  startedAt: Date | string | null;
  completedAt?: Date | string | null;
  updatedAt?: Date | string | null;
  status: string;
  prUrl: string | null;
  mergedAt: Date | string | null;
};

function workerEndMs(w: WorkerSpan, now: number): number {
  if (w.completedAt) return new Date(w.completedAt as string).getTime();
  if (w.updatedAt) return new Date(w.updatedAt as string).getTime();
  return now;
}

function workerBlockState(w: WorkerSpan): SkylineBlockState {
  if (w.status === 'error') return 'failed';
  if (w.mergedAt) return 'merged';
  if (w.prUrl) return 'awaiting';
  return 'merged';
}

/**
 * Build a quantized time-vs-concurrency skyline from a mission's worker spans.
 * Returns null when no workers have a valid startedAt.
 *
 * One slot = 15 minutes of wall-clock time.
 * Multi-slot tasks render as one joined bar; concurrent tasks stack into lanes.
 * Greedy packing: each worker goes to the lowest lane whose previous occupant ended.
 */
export function computeMissionSkyline(
  tasks: Array<{ workers?: WorkerSpan[] }>,
  opts?: { missionCompletedAt?: Date | string | null; now?: number },
): MissionSkylineData | null {
  const now = opts?.now ?? Date.now();

  // Collect valid worker time spans
  const spans: Array<{ startMs: number; endMs: number; state: SkylineBlockState }> = [];
  for (const task of tasks) {
    for (const w of task.workers ?? []) {
      if (!w.startedAt) continue;
      const startMs = new Date(w.startedAt as string).getTime();
      const endMs = workerEndMs(w, now);
      if (endMs <= startMs) continue;
      spans.push({ startMs, endMs, state: workerBlockState(w) });
    }
  }
  if (spans.length === 0) return null;

  const missionStartMs = Math.min(...spans.map((s) => s.startMs));
  const lastEndMs = Math.max(...spans.map((s) => s.endMs));
  const activeSpanMin = (lastEndMs - missionStartMs) / 60_000;
  const agentTimeMin = spans.reduce((acc, s) => acc + (s.endMs - s.startMs) / 60_000, 0);
  const totalSlots = Math.max(1, Math.ceil((lastEndMs - missionStartMs) / SKYLINE_SLOT_MS));

  // ── Lane assignment from raw ms spans ─────────────────────────────────────
  // Using raw milliseconds (not quantized slots) avoids the sub-slot artifact
  // where multiple sequential workers all collapse to [0,1) and appear concurrent.
  // Sort by startMs then endMs for stable greedy packing.
  const sortedByMs = spans
    .map((s, i) => ({ ...s, originalIdx: i }))
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  const laneEndMs: number[] = [];
  const spanLanes = new Array<number>(spans.length);
  for (const span of sortedByMs) {
    // A lane is free when its last occupant ended at or before this span's start.
    // end <= start means abutting sequential workers go to the same lane (not concurrent).
    let lane = laneEndMs.findIndex((end) => end <= span.startMs);
    if (lane === -1) {
      lane = laneEndMs.length;
      laneEndMs.push(0);
    }
    laneEndMs[lane] = span.endMs;
    spanLanes[span.originalIdx] = lane;
  }

  const peakLanes = laneEndMs.length;
  const foldedLanes = Math.max(0, peakLanes - SKYLINE_MAX_LANES);

  // ── Peak concurrency via sweep-line over raw ms events ────────────────────
  // Encode end=ms*2, start=ms*2+1 so end events sort before start events at
  // equal timestamps — abutting sequential workers (A ends at T, B starts at T)
  // are NOT counted as concurrent.
  const msEvents: Array<[number, number]> = [];
  for (const s of spans) {
    msEvents.push([s.endMs * 2, -1]);
    msEvents.push([s.startMs * 2 + 1, +1]);
  }
  msEvents.sort((a, b) => a[0] - b[0]);
  let concurrent = 0;
  let peakConcurrency = 0;
  for (const [, delta] of msEvents) {
    concurrent += delta;
    if (concurrent > peakConcurrency) peakConcurrency = concurrent;
  }

  const parallelFactor = activeSpanMin > 0 ? agentTimeMin / activeSpanMin : 1;

  // Invariant: real concurrency implies parallel factor above 1.0.
  // A violation means the ms-based and duration-based math have diverged.
  if (process.env.NODE_ENV !== 'production' && peakConcurrency > 1 && parallelFactor <= 1) {
    console.error(
      '[mission-invariant] peakConcurrency=%d but parallelFactor=%f — concurrency and duration math have diverged',
      peakConcurrency,
      parallelFactor,
    );
  }

  // ── Slot quantization (rendering only) ───────────────────────────────────
  // Slots drive block geometry; the 1-slot minimum keeps short blocks visible.
  // Lane comes from the ms-derived assignment above.
  const slottedSpans = spans.map((s, i) => {
    const startSlot = Math.floor((s.startMs - missionStartMs) / SKYLINE_SLOT_MS);
    const rawEnd = Math.ceil((s.endMs - missionStartMs) / SKYLINE_SLOT_MS);
    const endSlot = Math.max(startSlot + 1, rawEnd);
    return { startSlot, endSlot, state: s.state, lane: spanLanes[i] };
  });

  // ── Build blocks, merging overlapping rects within each lane ─────────────
  // Sequential sub-slot workers share a lane and quantize to the same slot
  // interval (e.g. all map to [0,1)). Merge strictly-overlapping slot ranges
  // within each lane so they don't produce stacked render rects.
  const spansByLane = new Map<number, typeof slottedSpans>();
  for (const s of slottedSpans) {
    if (!spansByLane.has(s.lane)) spansByLane.set(s.lane, []);
    spansByLane.get(s.lane)!.push(s);
  }

  const blocks: SkylineBlock[] = [];
  for (const [lane, laneSpans] of spansByLane) {
    laneSpans.sort((a, b) => a.startSlot - b.startSlot || a.endSlot - b.endSlot);
    let cur = { lane, startSlot: laneSpans[0].startSlot, endSlot: laneSpans[0].endSlot, state: laneSpans[0].state };
    for (let i = 1; i < laneSpans.length; i++) {
      const next = laneSpans[i];
      if (next.startSlot < cur.endSlot) {
        // Overlapping slots — merge, taking the last block's state as the most recent outcome
        cur = { lane, startSlot: cur.startSlot, endSlot: Math.max(cur.endSlot, next.endSlot), state: next.state };
      } else {
        blocks.push(cur);
        cur = { lane, startSlot: next.startSlot, endSlot: next.endSlot, state: next.state };
      }
    }
    blocks.push(cur);
  }

  // Review tail: time from last worker end to mission close (or now)
  const missionEndMs = opts?.missionCompletedAt
    ? new Date(opts.missionCompletedAt as string).getTime()
    : null;
  const tailMs = missionEndMs !== null ? missionEndMs - lastEndMs : null;
  const reviewTailMin = tailMs !== null && tailMs > 5 * 60_000 ? tailMs / 60_000 : null;

  return {
    totalSlots,
    blocks,
    peakLanes,
    foldedLanes,
    activeSpanMin,
    agentTimeMin,
    parallelFactor,
    peakConcurrency,
    reviewTailMin,
  };
}
