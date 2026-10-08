/**
 * Managed-runner entitlement: metering, the claim-time check, and resume.
 *
 * Applies ONLY to claims by a Buildd-managed runner key (`accounts.managedRunner`).
 * A self-hosted runner never reaches this module, and the operational caps
 * (`accounts.maxConcurrentWorkers`, `workspaces.maxConcurrentTasks`) stay where
 * they are in the claim route, independent of it.
 *
 * Usage is attributed to the team that owns the task's workspace, pooled
 * across its workspaces. Runner-hours are wall-clock from worker start to end,
 * clipped to the current UTC month: what the managed compute provider bills.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { tasks, teams, workspaces } from '@buildd/core/db/schema';
import {
  ENTITLEMENT_BLOCK_CONTEXT_KEY,
  LIVE_WORKER_STATUSES,
  evaluateManagedRunnerEntitlement,
  monthlyWindowStart,
  type EntitlementBlock,
  type ManagedRunnerEntitlement,
} from '@buildd/shared';
import { resolveManagedRunnerEntitlement, type TeamManagedRunnerPlan } from './plans';
import { wakeTasks } from '@/lib/dispatch-authority';
import { checkHostedRunnerAllowance, dbHostedRunnerDeps, type HostedRunnerDeps } from '@/lib/hosted-runner-usage-store';

/** Hold kinds a managed plan lifts; `hosted_runner` lifts with the hosted allowance. */
export const MANAGED_HOLD_KINDS = ['concurrency', 'usage'] as const;
export const HOSTED_HOLD_KINDS = ['hosted_runner'] as const;
type HoldKind = EntitlementBlock['kind'];

export interface ManagedRunnerDeps {
  loadTeamPlan(teamId: string): Promise<TeamManagedRunnerPlan | null>;
  countActiveManagedRuns(teamId: string): Promise<number>;
  managedRunnerHoursSince(teamId: string, since: Date, now: Date): Promise<number>;
}

const liveStatusList = () => sql.join(LIVE_WORKER_STATUSES.map(s => sql`${s}`), sql`, `);

export const dbManagedRunnerDeps: ManagedRunnerDeps = {
  async loadTeamPlan(teamId) {
    const row = await db.query.teams.findFirst({ where: eq(teams.id, teamId), columns: { managedRunnerPlan: true } });
    return (row?.managedRunnerPlan as TeamManagedRunnerPlan | null | undefined) ?? null;
  },
  async countActiveManagedRuns(teamId) {
    const res = await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM workers w
      JOIN accounts a ON a.id = w.account_id
      JOIN workspaces ws ON ws.id = w.workspace_id
      WHERE a.managed_runner = true AND ws.team_id = ${teamId}
        AND w.status IN (${liveStatusList()})
    `) as unknown as { rows: Array<{ n: number }> };
    return Number(res.rows[0]?.n ?? 0);
  },
  async managedRunnerHoursSince(teamId, since, now) {
    // A live worker runs until now; a dead one without completed_at ended at
    // its last update. Clipped to [since, now].
    const res = await db.execute(sql`
      SELECT COALESCE(SUM(GREATEST(0, EXTRACT(EPOCH FROM (
        LEAST(COALESCE(w.completed_at, CASE WHEN w.status IN (${liveStatusList()}) THEN ${now} ELSE w.updated_at END), ${now})
        - GREATEST(COALESCE(w.started_at, w.created_at), ${since})
      )))), 0) / 3600.0 AS hours
      FROM workers w
      JOIN accounts a ON a.id = w.account_id
      JOIN workspaces ws ON ws.id = w.workspace_id
      WHERE a.managed_runner = true AND ws.team_id = ${teamId}
        AND COALESCE(w.completed_at, w.updated_at) >= ${since}
    `) as unknown as { rows: Array<{ hours: number | string }> };
    return Number(res.rows[0]?.hours ?? 0);
  },
};

/** The team's entitlement and whether it can block anything at all. */
export async function teamManagedRunnerEntitlement(teamId: string, deps: ManagedRunnerDeps = dbManagedRunnerDeps): Promise<ManagedRunnerEntitlement> {
  return resolveManagedRunnerEntitlement(await deps.loadTeamPlan(teamId));
}

function isUnlimited(ent: ManagedRunnerEntitlement): boolean {
  return ent.concurrency === null && (ent.monthlyRunnerHours === null || ent.overage === 'allow');
}

/**
 * May one more managed run start for this team? `claimedInBatch` counts runs
 * this same claim request already started (not yet visible as live workers).
 * Unlimited entitlements return without a query.
 */
export async function checkManagedRunnerEntitlement(
  teamId: string,
  opts: { claimedInBatch?: number; now?: Date } = {},
  deps: ManagedRunnerDeps = dbManagedRunnerDeps,
): Promise<EntitlementBlock | null> {
  const ent = await teamManagedRunnerEntitlement(teamId, deps);
  if (isUnlimited(ent)) return null;
  const now = opts.now ?? new Date();
  const activeRuns = ent.concurrency !== null ? (await deps.countActiveManagedRuns(teamId)) + (opts.claimedInBatch ?? 0) : 0;
  const runnerHoursUsed = ent.monthlyRunnerHours !== null && ent.overage === 'block'
    ? await deps.managedRunnerHoursSince(teamId, monthlyWindowStart(now), now)
    : 0;
  return evaluateManagedRunnerEntitlement(ent, { activeRuns, runnerHoursUsed, now });
}

/**
 * Record on the task that it waits on an entitlement, so every surface shows
 * the entitlement state instead of an ordinary QUEUED row. Best-effort.
 */
export async function stampEntitlementBlock(taskId: string, block: EntitlementBlock, now = new Date()): Promise<void> {
  try {
    await db.update(tasks)
      .set({
        context: sql`COALESCE(${tasks.context}, '{}'::jsonb) || ${JSON.stringify({ [ENTITLEMENT_BLOCK_CONTEXT_KEY]: { ...block, at: now.toISOString() } })}::jsonb`,
      })
      .where(and(eq(tasks.id, taskId), eq(tasks.status, 'pending')));
  } catch (err) {
    console.warn(`[entitlements] failed to stamp entitlement block on task ${taskId}:`, err);
  }
}

/**
 * Wake pending tasks in the team that wait on an entitlement, oldest and
 * highest priority first. A wake is "reconsider now": the claim re-runs every
 * gate, this one included, so waking one too many costs a deferred claim.
 */
export async function wakeEntitlementBlockedTasks(teamId: string, limit = 1, kinds?: readonly HoldKind[]): Promise<number> {
  try {
    const kindFilter = kinds && kinds.length > 0
      ? sql`(${tasks.context}->${ENTITLEMENT_BLOCK_CONTEXT_KEY}->>'kind') IN (${sql.join(kinds.map(k => sql`${k}`), sql`, `)})`
      : sql`true`;
    const rows = await db.select({ id: tasks.id })
      .from(tasks)
      .innerJoin(workspaces, eq(workspaces.id, tasks.workspaceId))
      .where(and(
        eq(workspaces.teamId, teamId),
        eq(tasks.status, 'pending'),
        sql`${tasks.context} ? ${ENTITLEMENT_BLOCK_CONTEXT_KEY}`,
        kindFilter,
      ))
      .orderBy(sql`${tasks.priority} DESC`, tasks.createdAt)
      .limit(limit);
    await wakeTasks(rows.map(r => r.id), 'capacity.freed');
    return rows.length;
  } catch (err) {
    console.error(`[entitlements] wake failed for team ${teamId}:`, err);
    return 0;
  }
}

/**
 * A managed worker went terminal: one slot (and possibly the hour that tipped
 * the meter) is back. Called next to the operational capacity wake.
 */
export async function onManagedWorkerTerminal(workspaceId: string): Promise<void> {
  try {
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId), columns: { teamId: true } });
    if (ws?.teamId) await wakeEntitlementBlockedTasks(ws.teamId, 1, MANAGED_HOLD_KINDS);
  } catch (err) {
    console.error(`[entitlements] terminal wake failed for workspace ${workspaceId}:`, err);
  }
}

/**
 * Resume work an entitlement held once it no longer applies: the monthly
 * allowance refilled, or billing raised the plan. Hourly, from the dispatch
 * floor; hosted billing may also call `wakeEntitlementBlockedTasks` the moment
 * it changes a plan.
 */
export async function sweepEntitlementBlockedTasks(
  deps: ManagedRunnerDeps = dbManagedRunnerDeps,
  hostedDeps: HostedRunnerDeps = dbHostedRunnerDeps,
): Promise<{ teams: number; woken: number }> {
  const rows = await db.selectDistinct({ teamId: workspaces.teamId })
    .from(tasks)
    .innerJoin(workspaces, eq(workspaces.id, tasks.workspaceId))
    .where(and(eq(tasks.status, 'pending'), sql`${tasks.context} ? ${ENTITLEMENT_BLOCK_CONTEXT_KEY}`));
  let woken = 0;
  for (const { teamId } of rows) {
    if (!teamId) continue;
    // Hosted runner holds lift with the hosted allowance (month reset, or more hours).
    if (!(await checkHostedRunnerAllowance(teamId, {}, hostedDeps))) {
      woken += await wakeEntitlementBlockedTasks(teamId, 50, HOSTED_HOLD_KINDS);
    }
    const ent = await teamManagedRunnerEntitlement(teamId, deps);
    if (isUnlimited(ent)) { woken += await wakeEntitlementBlockedTasks(teamId, 50, MANAGED_HOLD_KINDS); continue; }
    const block = await checkManagedRunnerEntitlement(teamId, {}, deps);
    if (block) continue;
    const free = ent.concurrency === null ? 50 : Math.max(1, ent.concurrency - await deps.countActiveManagedRuns(teamId));
    woken += await wakeEntitlementBlockedTasks(teamId, free, MANAGED_HOLD_KINDS);
  }
  return { teams: rows.length, woken };
}
