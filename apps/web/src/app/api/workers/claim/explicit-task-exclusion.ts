import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { tasks, workers } from '@buildd/core/db/schema';
import type { ClaimTaskExclusion, ClaimTaskExclusionCode } from '@buildd/shared';
import { shouldSerializeByManifest } from '@buildd/core/path-overlap';
import { dependencySatisfied } from './deps-gate';
import { GATE_SLUGS } from '@buildd/core/gate-slugs';
import type { RecordGateEventInput } from '@buildd/core/gate-events';

/**
 * Why an explicitly requested task (claim with `taskId`) was not claimed.
 *
 * The claim query folds every gate into one WHERE, so a task a gate excludes is
 * simply not returned and the route answered `no_pending_tasks` — the same
 * reason as an empty queue. For a caller who named the task (an interactive
 * MCP session, the dashboard Start button's dispatch) that reads as "done or
 * gone". This probe re-evaluates the route's OWN gate predicates as boolean
 * columns for that one row, so the answer cannot drift from what the claim
 * query enforced. It only runs on the explicit-taskId empty path.
 *
 * Scoped to the workspaces the caller can claim from: a task elsewhere reads as
 * `not_found`, never as a description of someone else's task.
 *
 * Every gate column is `COALESCE((gate), false)`. The claim WHERE excludes a
 * row whose predicate is NULL exactly as it excludes FALSE, and several gates
 * (held mission, deps) used to evaluate to NULL when they blocked, because a
 * bypass arm read a missing context key. The probe then saw NULL, recorded the
 * gate as "not evaluated", and answered "Excluded by a claim filter this
 * diagnosis does not cover" for a task that was plainly waiting on a
 * dependency (friction cad81659).
 */

/** Gate predicates, as built by the claim route. Each is TRUE when the task passes. */
export type ExplicitTaskGateName =
  | 'activeWorker'
  | 'taskHeld'
  | 'missionHeld'
  | 'missionLocal'
  | 'deps'
  | 'subject'
  | 'runnerPreference'
  | 'role'
  | 'runnerCooldown'
  | 'workspaceCap'
  | 'workspaceExecutor';

export type ExplicitTaskGates = Partial<Record<ExplicitTaskGateName, SQL>>;

export interface ExplicitTaskProbe {
  status: string | null;
  claimedBy: string | null;
  expiresAt: Date | string | null;
  startAt: Date | string | null;
  /**
   * Gate results; a missing key means "not evaluated", never "failed". A
   * `null` value is a FAILED gate: SQL NULL in a WHERE excludes the row.
   */
  gates: Partial<Record<ExplicitTaskGateName, boolean | null>>;
}

/** Appended to every exclusion an admin may override from claim_task. */
const FORCE_HINT = 'An admin can claim it anyway with claim_task force: true, or Start with override from the dashboard.';

/**
 * Check order: the fix a person would need first. A person's own hold outranks
 * the mission hold (resume, not arm); structural blockers outrank transient ones.
 */
const GATE_ORDER: Array<[ExplicitTaskGateName, ClaimTaskExclusionCode, string]> = [
  ['activeWorker', 'active_worker', 'The task already has a live worker.'],
  ['taskHeld', 'task_held', 'The task is held by a person. Resume it before claiming.'],
  ['missionHeld', 'mission_held', `Its mission is held. Arm the mission. ${FORCE_HINT}`],
  ['missionLocal', 'mission_local', `This mission runs in a local session: runners never pick up its tasks. Claim it from an interactive session with claim_task {taskId}, or set the mission's executor to 'runner'. ${FORCE_HINT}`],
  ['deps', 'deps_blocked', `A dependency is not satisfied yet (not completed with its PR merged, and not cancelled). ${FORCE_HINT}`],
  ['subject', 'subject_dead', `Its subject PR is closed or merged with no live successor. ${FORCE_HINT}`],
  ['runnerPreference', 'runner_preference', 'The task is restricted to a different runner type.'],
  ['role', 'role_mismatch', 'The task\'s role needs an explicit skill match this caller does not advertise.'],
  ['runnerCooldown', 'runner_cooldown', 'A worker from this runner failed on this task in the last minute; the per-runner cooldown is in effect. Retry in a minute.'],
  ['workspaceCap', 'workspace_cap', `The workspace is at its concurrent-task cap (active workers on its other tasks). ${FORCE_HINT}`],
  ['workspaceExecutor', 'workspace_executor', `The workspace runs its work on a different executor (cloud or host, set by gitConfig.executor or derived from its cloud dispatch webhook) than this caller. Change it on the workspace config page, or an admin can claim it anyway with claim_task force: true.`],
];

function toDate(v: Date | string | null): Date | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function classifyExplicitTaskExclusion(probe: ExplicitTaskProbe | null, now: Date): ClaimTaskExclusion {
  if (!probe) {
    return { code: 'not_found', detail: 'No such task in a workspace this token can claim from (check the id and workspaceId).' };
  }
  if (probe.status !== 'pending') {
    return { code: 'not_pending', detail: `The task is ${probe.status ?? 'in an unknown state'}; only pending tasks can be claimed.` };
  }
  // Mirrors the claim query's `claimedBy IS NULL OR expiresAt < now`: a claim
  // with no expiry never lapses.
  const expiresAt = toDate(probe.expiresAt);
  if (probe.claimedBy && (!expiresAt || expiresAt >= now)) {
    return { code: 'already_claimed', detail: 'The task is already claimed by another runner.' };
  }
  const startAt = toDate(probe.startAt);
  if (startAt && startAt > now) {
    return { code: 'deferred', detail: `The task is deferred until ${startAt.toISOString()}. ${FORCE_HINT}` };
  }
  for (const [gate, code, detail] of GATE_ORDER) {
    const v = probe.gates[gate];
    if (v === false || v === null) return { code, detail };
  }
  // Every condition of the claim WHERE is classified above (scope, status,
  // claim expiry, startAt, and each gate), so a row that passes all of them was
  // claimable when this probe ran: it changed after the claim query read it.
  return {
    code: 'state_changed',
    detail: 'Every claim filter passes on re-check, so the task changed between the claim query and this check (another claim, a completed dependency, an expired lock). Retry the claim.',
  };
}

/** One dependency row as the deps probe reads it. */
export interface BlockingDependencyRow {
  id: string;
  title: string | null;
  status: string | null;
  pathManifest: string[] | null;
  /** The same per-dependency predicate the claim gate uses. */
  satisfied: boolean | null;
  /** An open, unmerged PR on the dependency, when that is what holds it. */
  openPrNumber: number | null;
}

const shortId = (id: string) => id.slice(0, 8);

/**
 * The deps_blocked sentence: which dependencies hold the task and why.
 *
 * POST /api/tasks adds a dependsOn edge to every in-flight task whose concrete
 * pathManifest overlaps the new one (path-overlap serialization). The filer
 * never declared those edges, so "a dependency is not satisfied" on a task
 * they believe is dependency-free reads as a platform bug. When both manifests
 * overlap the sentence says the edge came from that rule.
 */
export function describeBlockingDependencies(
  taskManifest: string[] | null,
  dependsOn: string[],
  rows: BlockingDependencyRow[],
): string {
  const byId = new Map(rows.map(r => [r.id, r]));
  const parts: string[] = [];
  let inferred = false;
  for (const id of dependsOn) {
    const row = byId.get(id);
    if (!row) {
      parts.push(`${shortId(id)} (not found)`);
      continue;
    }
    if (row.satisfied === true) continue;
    const state = row.status === 'completed' && row.openPrNumber
      ? `completed, PR #${row.openPrNumber} not merged`
      : (row.status ?? 'unknown state');
    parts.push(`${shortId(row.id)}${row.title ? ` "${row.title}"` : ''} (${state})`);
    if (shouldSerializeByManifest(taskManifest, row.pathManifest)) inferred = true;
  }
  if (parts.length === 0) {
    return `A dependency is not satisfied yet. ${FORCE_HINT}`;
  }
  const origin = inferred
    ? ' Its pathManifest overlaps theirs, so the edge was probably added automatically when the task was created (path-overlap serialization), not declared by whoever filed it.'
    : '';
  return `Waiting on ${parts.join(', ')}. A dependency counts once it is completed with its PR merged, or cancelled.${origin} ${FORCE_HINT}`;
}

/** WHERE for the probe: the one task, only within the caller's claimable workspaces. */
export function explicitTaskScope(taskId: string, workspaceIds: string[]): SQL {
  return and(eq(tasks.id, taskId), inArray(tasks.workspaceId, workspaceIds))!;
}

/**
 * Returns null when the probe itself fails — a diagnosis must never change the
 * claim response beyond adding a reason.
 */
export async function diagnoseExplicitTaskExclusion(opts: {
  taskId: string;
  workspaceIds: string[];
  gates: ExplicitTaskGates;
  now: Date;
}): Promise<ClaimTaskExclusion | null> {
  try {
    const gateColumns: Record<string, SQL<boolean>> = {};
    for (const [name, predicate] of Object.entries(opts.gates)) {
      if (predicate) gateColumns[`g_${name}`] = sql<boolean>`COALESCE((${predicate}), false)`;
    }
    const rows = await db
      .select({
        status: tasks.status,
        claimedBy: tasks.claimedBy,
        expiresAt: tasks.expiresAt,
        startAt: tasks.startAt,
        workspaceId: tasks.workspaceId,
        dependsOn: tasks.dependsOn,
        pathManifest: tasks.pathManifest,
        ...gateColumns,
      })
      .from(tasks)
      .where(explicitTaskScope(opts.taskId, opts.workspaceIds))
      .limit(1);

    const row = (rows as any[])[0];
    if (!row) return classifyExplicitTaskExclusion(null, opts.now);

    const gates: ExplicitTaskProbe['gates'] = {};
    for (const name of Object.keys(opts.gates) as ExplicitTaskGateName[]) {
      const v = row[`g_${name}`];
      // Postgres booleans come back as booleans; tolerate 't'/'f' text forms.
      if (v === true || v === 't' || v === 'true') gates[name] = true;
      else if (v === false || v === 'f' || v === 'false' || v === null) gates[name] = false;
    }
    const exclusion = classifyExplicitTaskExclusion(
      { status: row.status ?? null, claimedBy: row.claimedBy ?? null, expiresAt: row.expiresAt ?? null, startAt: row.startAt ?? null, gates },
      opts.now,
    );
    if (exclusion.code === 'deps_blocked') {
      const dependsOn = Array.isArray(row.dependsOn) ? (row.dependsOn as string[]) : [];
      const detail = await describeDepsForTask(dependsOn, (row.pathManifest as string[] | null) ?? null, row.workspaceId ?? null);
      if (detail) return { code: exclusion.code, detail };
    }
    return exclusion;
  } catch (err) {
    console.warn(`[claim] explicit-task exclusion probe failed for task ${opts.taskId}:`, err);
    return null;
  }
}

/**
 * Codes that say the task was not claimable at all (gone, done, already
 * running). Every other code is a gate refusing a task that IS waiting to run.
 */
const NOT_A_REFUSAL: ReadonlySet<ClaimTaskExclusionCode> = new Set<ClaimTaskExclusionCode>([
  'not_found', 'not_pending', 'already_claimed', 'active_worker', 'state_changed',
]);

/**
 * The gate-ledger row for an explicit claim the WHERE clause refused, or null.
 *
 * A runner's wake-driven claim names its task, and a WHERE gate that drops it
 * returns only `no_pending_tasks` to the runner and records nothing anywhere —
 * unlike a dispatch-loop `deferTask`, which writes a `claim_loop_deferral` row.
 * So a reviewer refused on every wake by, say, `workspace_cap` had an empty
 * gate history and `explain` could only call it a wait. Recording the refusal
 * under the same gate and reason vocabulary puts the exact exclusion on the
 * task (explain's gateHistory) and feeds the stranded-task sweep's
 * consecutive-deferral count.
 */
export function explicitExclusionGateEvent(opts: {
  taskId: string;
  exclusion: ClaimTaskExclusion;
  workspaceId: string | null;
}): RecordGateEventInput | null {
  if (NOT_A_REFUSAL.has(opts.exclusion.code)) return null;
  return {
    gate: GATE_SLUGS.CLAIM_LOOP_DEFERRAL,
    surface: 'POST /api/workers/claim',
    outcome: 'deferred',
    reason: opts.exclusion.code,
    workspaceId: opts.workspaceId,
    taskId: opts.taskId,
    callerOrigin: 'worker',
    detail: { explicitClaim: true, detail: opts.exclusion.detail },
  };
}

/** Force-claim audit names for the SQL gates a force claim lifts. */
export type ForcedGateName = 'deps' | 'missionHeld' | 'missionLocal' | 'subject' | 'workspaceCap' | 'workspaceExecutor' | 'startAt';
const FORCED_GATE_CODES: Record<ForcedGateName, ClaimTaskExclusionCode> = {
  deps: 'deps_blocked',
  missionHeld: 'mission_held',
  missionLocal: 'mission_local',
  subject: 'subject_dead',
  workspaceCap: 'workspace_cap',
  workspaceExecutor: 'workspace_executor',
  startAt: 'deferred',
};

/**
 * Which of the SQL gates a force claim lifted would have excluded the task:
 * the audit half of the override (the claim query no longer applies them).
 * Returns exclusion codes; empty on any failure. Never blocks the claim.
 */
export async function evaluateForcedGates(opts: {
  taskId: string;
  workspaceIds: string[];
  gates: Record<ForcedGateName, SQL>;
}): Promise<ClaimTaskExclusionCode[]> {
  try {
    const cols: Record<string, SQL<boolean>> = {};
    for (const [name, predicate] of Object.entries(opts.gates)) {
      cols[`g_${name}`] = sql<boolean>`COALESCE((${predicate}), false)`;
    }
    const rows = await db.select(cols).from(tasks).where(explicitTaskScope(opts.taskId, opts.workspaceIds)).limit(1);
    const row = (rows as any[])[0];
    if (!row) return [];
    return (Object.keys(opts.gates) as ForcedGateName[])
      .filter(name => {
        const v = row[`g_${name}`];
        return v === false || v === 'f' || v === 'false' || v === null;
      })
      .map(name => FORCED_GATE_CODES[name]);
  } catch (err) {
    console.warn(`[claim] force-claim gate audit failed for task ${opts.taskId}:`, err);
    return [];
  }
}

/**
 * Read the task's dependencies with the claim gate's own per-dependency
 * predicate and describe the ones holding it. Null on any failure: the
 * generic deps_blocked sentence still stands.
 */
async function describeDepsForTask(dependsOn: string[], taskManifest: string[] | null, workspaceId: string | null): Promise<string | null> {
  // Only the task's own workspace is described: a dependency id pointing
  // anywhere else reads as "(not found)", never as another workspace's title.
  if (dependsOn.length === 0 || !workspaceId) return null;
  // Wrapped in its own fragment on purpose: drizzle renders a column that sits
  // directly in a select field unqualified ("id"), which inside the correlated
  // subqueries below would bind to the subquery's own table (w.id, t2.id). A
  // nested fragment renders qualified ("tasks"."id").
  const depTaskId = sql`${tasks.id}`;
  try {
    const rows = await db
      .select({
        id: tasks.id,
        title: tasks.title,
        status: tasks.status,
        pathManifest: tasks.pathManifest,
        satisfied: sql<boolean>`COALESCE((${dependencySatisfied(depTaskId)}), false)`,
        openPrNumber: sql<number | null>`(
          SELECT w.pr_number FROM ${workers} w
          WHERE w.task_id = ${depTaskId}
          AND w.pr_url IS NOT NULL
          AND w.merged_at IS NULL
          ORDER BY w.created_at DESC
          LIMIT 1
        )`,
      })
      .from(tasks)
      .where(and(inArray(tasks.id, dependsOn), eq(tasks.workspaceId, workspaceId)))
      .limit(dependsOn.length);
    return describeBlockingDependencies(taskManifest, dependsOn, rows as BlockingDependencyRow[]);
  } catch (err) {
    console.warn('[claim] explicit-task dependency detail lookup failed:', err);
    return null;
  }
}

/**
 * Record why an explicit single-task claim came back empty on the task itself
 * (context.lastClaimAttempt*), so the dashboard and reviewer gate can name the
 * gate instead of showing an ordinary QUEUED row.
 *
 * Scoped by `explicitTaskScope`: the write lands only when the task is in one
 * of the caller's claimable workspaces — the same list the claim query uses —
 * so a claim can never write to a task outside them. Best-effort; never throws.
 */
export async function stampLastClaimAttempt(opts: {
  taskId: string;
  workspaceIds: string[];
  reason: string;
  deferrals?: Record<string, number>;
  /** The specific gate, when the claim named one — `reason` alone is often just `no_pending_tasks`. */
  exclusion?: ClaimTaskExclusion;
  now: Date;
}): Promise<void> {
  if (opts.workspaceIds.length === 0) return;
  try {
    await db.update(tasks)
      .set({
        context: sql`COALESCE(${tasks.context}, '{}'::jsonb) || ${JSON.stringify({
          lastClaimAttemptAt: opts.now.toISOString(),
          lastClaimAttemptReason: opts.reason,
          ...(opts.deferrals ? { lastClaimAttemptDeferrals: opts.deferrals } : {}),
          ...(opts.exclusion ? { lastClaimAttemptExclusion: { code: opts.exclusion.code, detail: opts.exclusion.detail } } : {}),
        })}::jsonb`,
        updatedAt: opts.now,
      })
      .where(explicitTaskScope(opts.taskId, opts.workspaceIds));
  } catch (err) {
    console.warn(`[claim] failed to stamp lastClaimAttempt for task ${opts.taskId}:`, err);
  }
}
