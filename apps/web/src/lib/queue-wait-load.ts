/**
 * Why each pending task waits, read from the claim route's own query and gates
 * (spec: Overlap scheduling, "What a waiting task can say", AC-10; Health ›
 * Queue, R-5, AC-9). Not a parallel predicate:
 *
 *   - the claim candidate WHERE (`claimCandidateWhere`, the builder the route
 *     and the runner queue use), each runner-independent gate as a boolean
 *     column: start time, a person's hold, the mission's hold or local
 *     executor, a closed subject PR, declared dependencies, a workspace pause,
 *     the workspace cap;
 *   - the dependency gate's own per-edge predicate (`dependencySatisfied`), to
 *     name which dependency holds it;
 *   - the claim loop's coordination gates (`evaluateCoordinationGates` over the
 *     route's own snapshot reads): the serial lane in its stored order, the
 *     lane-path open-PR and lease backstops, mission concurrency and pacing;
 *   - the mission budget, as the loop checks it;
 *   - the limits only the loop can see (a budget wall, a plan limit, seats), from
 *     its fresh deferral rows in the gate ledger.
 *
 * Every reason becomes a `WaitingReason`; `queueWaitOf` picks the one the task
 * waits for. A task no gate refuses is a `slot` wait: the claim query would
 * return it now. Explain, the task page, the mission rows, the terminal Queue
 * (through GET /api/workers/queue) and the web Queue all read this.
 *
 * Server-only. Never throws: a failed read leaves a task out of the map, and
 * the caller keeps what it said before rather than inventing a reason.
 */
import { and, desc, eq, gt, inArray, sql, type SQL } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { gateEvents, tasks, workers, workspaces, type WorkspaceGitConfig } from '@buildd/core/db/schema';
import { GATE_SLUGS } from '@buildd/core/gate-slugs';
import { makeWaitingReason, orderWaitingReasons, queueWaitOf, type WaitingKind, type WaitingReason } from '@buildd/core/waiting-reason';
import type { QueueWait } from '@buildd/shared';
import { LIVE_WORKER_STATUSES } from '@buildd/shared';
import { claimCandidateWhere, type ClaimGateName } from '@/lib/claim-candidate-where';
import { claimHoldPhrase } from '@/lib/claim-hold-phrase';
import { dependencySatisfied } from '@/app/api/workers/claim/deps-gate';
import { evaluateCoordinationGates, type MissionCoordination, type OpenPrTask } from '@/app/api/workers/claim/coordination-gates';
import { lanesOf } from '@/lib/serial-lanes';
import { BYPASS_MISSION_BUDGET_KEY, hasBypassFlag } from '@/lib/bypass-flags';
import type { LaneRead } from '@/lib/serial-lanes-store';
import { sqlWhere } from '@buildd/core/db/relational-sql';

/** The runner-independent claim gates a queue wait reads, each TRUE when the task passes. */
export const QUEUE_WAIT_GATES = ['startAt', 'taskHeld', 'missionHeld', 'missionLocal', 'subject', 'deps', 'workspacePaused', 'workspaceCap'] as const satisfies readonly ClaimGateName[];
export type QueueWaitGate = (typeof QUEUE_WAIT_GATES)[number];

/** At most this many tasks are read per call (a mission page, a runner's queue). */
export const QUEUE_WAIT_LIMIT = 300;

/** One pending task as the read gives it. */
export interface QueueWaitTask {
  id: string;
  workspaceId: string;
  missionId: string | null;
  pathManifest: string[] | null;
  dependsOn: string[] | null;
  startAt: Date | string | null;
  category?: unknown;
  context?: unknown;
  outputRequirement?: unknown;
  taskClass?: string | null;
  conflictRetryPrNumber?: number | null;
  ciRetryPrNumber?: number | null;
  reviewerRetryPrNumber?: number | null;
  workspace?: { gitConfig: WorkspaceGitConfig | null } | null;
  workspacePausedUntil?: Date | string | null;
  /** Each gate in `QUEUE_WAIT_GATES`: true = passes, false = refuses it. Missing = not read. */
  gates: Partial<Record<QueueWaitGate, boolean>>;
}

/**
 * A claim-loop refusal recent enough to still be an observation: the same
 * fifteen minutes (about thirty runner polls) the mission header uses for a
 * live refusal streak (`DEFERRAL_FRESHNESS_MS`, lib/mission-claim-deferrals).
 */
export const LEDGER_FRESH_MS = 15 * 60 * 1000;

/** The task's newest claim-loop refusal, as the gate ledger recorded it. */
export interface LedgerHold {
  reason: string;
  occurredAt: string;
  firstDeferredAt: string | null;
  detail: Record<string, unknown> | null;
}

/** A dependency the deps gate still holds the task on. */
export interface UnmetDependency { id: string; title: string | null; status: string | null }

/** Everything besides the row: what the coordination snapshot, the deps read and the ledger say. */
export interface QueueWaitFacts {
  /** The unmet dependencies, in the task's order. Empty when the gate passes or the read failed. */
  unmetDependencies: UnmetDependency[];
  /** The claim loop's coordination reasons (`evaluateCoordinationGates`). */
  coordination: WaitingReason[];
  /** The task's mission is budget_exhausted and nothing bypasses it. */
  missionBudgetExhausted: boolean;
  /** The task's newest claim-loop refusal, when fresh enough to still be an observation. */
  ledger: LedgerHold | null;
}

const iso = (v: Date | string | null | undefined): string | null => {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const refuses = (t: QueueWaitTask, g: QueueWaitGate) => t.gates[g] === false;
const prov = (derivedFrom: string) => ({ source: 'probe' as const, derivedFrom });

/** The claim query's own prefilters that refuse the task, as reasons. Pure. */
export function sqlGateReasons(t: QueueWaitTask, deps: UnmetDependency[]): WaitingReason[] {
  const out: WaitingReason[] = [];
  const mission = t.missionId ? { type: 'mission' as const, id: t.missionId, label: 'its mission', href: `/app/missions/${t.missionId}` } : undefined;
  if (refuses(t, 'startAt')) {
    const at = iso(t.startAt);
    out.push(makeWaitingReason('start_deferred', { because: at ? `its start time is ${at}` : 'it has a start time', liftsAt: at, provenance: prov('tasks.startAt (claim WHERE)') }));
  }
  if (refuses(t, 'taskHeld')) out.push(makeWaitingReason('task_held', { because: 'a person paused it', provenance: prov('tasks.context hold (claim WHERE)') }));
  if (refuses(t, 'missionHeld')) out.push(makeWaitingReason('mission_held', { because: 'its mission is not running', blocker: mission, provenance: prov('missions.isHeld (claim WHERE)') }));
  if (refuses(t, 'missionLocal')) out.push(makeWaitingReason('mission_local', { because: 'its mission runs from a person\'s own session, so runners do not pick up its tasks', blocker: mission, provenance: prov("missions.executor='local' (claim WHERE)") }));
  if (refuses(t, 'subject')) out.push(makeWaitingReason('subject_dead', { because: 'the PR it was filed for is closed', provenance: prov('subject PR liveness (claim WHERE)') }));
  if (refuses(t, 'deps')) {
    const named = deps.length > 0 ? deps : [{ id: '', title: null, status: null }];
    for (const d of named) {
      out.push(makeWaitingReason('dep_declared', {
        because: 'it was declared as a dependency',
        ...(d.id ? {
          blocker: {
            type: 'task' as const, id: d.id, label: d.title ? `“${d.title.length > 60 ? `${d.title.slice(0, 57)}…` : d.title}”` : `task ${d.id.slice(0, 8)}`,
            href: `/app/tasks/${d.id}`, live: d.status === 'assigned' || d.status === 'in_progress', ...(d.status ? { status: d.status } : {}),
          },
        } : {}),
        provenance: prov('tasks.dependsOn (claim WHERE, dependencySatisfied)'),
      }));
    }
  }
  if (refuses(t, 'workspacePaused')) {
    const until = iso(t.workspacePausedUntil);
    out.push(makeWaitingReason('workspace_paused', { because: until ? `the workspace paused new starts until ${until}` : 'the workspace paused new starts', liftsAt: until, provenance: prov('workspaces.newStartsPausedUntil (claim WHERE)') }));
  }
  if (refuses(t, 'workspaceCap')) out.push(makeWaitingReason('workspace_cap', { because: 'every agent slot in the workspace is in use', provenance: prov('workspace cap (claim WHERE)') }));
  return out;
}

/**
 * A limit only the claim loop sees, from its fresh deferral row: the reason it
 * recorded, when it lifts. Reasons the read already decides (lane, mission
 * gates, dependencies) are left to it. Pure.
 */
const LEDGER_LIMITS: Readonly<Record<string, WaitingKind>> = {
  budget_paused: 'budget_paused',
  managed_concurrency: 'managed_entitlement',
  managed_runner_hours: 'managed_entitlement',
  hosted_runner_hours: 'managed_entitlement',
  oauth_parallelism: 'oauth_parallelism',
  codex_single_flight: 'codex_single_flight',
  workspace_cap: 'workspace_cap',
};
const LEDGER_NO_RUNNER = new Set([
  'runner_capability', 'isolation_unenforced', 'connector_mismatch', 'role_env_unsatisfied', 'no_personal_credential',
  'provider_unavailable', 'delegation_unmet', 'provider_not_allowed', 'tier_policy',
]);

export function ledgerLimitReasons(hold: LedgerHold | null, now: Date): WaitingReason[] {
  if (!hold) return [];
  const at = Date.parse(hold.occurredAt);
  if (!Number.isFinite(at) || now.getTime() - at > LEDGER_FRESH_MS) return [];
  const detail = hold.detail ?? {};
  const resets = typeof detail.resetsAt === 'string' ? iso(detail.resetsAt) : null;
  const firstSeenAt = hold.firstDeferredAt ?? undefined;
  const provenance = { source: 'ledger' as const, derivedFrom: `gate_events#claim_loop_deferral/${hold.reason}`, ...(firstSeenAt ? { firstSeenAt } : {}) };
  const kind = LEDGER_LIMITS[hold.reason];
  if (kind) return [makeWaitingReason(kind, { because: claimHoldPhrase(hold.reason) ?? hold.reason, liftsAt: resets && Date.parse(resets) > now.getTime() ? resets : null, provenance })];
  if (LEDGER_NO_RUNNER.has(hold.reason)) return [makeWaitingReason('capability_mismatch', { because: claimHoldPhrase(hold.reason) ?? 'no runner has what it needs', provenance })];
  return [];
}

/** Every live reason for one task, ordered, from the row and its facts. Pure. */
export function assembleQueueReasons(t: QueueWaitTask, f: QueueWaitFacts, now: Date): WaitingReason[] {
  const out = [
    ...sqlGateReasons(t, f.unmetDependencies),
    ...f.coordination,
    ...(f.missionBudgetExhausted && t.missionId
      ? [makeWaitingReason('mission_budget', { because: "the mission's budget is spent", blocker: { type: 'mission', id: t.missionId, label: 'the mission budget', href: `/app/missions/${t.missionId}` }, provenance: prov("missions.status='budget_exhausted' (claim loop)") })]
      : []),
    ...ledgerLimitReasons(f.ledger, now),
  ];
  // One reason per kind and blocker: the read and the ledger can both name the workspace cap.
  const seen = new Set<string>();
  return orderWaitingReasons(out.filter(r => {
    const key = `${r.kind}:${r.blocker?.id ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }));
}

/** The task's one wait, and the reasons it was picked from. */
export interface LoadedQueueWait {
  wait: QueueWait;
  reasons: WaitingReason[];
}

/** One task's wait from its row and facts. Pure. */
export function queueWaitFor(t: QueueWaitTask, f: QueueWaitFacts, now: Date): LoadedQueueWait {
  const reasons = assembleQueueReasons(t, f, now);
  return { wait: queueWaitOf(reasons), reasons };
}

const truthy = (v: unknown) => v === true || v === 't' || v === 'true';
const UUID_RE = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

/** The gate columns, built by the claim's own builder: COALESCE so a NULL predicate reads as refused, as the WHERE treats it. */
export function queueWaitGateColumns(now: Date): Record<string, SQL<boolean>> {
  const { gates } = claimCandidateWhere({ workspaceIds: [], now, accountType: 'user', runner: null, availableSkills: [], executor: 'host' });
  const cols: Record<string, SQL<boolean>> = {};
  for (const name of QUEUE_WAIT_GATES) {
    const g = gates[name];
    if (g) cols[`g_${name}`] = sql<boolean>`COALESCE((${g}), false)`;
  }
  return cols;
}

async function readTasks(taskIds: string[], now: Date): Promise<QueueWaitTask[]> {
  const rows = await db
    .select({
      id: tasks.id,
      workspaceId: tasks.workspaceId,
      missionId: tasks.missionId,
      pathManifest: tasks.pathManifest,
      dependsOn: tasks.dependsOn,
      startAt: tasks.startAt,
      category: tasks.category,
      context: tasks.context,
      outputRequirement: tasks.outputRequirement,
      taskClass: tasks.taskClass,
      conflictRetryPrNumber: tasks.conflictRetryPrNumber,
      ciRetryPrNumber: tasks.ciRetryPrNumber,
      reviewerRetryPrNumber: tasks.reviewerRetryPrNumber,
      gitConfig: workspaces.gitConfig,
      workspacePausedUntil: workspaces.newStartsPausedUntil,
      ...queueWaitGateColumns(now),
    })
    .from(tasks)
    .innerJoin(workspaces, eq(workspaces.id, tasks.workspaceId))
    .where(and(inArray(tasks.id, taskIds), eq(tasks.status, 'pending')))
    .limit(QUEUE_WAIT_LIMIT);
  return (rows as Array<Record<string, unknown>>).map(r => {
    const gates: QueueWaitTask['gates'] = {};
    for (const g of QUEUE_WAIT_GATES) if (`g_${g}` in r) gates[g] = truthy(r[`g_${g}`]);
    return {
      id: String(r.id),
      workspaceId: String(r.workspaceId),
      missionId: (r.missionId as string | null) ?? null,
      pathManifest: (r.pathManifest as string[] | null) ?? null,
      dependsOn: (r.dependsOn as string[] | null) ?? null,
      startAt: (r.startAt as Date | null) ?? null,
      category: r.category,
      context: r.context,
      outputRequirement: r.outputRequirement,
      taskClass: (r.taskClass as string | null) ?? null,
      conflictRetryPrNumber: (r.conflictRetryPrNumber as number | null) ?? null,
      ciRetryPrNumber: (r.ciRetryPrNumber as number | null) ?? null,
      reviewerRetryPrNumber: (r.reviewerRetryPrNumber as number | null) ?? null,
      workspace: { gitConfig: (r.gitConfig as WorkspaceGitConfig | null) ?? null },
      workspacePausedUntil: (r.workspacePausedUntil as Date | null) ?? null,
      gates,
    };
  });
}

/** The dependencies the gate still holds each task on, by the claim's own per-edge predicate. */
async function readUnmetDependencies(blocked: QueueWaitTask[]): Promise<Map<string, UnmetDependency[]>> {
  const out = new Map<string, UnmetDependency[]>();
  if (blocked.length === 0) return out;
  const dep = sql`dep_id::uuid`;
  const edges = await db.execute(sql`
    SELECT ${tasks.id} AS dependent_id, dep_id AS dependency_id, ${dependencySatisfied(dep)} AS satisfied
    FROM ${tasks}, jsonb_array_elements_text(COALESCE(${tasks.dependsOn}::jsonb, '[]'::jsonb)) AS dep_id
    WHERE ${inArray(tasks.id, blocked.map(t => t.id))} AND dep_id ~* ${UUID_RE}
  `);
  const unmet = (((edges as unknown) as { rows?: Array<{ dependent_id: string; dependency_id: string; satisfied: unknown }> }).rows ?? [])
    .filter(e => !truthy(e.satisfied));
  const ids = [...new Set(unmet.map(e => e.dependency_id))];
  const rows = ids.length > 0
    ? await db.query.tasks.findMany({ where: sqlWhere(inArray(tasks.id, ids)), columns: { id: true, title: true, status: true } })
    : [];
  const byId = new Map(rows.map(r => [r.id, r]));
  const unmetBy = new Map<string, Set<string>>();
  for (const e of unmet) unmetBy.set(e.dependent_id, (unmetBy.get(e.dependent_id) ?? new Set()).add(e.dependency_id));
  for (const t of blocked) {
    const set = unmetBy.get(t.id);
    if (!set) continue;
    // In the task's own order.
    out.set(t.id, (t.dependsOn ?? []).filter(id => set.has(id)).map(id => ({ id, title: byId.get(id)?.title ?? null, status: (byId.get(id)?.status as string | undefined) ?? null })));
  }
  return out;
}

interface CoordinationReads {
  openPrs: Map<string, OpenPrTask[]>;
  leases: Map<string, Map<string, string[]> | null>;
  missions: Map<string, MissionCoordination & { status: string }>;
  missionActive: Map<string, number>;
  lanes: LaneRead | null;
  live: Set<string>;
}

/** The claim route's own coordination reads, once for every workspace and mission the tasks are in. */
async function readCoordination(list: QueueWaitTask[], now: Date): Promise<CoordinationReads> {
  const [{ loadOpenPrTasksByWorkspace, loadMissionCoordination }, { getActiveClaimsByWorkspace }, { loadLanes }] = await Promise.all([
    import('@/app/api/workers/claim/coordination-snapshot'), import('@buildd/core/path-claim'), import('@/lib/serial-lanes-store'),
  ]);
  const declaring = list.filter(t => (t.pathManifest?.length ?? 0) > 0);
  const wsDeclaring = [...new Set(declaring.map(t => t.workspaceId))];
  const wsLanes = [...new Set(list.filter(t => lanesOf(t as never).length > 0).map(t => t.workspaceId))];
  const missionIds = [...new Set(list.map(t => t.missionId).filter((m): m is string => !!m))];
  const [openPrs, leaseList, missions, lanes] = await Promise.all([
    wsDeclaring.length > 0 ? loadOpenPrTasksByWorkspace(wsDeclaring).catch(() => new Map<string, OpenPrTask[]>()) : Promise.resolve(new Map<string, OpenPrTask[]>()),
    Promise.all(wsDeclaring.map(async ws => [ws, await getActiveClaimsByWorkspace(ws).catch(() => null)] as const)),
    missionIds.length > 0 ? loadMissionCoordination(missionIds).catch(() => null) : Promise.resolve(null),
    wsLanes.length > 0 ? loadLanes(wsLanes, now).catch(() => null) : Promise.resolve(null),
  ]);
  const leases = new Map<string, Map<string, string[]> | null>(leaseList);
  const holders = [...new Set([...leases.values()].flatMap(m => (m ? [...m.keys()] : [])))];
  const liveRows = holders.length > 0
    ? await db.select({ taskId: workers.taskId }).from(workers)
        .where(and(inArray(workers.taskId, holders), inArray(workers.status, [...LIVE_WORKER_STATUSES]))).catch(() => [])
    : [];
  return {
    openPrs,
    leases,
    missions: (missions?.missionClaimMap ?? new Map()) as CoordinationReads['missions'],
    missionActive: missions?.missionActiveCountMap ?? new Map(),
    lanes,
    live: new Set(liveRows.map(r => r.taskId).filter((id): id is string => !!id)),
  };
}

/** Each task's newest fresh claim-loop refusal (deferred or stranded), newest first. Never throws. */
async function readLedger(taskIds: string[], now: Date): Promise<Map<string, LedgerHold>> {
  const out = new Map<string, LedgerHold>();
  if (taskIds.length === 0) return out;
  try {
    const rows = await db
      .select({ taskId: gateEvents.taskId, reason: gateEvents.reason, occurredAt: gateEvents.occurredAt, detail: gateEvents.detail })
      .from(gateEvents)
      .where(and(
        inArray(gateEvents.taskId, taskIds),
        eq(gateEvents.gate, GATE_SLUGS.CLAIM_LOOP_DEFERRAL),
        inArray(gateEvents.outcome, ['deferred', 'stranded']),
        gt(gateEvents.occurredAt, new Date(now.getTime() - LEDGER_FRESH_MS)),
      ))
      .orderBy(desc(gateEvents.occurredAt))
      .limit(Math.min(500, taskIds.length * 5));
    for (const r of rows) {
      if (!r.taskId || out.has(r.taskId)) continue;
      const detail = r.detail && typeof r.detail === 'object' ? (r.detail as Record<string, unknown>) : null;
      out.set(r.taskId, {
        reason: r.reason,
        occurredAt: new Date(r.occurredAt).toISOString(),
        firstDeferredAt: typeof detail?.firstDeferredAt === 'string' ? detail.firstDeferredAt : null,
        detail,
      });
    }
  } catch {
    // No ledger reading: the claim gates still speak.
  }
  return out;
}

/** The bypass flag the claim loop honours on the mission budget gate. */
function bypassesMissionBudget(context: unknown): boolean {
  return hasBypassFlag(context as Record<string, unknown> | null, BYPASS_MISSION_BUDGET_KEY);
}

/**
 * The one wait of each pending task in `taskIds` (non-pending ids are left
 * out). At most `QUEUE_WAIT_LIMIT` tasks. Never throws: an empty map on a
 * failed read.
 */
export async function loadQueueWaits(taskIds: readonly string[], now: Date = new Date()): Promise<Map<string, LoadedQueueWait>> {
  const out = new Map<string, LoadedQueueWait>();
  const ids = [...new Set(taskIds)].slice(0, QUEUE_WAIT_LIMIT);
  if (ids.length === 0) return out;
  try {
    const list = await readTasks(ids, now);
    if (list.length === 0) return out;
    const [deps, coord, holds] = await Promise.all([
      readUnmetDependencies(list.filter(t => refuses(t, 'deps'))).catch(() => new Map<string, UnmetDependency[]>()),
      readCoordination(list, now),
      readLedger(list.map(t => t.id), now),
    ]);
    for (const t of list) {
      const mission = t.missionId ? coord.missions.get(t.missionId) ?? null : null;
      const coordination = evaluateCoordinationGates(t, {
        openPrTasks: coord.openPrs.get(t.workspaceId) ?? [],
        activeClaims: coord.leases.get(t.workspaceId) ?? null,
        mission,
        missionActiveCount: t.missionId ? coord.missionActive.get(t.missionId) ?? 0 : 0,
        // Planner order only orders a claim (soft): it never decides the wait.
        orderedBehind: null,
        liveTaskIds: coord.live,
        now,
        lanes: coord.lanes ? { views: coord.lanes.lanes.get(t.workspaceId) ?? new Map(), releasedTaskIds: coord.lanes.releasedTaskIds } : null,
      });
      out.set(t.id, queueWaitFor(t, {
        unmetDependencies: deps.get(t.id) ?? [],
        coordination,
        missionBudgetExhausted: mission?.status === 'budget_exhausted' && !bypassesMissionBudget(t.context),
        ledger: holds.get(t.id) ?? null,
      }, now));
    }
  } catch (err) {
    console.warn('[queue-wait] read failed; surfaces keep their previous wording:', (err as Error)?.message ?? err);
  }
  return out;
}

/** The one wait per task id, without the reasons. */
export async function loadQueueWaitMap(taskIds: readonly string[], now: Date = new Date()): Promise<Map<string, QueueWait>> {
  const loaded = await loadQueueWaits(taskIds, now);
  return new Map([...loaded].map(([id, l]) => [id, l.wait]));
}
