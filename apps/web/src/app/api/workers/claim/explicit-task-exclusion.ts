import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import type { ClaimTaskExclusion, ClaimTaskExclusionCode } from '@buildd/shared';

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
 */

/** Gate predicates, as built by the claim route. Each is TRUE when the task passes. */
export type ExplicitTaskGateName =
  | 'activeWorker'
  | 'taskHeld'
  | 'missionHeld'
  | 'deps'
  | 'subject'
  | 'runnerPreference'
  | 'role'
  | 'runnerCooldown'
  | 'workspaceCap';

export type ExplicitTaskGates = Partial<Record<ExplicitTaskGateName, SQL>>;

export interface ExplicitTaskProbe {
  status: string | null;
  claimedBy: string | null;
  expiresAt: Date | string | null;
  startAt: Date | string | null;
  /** Gate results; a missing key means "not evaluated", never "failed". */
  gates: Partial<Record<ExplicitTaskGateName, boolean>>;
}

/**
 * Check order: the fix a person would need first. A person's own hold outranks
 * the mission hold (resume, not arm); structural blockers outrank transient ones.
 */
const GATE_ORDER: Array<[ExplicitTaskGateName, ClaimTaskExclusionCode, string]> = [
  ['activeWorker', 'active_worker', 'The task already has a live worker.'],
  ['taskHeld', 'task_held', 'The task is held by a person. Resume it before claiming.'],
  ['missionHeld', 'mission_held', 'Its mission is held. Arm the mission, or force-start this task from the dashboard (Start with override).'],
  ['deps', 'deps_blocked', 'A dependency is not satisfied yet (not completed with its PR merged, and not cancelled). Force-start from the dashboard to override.'],
  ['subject', 'subject_dead', 'Its subject PR is closed or merged with no live successor. Force-start from the dashboard to run it anyway.'],
  ['runnerPreference', 'runner_preference', 'The task is restricted to a different runner type.'],
  ['role', 'role_mismatch', 'The task\'s role needs an explicit skill match this caller does not advertise.'],
  ['runnerCooldown', 'runner_cooldown', 'A worker from this runner failed on this task recently; the per-runner cooldown is in effect.'],
  ['workspaceCap', 'workspace_cap', 'The workspace is at its concurrent-task cap. Use Start with cap exemption from the dashboard to override.'],
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
    return { code: 'deferred', detail: `The task is deferred until ${startAt.toISOString()}. Force-start from the dashboard to run it now.` };
  }
  for (const [gate, code, detail] of GATE_ORDER) {
    if (probe.gates[gate] === false) return { code, detail };
  }
  return { code: 'unknown', detail: 'Excluded by a claim filter this diagnosis does not cover.' };
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
      if (predicate) gateColumns[`g_${name}`] = sql<boolean>`(${predicate})`;
    }
    const rows = await db
      .select({
        status: tasks.status,
        claimedBy: tasks.claimedBy,
        expiresAt: tasks.expiresAt,
        startAt: tasks.startAt,
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
      else if (v === false || v === 'f' || v === 'false') gates[name] = false;
    }
    return classifyExplicitTaskExclusion(
      { status: row.status ?? null, claimedBy: row.claimedBy ?? null, expiresAt: row.expiresAt ?? null, startAt: row.startAt ?? null, gates },
      opts.now,
    );
  } catch (err) {
    console.warn(`[claim] explicit-task exclusion probe failed for task ${opts.taskId}:`, err);
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
        })}::jsonb`,
        updatedAt: opts.now,
      })
      .where(explicitTaskScope(opts.taskId, opts.workspaceIds));
  } catch (err) {
    console.warn(`[claim] failed to stamp lastClaimAttempt for task ${opts.taskId}:`, err);
  }
}
