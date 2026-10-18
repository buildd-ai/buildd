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
import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { taskEstimatesEnabled } from '@buildd/core/task-estimate-source';
import { taskEstimatesDefaultOn } from '@buildd/core/task-estimate-rollout';
import { ESTIMATOR_VERSION } from '@buildd/core/task-estimate';
import { db } from '@buildd/core/db';
import { missions, taskEstimates, tasks, teams, workspaces } from '@buildd/core/db/schema';
import type { RunnerExecutor, RunnerQueueExclusion, RunnerQueueHold, RunnerQueueHoldCause, RunnerQueueResponse, RunnerQueueTask, RunnerQueueTeam } from '@buildd/shared';
import { claimOrderBy } from '@/lib/claim-order';
import { claimCandidateWhere, type ClaimCandidateInput, type ClaimGateName } from '@/lib/claim-candidate-where';
import { findBlockingPr, intersectPaths, REPO_WIDE_SENTINEL } from '@buildd/core/path-overlap';
import type { WorkspaceGitConfig } from '@buildd/core/db/schema';
import { findHoldingLease, findHoldingOpenPr, workspaceHardSurface } from '@/app/api/workers/claim/overlap-policy';
import { advisoryBlockingPeer, advisoryMutexApplies, type OpenPrTask } from '@/app/api/workers/claim/coordination-gates';

/** At most this many waiting tasks are read, in claim order. */
export const RUNNER_QUEUE_LIMIT = 300;

export type QueueGateName = ClaimGateName;

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
  return claimCandidateWhere(callerInput(caller, now, [])).gates;
}

/** A runner's broad claim (no taskId, no force, no interactive session), as the claim route's candidate WHERE input. */
function callerInput(caller: RunnerQueueCaller, now: Date, workspaceIds: string[]): ClaimCandidateInput {
  return {
    workspaceIds,
    now,
    accountType: caller.accountType,
    runner: caller.runner,
    availableSkills: caller.availableSkills,
    executor: caller.executor,
  };
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
  /** tasks.context flags that say what set `startAt` (read as text, not the whole context). */
  ctxInfraRetryCount?: string | number | null;
  ctxBudgetExhausted?: string | boolean | null;
  ctxCredentialHold?: string | boolean | null;
  /** For the alongside read (`queueAlongside`); never sent to the runner. */
  pathManifest?: string[] | null;
  /** For the one-undeclared-task-per-mission projection (`advisoryMutexApplies`); never sent to the runner. */
  category?: string | null;
  outputRequirement?: string | null;
  gitConfig?: unknown;
  [gate: `g_${string}`]: unknown;
}

/** What set a task's start time, from the context flags the read carries. */
export function holdCauseOf(row: RunnerQueueRow): RunnerQueueHoldCause {
  const truthy = (v: unknown) => v === true || v === 't' || v === 'true';
  if (truthy(row.ctxCredentialHold)) return 'credential_probe';
  if (truthy(row.ctxBudgetExhausted)) return 'usage_limit_reset';
  if (Number(row.ctxInfraRetryCount ?? 0) > 0) return 'retry_after_failures';
  return 'scheduled';
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
      holdCause: holds.includes('deferred') ? holdCauseOf(row) : null,
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

/** What a queued task's overlaps are read against: open PRs and live leases, per workspace. */
export interface QueueOverlapState {
  openPrs: Map<string, OpenPrTask[]>;
  leases: Map<string, Map<string, string[]>>;
}

export interface RunnerQueueDeps {
  calibrated?: () => boolean;
  read?: (opts: { workspaceIds: string[]; gates: Partial<Record<QueueGateName, SQL>> }) => Promise<RunnerQueueRow[]>;
  estimates?: (teamId: string, taskIds: string[]) => Promise<EstimateRow[] | null>;
  workspaceConfigs?: (workspaceIds: string[]) => Promise<Array<{ id: string; gitConfig: unknown }>>;
  overlaps?: (workspaceIds: string[]) => Promise<QueueOverlapState>;
  /** missionId → its in-flight tasks that declare no files (the claim's `missionAdvisoryInFlight`). */
  missionInFlight?: (missionIds: string[]) => Promise<Map<string, Set<string>>>;
}

async function readMissionInFlight(missionIds: string[]): Promise<Map<string, Set<string>>> {
  const { loadMissionCoordination } = await import('@/app/api/workers/claim/coordination-snapshot');
  return (await loadMissionCoordination(missionIds)).missionAdvisoryInFlight;
}

/**
 * The claim's one-scope-undeclared-task-per-mission serialization
 * (advisory_manifest, claim route step 4), projected onto the queue in claim
 * order: a task it applies to waits on the mission's in-flight undeclared
 * task, else on the first such task ahead of it here that nothing else holds
 * (the claim starts that one and adds it to the set in the same batch). Rows
 * are mutated in place. One known gap: under the planner's `apply` mode a
 * task with a confident predicted scope skips the mutex at claim time, which
 * this read cannot see, so such a task may start where the queue says it waits.
 */
export function markAdvisorySerialized(
  teamsOut: RunnerQueueTeam[],
  rowsById: Map<string, RunnerQueueRow>,
  inFlight: Map<string, Set<string>>,
): void {
  const occupied = new Map([...inFlight].map(([m, set]) => [m, new Set(set)]));
  for (const team of teamsOut) for (const t of team.queue) {
    const r = rowsById.get(t.id);
    // A task something else holds never starts, so it neither waits here nor occupies the slot.
    if (!t.missionId || !r || t.holds.length > 0 || !advisoryMutexApplies(r)) continue;
    const peer = advisoryBlockingPeer(t.id, occupied.get(t.missionId));
    if (peer) {
      t.holds = [...t.holds, 'advisory_manifest'];
      t.holderTaskId = peer;
    } else {
      occupied.set(t.missionId, new Set([t.id]));
    }
  }
}

/**
 * The work a queued task would start alongside (spec: Claim Overlap
 * Scheduling, I-38): the first open PR, else live lease, it shares files with,
 * when the claim's overlap policy (./overlap-policy) lets it start. Null when
 * it overlaps nothing, or anything that would hold it.
 */
export function queueAlongside(
  task: { id: string; workspaceId: string; pathManifest?: string[] | null; gitConfig?: unknown },
  state: QueueOverlapState,
): { prNumber: number | null; holderTaskId: string | null } | null {
  const manifest = (task.pathManifest ?? []).filter(p => p !== REPO_WIDE_SENTINEL);
  if (manifest.length === 0) return null;
  const gitConfig = (task.gitConfig ?? null) as WorkspaceGitConfig | null;
  const prs = (state.openPrs.get(task.workspaceId) ?? []).filter(pr => pr.taskId !== task.id);
  if (findHoldingOpenPr(manifest, prs, workspaceHardSurface(gitConfig))) return null;
  const leases = state.leases.get(task.workspaceId);
  if (findHoldingLease(task.id, manifest, leases, undefined, gitConfig)) return null;
  const pr = prs.find(p => findBlockingPr(manifest, [p]));
  if (pr) return { prNumber: pr.prNumber ?? null, holderTaskId: pr.taskId ?? null };
  for (const [holderTaskId, claimed] of leases ?? []) {
    if (holderTaskId !== task.id && intersectPaths(manifest, claimed.filter(p => p !== REPO_WIDE_SENTINEL)).length > 0) return { prNumber: null, holderTaskId };
  }
  return null;
}

async function readOverlaps(workspaceIds: string[]): Promise<QueueOverlapState> {
  const [{ loadOpenPrTasksByWorkspace }, { getActiveClaimsByWorkspace }] = await Promise.all([
    import('@/app/api/workers/claim/coordination-snapshot'), import('@buildd/core/path-claim'),
  ]);
  const [openPrs, leaseList] = await Promise.all([
    loadOpenPrTasksByWorkspace(workspaceIds),
    Promise.all(workspaceIds.map(async ws => [ws, await getActiveClaimsByWorkspace(ws)] as const)),
  ]);
  return { openPrs, leases: new Map(leaseList) };
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
      ctxInfraRetryCount: sql<string | null>`${tasks.context}->>'infraRetryCount'`,
      ctxBudgetExhausted: sql<string | null>`${tasks.context}->>'budgetExhausted'`,
      ctxCredentialHold: sql<string | null>`${tasks.context}->'credentialHold' IS NOT NULL`,
      pathManifest: tasks.pathManifest,
      category: tasks.category,
      outputRequirement: tasks.outputRequirement,
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

async function readWorkspaceConfigs(workspaceIds: string[]) {
  return db.select({ id: workspaces.id, gitConfig: workspaces.gitConfig }).from(workspaces).where(inArray(workspaces.id, workspaceIds));
}

async function readRows(opts: { workspaceIds: string[]; gates: Partial<Record<QueueGateName, SQL>> }): Promise<RunnerQueueRow[]> {
  return (await buildRunnerQueueQuery(db, opts)) as unknown as RunnerQueueRow[];
}

export type EstimateRow = { estimatorVersion: string; taskId: string; p50Minutes: number };

/**
 * Teams with task estimates on get each queued task's frozen p50, from the
 * same rows the mission Overview and Plan page read, under the same team
 * availability; numeric projections additionally require calibrated running
 * version rows. A team with them off gets none (null). Newest row first.
 */
async function readEstimates(teamId: string, taskIds: string[]): Promise<EstimateRow[] | null> {
  if (taskIds.length === 0 || !(await taskEstimatesEnabled(teamId))) return null;
  return db
    .select({ taskId: taskEstimates.taskId, estimatorVersion: taskEstimates.estimatorVersion, p50Minutes: taskEstimates.p50Minutes })
    .from(taskEstimates)
    .where(and(eq(taskEstimates.teamId, teamId), eq(taskEstimates.estimatorVersion, ESTIMATOR_VERSION), inArray(taskEstimates.taskId, taskIds)))
    .orderBy(desc(taskEstimates.createdAt));
}

/**
 * Candidate task ids for a runner's broad claim: the route's own WHERE
 * (claimCandidateWhere) and ORDER BY (claimOrderBy), for test verification.
 */
export async function fetchBroadClaimCandidateIds(
  builder: { select: typeof db.select },
  opts: { workspaceIds: string[]; caller: RunnerQueueCaller; now: Date },
): Promise<string[]> {
  const { conditions } = claimCandidateWhere(callerInput(opts.caller, opts.now, opts.workspaceIds));
  const rows = await builder
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(...conditions)!)
    .orderBy(...claimOrderBy(tasks, { desc, asc }));
  return rows.map((r) => r.id);
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
  const kept = rows.slice(0, RUNNER_QUEUE_LIMIT);
  const teamsOut = groupRunnerQueue(kept);
  // Overlaps are read only when some queued task declares files; a failed
  // read leaves every row without `alongside`.
  const declaring = kept.filter(r => Array.isArray(r.pathManifest) && r.pathManifest.length > 0);
  if (declaring.length > 0) {
    const workspaceIds = [...new Set(declaring.map(r => r.workspaceId))];
    const [state, configs] = await Promise.all([
      (deps.overlaps ?? readOverlaps)(workspaceIds).catch(() => null),
      (deps.workspaceConfigs ?? readWorkspaceConfigs)(workspaceIds).catch(() => null),
    ]);
    // A failed configuration read must not weaken the workspace overlap policy.
    if (configs) {
      const byWorkspace = new Map(configs.map(r => [r.id, r.gitConfig]));
      for (const row of declaring) row.gitConfig = byWorkspace.get(row.workspaceId) ?? null;
    }
    if (state && configs) {
      const byId = new Map(declaring.map(r => [r.id, r]));
      for (const team of teamsOut) for (const t of team.queue) {
        const r = byId.get(t.id);
        const a = r ? queueAlongside(r, state) : null;
        if (a) t.alongside = a;
      }
    }
  }
  // Undeclared-scope serialization; a failed read marks nothing.
  const undeclared = kept.filter(r => r.missionId && advisoryMutexApplies(r));
  if (undeclared.length > 0) {
    const missionIds = [...new Set(undeclared.map(r => r.missionId!))];
    const inFlight = await (deps.missionInFlight ?? readMissionInFlight)(missionIds).catch(() => null);
    if (inFlight) markAdvisorySerialized(teamsOut, new Map(kept.map(r => [r.id, r])), inFlight);
  }
  const estimates = deps.estimates ?? readEstimates;
  await Promise.all(teamsOut.map(async (team) => {
    if (team.queue.length === 0 || !(deps.calibrated ?? taskEstimatesDefaultOn)()) return;
    const est = await estimates(team.teamId, team.queue.map(t => t.id)).catch(() => null);
    if (!est) return;
    team.estimatesOn = true;
    // Newest first: the first row per task is its estimate.
    const first = new Map<string, number>();
    for (const r of est) if (r.estimatorVersion === ESTIMATOR_VERSION && !first.has(r.taskId)) first.set(r.taskId, r.p50Minutes);
    for (const t of team.queue) t.estimateMinutes = first.has(t.id) ? Math.round(first.get(t.id)!) : null;
  }));
  return { teams: teamsOut, truncated };
}
