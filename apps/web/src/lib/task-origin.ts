/**
 * Task provenance — who created this task, by what mechanism, and because of what.
 *
 * Every fact here is already stored on the `tasks` row (`creationSource`,
 * `createdByWorkerId`, `createdByAccountId`, `scheduleId`, `parentTaskId`,
 * `taskClass`, the three `*RetryPrNumber` pairs and `context`) and, until now,
 * rendered nowhere — the only published signal of lineage was a bracketed title
 * prefix (docs/design/mission-delivery-arc.md, Problem §4 / finding U6).
 *
 * Precedence, per that design:
 *   - `creationSource` names the **mechanism**;
 *   - `createdByWorkerId` / `createdByAccountId` names the **actor**;
 *   - `scheduleId`, `parentTaskId`, `ciRetryPrNumber` / `reviewerRetryPrNumber` /
 *     `conflictRetryPrNumber` supply the **because-clause** and its link.
 *
 * Two hard rules:
 *   1. **No title parsing.** `taskClass` is the single classifier; `deriveTaskType`
 *      is retired to a display-only title cleaner. `packages/core/__tests__/
 *      task-class-invariants.test.ts` enforces this over all of `apps/web/src/lib`.
 *   2. **Structured output only.** This module returns label + parts + links; the
 *      page owns every span, chip and separator.
 *
 * Ship state (`shipped`) is the §10.3 **badge**, never a fifth task-rail segment
 * (docs/specs/surface-ia-home-missions-initiatives.md §10.3, AC-48/AC-50). The
 * caller resolves it via `resolveShippedRelease` — the one shared
 * `release_tasks` → `releases.state = 'healthy'` join.
 */
import { isAttempt } from '@buildd/core/mission-helpers';

export type TaskOriginMechanism =
  | 'ci_retry'
  | 'reviewer_retry'
  | 'conflict_retry'
  | 'attempt'
  | 'orchestrator'
  | 'schedule'
  | 'human'
  | 'agent'
  | 'github'
  | 'webhook'
  | 'api'
  | 'mcp'
  | 'unknown';

export type TaskOriginLinkKey =
  | 'worker'
  | 'mission'
  | 'schedule'
  | 'parentTask'
  | 'pr'
  | 'run';

export interface TaskOriginLink {
  key: TaskOriginLinkKey;
  label: string;
  href: string;
}

export interface TaskOrigin {
  /** Machine-readable mechanism — for styling/telemetry, never rendered raw. */
  mechanism: TaskOriginMechanism;
  /** Who acted: "Organizer agent", "You", "Schedule", "GitHub". Null when unknown. */
  actor: string | null;
  /** Dot-separated clauses rendered after the actor, in order. */
  parts: string[];
  /** The because-clause's links, in render order. */
  links: TaskOriginLink[];
  /** `Shipped in <label>` row (§10.3 badge). Null unless a healthy release owns it. */
  shipped: { label: string; href: string } | null;
  /** True when no origin clause could be derived — the caller renders no row. */
  isEmpty: boolean;
}

/** The provenance columns this function reads. Extra task fields are ignored. */
export interface TaskOriginRow {
  creationSource?: string | null;
  createdByWorkerId?: string | null;
  createdByAccountId?: string | null;
  scheduleId?: string | null;
  parentTaskId?: string | null;
  missionId?: string | null;
  workspaceId?: string | null;
  ciRetryPrNumber?: number | null;
  reviewerRetryPrNumber?: number | null;
  conflictRetryPrNumber?: number | null;
  taskClass?: string | null;
  context?: Record<string, unknown> | null;
}

/** Display names the caller resolved from its own joins. All optional. */
export interface TaskOriginContext {
  /** Display name of the creating account or worker. */
  actorName?: string | null;
  /** True when the creating account is the viewer's → renders as "You". */
  isSelf?: boolean;
  /** Role slug of the creating agent, e.g. `organizer` → "Organizer agent". */
  creatorRoleSlug?: string | null;
  /** Task page of the creating worker (workers have no page of their own). */
  creatorWorkerTaskId?: string | null;
  scheduleName?: string | null;
  missionTitle?: string | null;
  parentTaskTitle?: string | null;
  /** `owner/name` — builds a PR link when the row carries only a number. */
  repoFullName?: string | null;
  /** Healthy release attributed via `release_tasks` (U7). */
  shippedRelease?: { releaseId: string; label?: string | null } | null;
}

/** Mechanism clause per `creationSource`. */
const MECHANISM_LABEL: Record<string, string> = {
  dashboard: 'dashboard',
  local_ui: 'local UI',
  api: 'API',
  mcp: 'MCP',
  webhook: 'webhook',
  github: 'webhook',
  schedule: 'schedule',
  orchestrator: 'mission heartbeat',
  conflict: 'conflict resolution',
};

/** Human phrasing for `context.failureContext.errorType`. */
const FAILURE_REASON: Record<string, string> = {
  ci_failure: 'check_suite failed',
  reviewer_request_changes: 'reviewer requested changes',
  merge_conflict: 'merge conflict',
};

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/** `#2 of 3`, `#2`, or '' — whatever the counters actually support. */
function iterationClause(iteration: number | null, max: number | null): string {
  if (iteration == null) return '';
  return max == null ? ` #${iteration}` : ` #${iteration} of ${max}`;
}

function errorReason(context: Record<string, unknown>, fallbackKey: string): string {
  const failure = context.failureContext;
  const errorType = failure && typeof failure === 'object'
    ? str((failure as Record<string, unknown>).errorType)
    : null;
  return (errorType && FAILURE_REASON[errorType]) || FAILURE_REASON[fallbackKey];
}

function titleCase(slug: string): string {
  const word = slug.replace(/[-_]+/g, ' ').trim();
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** The three retry kinds, most specific first. */
function retryKind(task: TaskOriginRow): {
  mechanism: 'ci_retry' | 'reviewer_retry' | 'conflict_retry';
  label: string;
  prNumber: number;
  iterationKey: string;
  maxKey: string;
  reasonKey: string;
} | null {
  if (task.ciRetryPrNumber != null) {
    return {
      mechanism: 'ci_retry',
      label: 'CI retry',
      prNumber: task.ciRetryPrNumber,
      iterationKey: 'iteration',
      maxKey: 'maxIterations',
      reasonKey: 'ci_failure',
    };
  }
  if (task.reviewerRetryPrNumber != null) {
    return {
      mechanism: 'reviewer_retry',
      label: 'Reviewer retry',
      prNumber: task.reviewerRetryPrNumber,
      iterationKey: 'iteration',
      maxKey: 'maxIterations',
      reasonKey: 'reviewer_request_changes',
    };
  }
  if (task.conflictRetryPrNumber != null) {
    return {
      mechanism: 'conflict_retry',
      label: 'Conflict retry',
      prNumber: task.conflictRetryPrNumber,
      iterationKey: 'conflictIteration',
      maxKey: 'maxConflictIterations',
      reasonKey: 'merge_conflict',
    };
  }
  return null;
}

/**
 * Derive the Origin row for a task from stored columns only.
 *
 * Pure: no I/O, no clock, no title reads. `ctx` carries display names the caller
 * already loaded (creator account/worker, schedule, mission, parent, release).
 */
export function deriveTaskOrigin(task: TaskOriginRow, ctx: TaskOriginContext = {}): TaskOrigin {
  const context = task.context ?? {};
  const source = str(task.creationSource);
  const parts: string[] = [];
  const links: TaskOriginLink[] = [];

  // ── Actor: worker beats account; both are optional. ───────────────────────
  let actor: string | null = null;
  if (task.createdByWorkerId) {
    const role = str(ctx.creatorRoleSlug);
    actor = role ? `${titleCase(role)} agent` : (str(ctx.actorName) ?? 'Agent');
  } else if (task.createdByAccountId) {
    actor = ctx.isSelf ? 'You' : (str(ctx.actorName) ?? 'A teammate');
  }

  // ── Mechanism + because-clause. ───────────────────────────────────────────
  const retry = retryKind(task);
  let mechanism: TaskOriginMechanism;

  if (retry) {
    mechanism = retry.mechanism;
    const iteration = iterationClause(num(context[retry.iterationKey]), num(context[retry.maxKey]));
    parts.push(`${retry.label}${iteration}`);
    parts.push(`PR #${retry.prNumber} ${errorReason(context, retry.reasonKey)}`);
  } else if (source === 'orchestrator') {
    mechanism = 'orchestrator';
    const cycle = num(context.cycleNumber);
    parts.push(cycle == null ? MECHANISM_LABEL.orchestrator : `${MECHANISM_LABEL.orchestrator} cycle ${cycle}`);
  } else if (source === 'schedule') {
    mechanism = 'schedule';
    // The schedule is the actor when no human or agent is recorded.
    actor = actor ?? 'Schedule';
    const name = str(ctx.scheduleName) ?? str(context.scheduleName);
    if (name) parts.push(name);
  } else if (source === 'dashboard' || source === 'local_ui') {
    mechanism = 'human';
    parts.push(MECHANISM_LABEL[source]);
  } else if (source === 'github') {
    mechanism = 'github';
    actor = actor ?? 'GitHub';
    parts.push(MECHANISM_LABEL.github);
  } else if (source && MECHANISM_LABEL[source]) {
    // `creationSource` names the mechanism even when an actor is also known —
    // "who" and "how" are separate axes (design doc, Frontend § Origin row).
    mechanism = source === 'webhook' ? 'webhook'
      : source === 'mcp' ? 'mcp'
      : source === 'conflict' ? 'conflict_retry'
      : 'api';
    parts.push(MECHANISM_LABEL[source]);
  } else if (isAttempt(task)) {
    // An attempt whose retry columns were never populated: taskClass still says
    // what it is, so say that rather than reading the title.
    mechanism = 'attempt';
    parts.push('retry attempt');
  } else if (actor) {
    mechanism = task.createdByWorkerId ? 'agent' : 'human';
  } else {
    mechanism = 'unknown';
  }

  const isEmpty = actor === null && parts.length === 0;

  // ── Links, in render order: worker → mission → schedule → parent → PR → run.
  if (!isEmpty) {
    if (task.createdByWorkerId && ctx.creatorWorkerTaskId) {
      links.push({ key: 'worker', label: 'Agent run', href: `/app/tasks/${ctx.creatorWorkerTaskId}` });
    }
    if (task.missionId) {
      links.push({
        key: 'mission',
        label: str(ctx.missionTitle) ?? 'Mission',
        href: `/app/missions/${task.missionId}`,
      });
    }
    if (task.scheduleId) {
      const href = task.workspaceId ? `/app/workspaces/${task.workspaceId}/schedules` : '/app/schedules';
      links.push({ key: 'schedule', label: str(ctx.scheduleName) ?? str(context.scheduleName) ?? 'Schedule', href });
    }
    if (task.parentTaskId) {
      links.push({
        key: 'parentTask',
        label: str(ctx.parentTaskTitle) ?? 'Parent task',
        href: `/app/tasks/${task.parentTaskId}`,
      });
    }

    const prNumber = retry?.prNumber ?? num(context.prNumber);
    const prUrl = str(context.prUrl)
      ?? (prNumber != null && str(ctx.repoFullName)
        ? `https://github.com/${ctx.repoFullName}/pull/${prNumber}`
        : null);
    if (prNumber != null && prUrl) {
      links.push({ key: 'pr', label: `PR #${prNumber}`, href: prUrl });
    }

    const runUrl = str(context.ciRunUrl);
    if (runUrl) links.push({ key: 'run', label: 'CI run', href: runUrl });
  }

  const shipped = ctx.shippedRelease
    ? {
        label: str(ctx.shippedRelease.label) ?? 'a release',
        href: `/app/releases/${ctx.shippedRelease.releaseId}`,
      }
    : null;

  return { mechanism, actor, parts, links, shipped, isEmpty };
}
