/**
 * What a runner's claims take next, per team (spec c7410e76 R-26, AC-12), for
 * GET /api/workers/queue and `buildd top`'s Queue view.
 *
 * Not a second scheduler. Every waiting task in the runner's claimable
 * workspaces (lib/claim-order.ts claimableWorkspaceIds, the claim's own reach)
 * is read in the claim's own order (claimOrderBy) with the claim's own gate
 * predicates as boolean columns, the way the explicit-claim probe does
 * (app/api/workers/claim/explicit-task-exclusion.ts). A gate that can never
 * pass for this runner (a local-session mission, another runner holding it, a
 * role it does not advertise) puts the task under "Not for this runner"; a gate
 * that lifts on its own (a start time, a dependency, a hold, a cooldown) stays
 * in the queue and is named as a hold. The claim route itself is unchanged.
 *
 * In-loop deferrals the claim makes after reading the window (plan and rate
 * limits, path overlap, mission pacing) are not visible to a read: the runner
 * adds them from its last claim outcome for the task (R-25).
 */
import { and, asc, desc, eq, inArray, isNull, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import { taskEstimatesEnabled } from '@buildd/core/task-estimate-source';
import { db } from '@buildd/core/db';
import { missions, tasks, teams, workspaces } from '@buildd/core/db/schema';
import type { RunnerExecutor, RunnerQueueExclusion, RunnerQueueHold, RunnerQueueResponse, RunnerQueueTask, RunnerQueueTeam } from '@buildd/shared';
import { depsGate } from '@/app/api/workers/claim/deps-gate';
import { missionNotHeld, missionNotLocal, taskNotHeld, taskNotReserved } from '@/app/api/workers/claim/held-gate';
import { roleSlugGate } from '@/app/api/workers/claim/role-gate';
import { subjectLivenessCondition } from '@/app/api/workers/claim/subject-gate';
import { workspaceCapGate } from '@/app/api/workers/claim/workspace-cap-gate';
import { workspaceExecutorGate } from '@/app/api/workers/claim/workspace-executor-gate';
import { workspaceNotPausedGate } from '@/app/api/workers/claim/workspace-paused-gate';
import { loadBuildEstimateRows, type EstimateRow } from '@/lib/mission-build-estimates';
import { CLAIM_COOLDOWN_MS, activeWorkerGate, claimOrderBy, runnerCooldownGate, runnerPreferenceGate } from '@/lib/claim-order';

/** At most this many waiting tasks are read, in claim order. */
export const RUNNER_QUEUE_LIMIT = 300;

export type QueueGateName =
  | 'claimFree' | 'activeWorker' | 'runnerPreference' | 'missionLocal' | 'taskReserved' | 'role' | 'workspaceExecutor' | 'subject'
  | 'startAt' | 'taskHeld' | 'missionHeld' | 'deps' | 'workspacePaused' | 'workspaceCap' | 'runnerCooldown';

export interface RunnerQueueCaller {
  /** accounts.type; a 'user' account is not held by runnerPreference, as in the claim route. */
  accountType: string;
  /** The runner id the claim body sends (`runner`); scopes the per-runner cooldown. */
  runner: string | null;
  /** The role slugs the runner advertises (`availableSkills`). */
  availableSkills: string[];
  executor: RunnerExecutor;
}

/**
 * The claim gates, each TRUE when the task passes, built by the same functions
 * the claim route pushes into its WHERE for a runner's broad claim (no taskId,
 * no force, no interactive session).
 */
export function runnerQueueGates(caller: RunnerQueueCaller, now: Date): Partial<Record<QueueGateName, SQL>> {
  const gates: Partial<Record<QueueGateName, SQL>> = {
    claimFree: or(isNull(tasks.claimedBy), lt(tasks.expiresAt, now))!,
    activeWorker: activeWorkerGate(),
    missionLocal: missionNotLocal(),
    taskReserved: taskNotReserved(),
    workspaceExecutor: workspaceExecutorGate(caller.executor),
    subject: subjectLivenessCondition(),
    startAt: or(isNull(tasks.startAt), lte(tasks.startAt, now))!,
    taskHeld: taskNotHeld(),
    missionHeld: missionNotHeld(),
    deps: depsGate(),
    workspacePaused: workspaceNotPausedGate(now),
    workspaceCap: workspaceCapGate(),
  };
  if (caller.accountType !== 'user') gates.runnerPreference = runnerPreferenceGate(caller.accountType);
  const role = roleSlugGate(caller.availableSkills);
  if (role.length > 0) gates.role = and(...role)!;
  if (caller.runner) gates.runnerCooldown = runnerCooldownGate(caller.runner, new Date(now.getTime() - CLAIM_COOLDOWN_MS));
  return gates;
}

/** The rows a queue read covers: waiting tasks in the caller's claimable workspaces, nothing else. */
export function runnerQueueWhere(workspaceIds: string[]): SQL {
  return and(inArray(tasks.workspaceId, workspaceIds), eq(tasks.status, 'pending'))!;
}

/** Gate columns as the probe renders them: COALESCE so a NULL predicate reads as failed, as the WHERE treats it. */
export function runnerQueueGateColumns(gates: Partial<Record<QueueGateName, SQL>>): Record<string, SQL<boolean>> {
  const cols: Record<string, SQL<boolean>> = {};
  for (const [name, predicate] of Object.entries(gates)) {
    if (predicate) cols[`g_${name}`] = sql<boolean>`COALESCE((${predicate}), false)`;
  }
  return cols;
}

/** Never-for-this-runner gates, first failing one wins. */
const EXCLUSION_ORDER: Array<[QueueGateName, RunnerQueueExclusion]> = [
  ['missionLocal', 'local_session'],
  ['taskReserved', 'local_session'],
  ['claimFree', 'another_runner'],
  ['activeWorker', 'another_runner'],
  ['runnerPreference', 'runner_type'],
  ['role', 'role_missing'],
  ['workspaceExecutor', 'workspace_executor'],
  ['subject', 'subject_dead'],
];

/** Gates that lift on their own; listed in the claim probe's check order. */
const HOLD_ORDER: Array<[QueueGateName, RunnerQueueHold]> = [
  ['startAt', 'deferred'],
  ['taskHeld', 'task_held'],
  ['missionHeld', 'mission_held'],
  ['deps', 'deps_blocked'],
  ['workspacePaused', 'workspace_paused'],
  ['workspaceCap', 'workspace_cap'],
  ['runnerCooldown', 'runner_cooldown'],
];

function gateFailed(v: unknown): boolean {
  return v === false || v === null || v === 'f' || v === 'false';
}

function iso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export interface RunnerQueueRow {
  id: string;
  title: string;
  workspaceId: string;
  workspaceName: string | null;
  teamId: string;
  teamName: string | null;
  missionId: string | null;
  missionTitle: string | null;
  roleSlug: string | null;
  backend: string | null;
  priority: number | null;
  createdAt: Date | string;
  startAt: Date | string | null;
  dependsOn: unknown;
  workspacePausedUntil: Date | string | null;
  [gate: `g_${string}`]: unknown;
}

/** One read row as a queue entry: its exclusion (never for this runner) or its holds. */
export function classifyRunnerQueueRow(row: RunnerQueueRow): { task: RunnerQueueTask; exclusion: RunnerQueueExclusion | null } {
  const has = (g: QueueGateName) => `g_${g}` in row;
  const failed = (g: QueueGateName) => has(g) && gateFailed(row[`g_${g}`]);
  const exclusion = EXCLUSION_ORDER.find(([g]) => failed(g))?.[1] ?? null;
  const holds = HOLD_ORDER.filter(([g]) => failed(g)).map(([, h]) => h);
  const holdUntil = holds.includes('deferred') ? iso(row.startAt)
    : holds.includes('workspace_paused') ? iso(row.workspacePausedUntil)
    : null;
  return {
    exclusion,
    task: {
      id: row.id,
      title: row.title,
      workspaceId: row.workspaceId,
      workspaceName: row.workspaceName ?? row.workspaceId.slice(0, 8),
      missionId: row.missionId,
      missionTitle: row.missionTitle,
      roleSlug: row.roleSlug,
      backend: row.backend,
      priority: row.priority ?? 0,
      createdAt: iso(row.createdAt) ?? String(row.createdAt),
      dependsOn: Array.isArray(row.dependsOn) ? (row.dependsOn as string[]) : [],
      holds,
      holdUntil,
      estimateMinutes: null,
    },
  };
}

/** Rows already in claim order -> teams, each keeping that order; teams by name. */
export function groupRunnerQueue(rows: RunnerQueueRow[]): RunnerQueueTeam[] {
  const byTeam = new Map<string, RunnerQueueTeam>();
  for (const row of rows) {
    let team = byTeam.get(row.teamId);
    if (!team) {
      team = { teamId: row.teamId, teamName: row.teamName ?? row.teamId.slice(0, 8), estimatesOn: false, queue: [], notForRunner: [] };
      byTeam.set(row.teamId, team);
    }
    const { task, exclusion } = classifyRunnerQueueRow(row);
    if (exclusion) team.notForRunner.push({ ...task, reason: exclusion });
    else team.queue.push(task);
  }
  return [...byTeam.values()].sort((a, b) => a.teamName.localeCompare(b.teamName));
}

export interface RunnerQueueDeps {
  read?: (opts: { workspaceIds: string[]; gates: Partial<Record<QueueGateName, SQL>> }) => Promise<RunnerQueueRow[]>;
  estimates?: (teamId: string, taskIds: string[]) => Promise<EstimateRow[] | null>;
}

/** The read, on any select builder (the db, or a QueryBuilder to render it in a test). */
export function buildRunnerQueueQuery(builder: { select: typeof db.select }, opts: { workspaceIds: string[]; gates: Partial<Record<QueueGateName, SQL>> }) {
  return builder
    .select({
      id: tasks.id,
      title: tasks.title,
      workspaceId: tasks.workspaceId,
      workspaceName: workspaces.name,
      teamId: workspaces.teamId,
      teamName: teams.name,
      missionId: tasks.missionId,
      missionTitle: missions.title,
      roleSlug: tasks.roleSlug,
      backend: tasks.backend,
      priority: tasks.priority,
      createdAt: tasks.createdAt,
      startAt: tasks.startAt,
      dependsOn: tasks.dependsOn,
      workspacePausedUntil: workspaces.newStartsPausedUntil,
      ...runnerQueueGateColumns(opts.gates),
    })
    .from(tasks)
    .innerJoin(workspaces, eq(workspaces.id, tasks.workspaceId))
    .leftJoin(teams, eq(teams.id, workspaces.teamId))
    .leftJoin(missions, eq(missions.id, tasks.missionId))
    .where(runnerQueueWhere(opts.workspaceIds))
    // The claim candidate query's own ORDER BY.
    .orderBy(...claimOrderBy(tasks, { desc, asc }))
    .limit(RUNNER_QUEUE_LIMIT + 1);
}

async function readRows(opts: { workspaceIds: string[]; gates: Partial<Record<QueueGateName, SQL>> }): Promise<RunnerQueueRow[]> {
  return (await buildRunnerQueueQuery(db, opts)) as unknown as RunnerQueueRow[];
}

/**
 * Teams with task estimates on get each queued task's frozen p50 (the rows the
 * mission Overview and Plan page read); a team with them off gets none.
 */
async function readEstimates(teamId: string, taskIds: string[]): Promise<EstimateRow[] | null> {
  let enabled = false;
  const rows = await loadBuildEstimateRows(
    { teamId, taskIds, finished: false },
    { enabled: async (id) => { enabled = await taskEstimatesEnabled(id); return enabled; } },
  );
  return enabled ? rows : null;
}

export async function loadRunnerQueue(
  input: { workspaceIds: string[]; caller: RunnerQueueCaller; now?: Date },
  deps: RunnerQueueDeps = {},
): Promise<RunnerQueueResponse> {
  if (input.workspaceIds.length === 0) return { teams: [], truncated: false };
  const now = input.now ?? new Date();
  const gates = runnerQueueGates(input.caller, now);
  const rows = await (deps.read ?? readRows)({ workspaceIds: input.workspaceIds, gates });
  const truncated = rows.length > RUNNER_QUEUE_LIMIT;
  const teamsOut = groupRunnerQueue(rows.slice(0, RUNNER_QUEUE_LIMIT));
  const estimates = deps.estimates ?? readEstimates;
  await Promise.all(teamsOut.map(async (team) => {
    if (team.queue.length === 0) return;
    const est = await estimates(team.teamId, team.queue.map(t => t.id)).catch(() => null);
    if (!est) return;
    team.estimatesOn = true;
    // Newest first: the first row per task is its estimate.
    const first = new Map<string, number>();
    for (const r of est) if (!first.has(r.taskId)) first.set(r.taskId, r.p50Minutes);
    for (const t of team.queue) t.estimateMinutes = first.has(t.id) ? Math.round(first.get(t.id)!) : null;
  }));
  return { teams: teamsOut, truncated };
}
