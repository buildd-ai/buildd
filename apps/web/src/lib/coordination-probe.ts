/**
 * Read-only probe: which coordination gates would the next claim defer this
 * task for, right now? Loads the claim route's own snapshot for the task's
 * workspace and mission (`claim/coordination-snapshot`) and evaluates the
 * claim route's own predicates (`claim/coordination-gates`), so `/start` can
 * refuse with the real blocker instead of accepting a start no runner will
 * take.
 *
 * Dependency and soft-overlap holds are fed from what `explain` already
 * reports (`loadTaskCoordinationHolds`, lib/coordination-holds.ts): an
 * inferred (creation-time overlap) edge is a coordination hold a person may
 * force past, a declared edge is a dependency no force lifts. Whether an edge
 * still holds is the claim's own SQL predicate (`dependencySatisfied`), and a
 * soft overlap is the claim's own `evaluateSoftOverlaps`.
 *
 * Never throws: a probe failure returns `null` (unknown) and the caller falls
 * back to today's behaviour rather than blocking a start on a read error.
 */
import { db } from '@buildd/core/db';
import { gateEvents, tasks, workers } from '@buildd/core/db/schema';
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { getActiveClaimsByWorkspace } from '@buildd/core/path-claim';
import { makeWaitingReason, orderWaitingReasons, overlapAreas, type WaitingReason } from '@buildd/core/waiting-reason';
import { loadTaskCoordinationHolds } from '@/lib/coordination-holds';
import type { CoordinationHold } from '@/lib/explain-coordination';
import { dependencySatisfied } from '@/app/api/workers/claim/deps-gate';
import { evaluateSoftOverlaps, readSoftOverlaps } from '@/app/api/workers/claim/soft-overlap-gate';
import { loadSoftOverlapHolders } from '@/app/api/workers/claim/soft-overlap-store';
import { touchesHardOverlapSurface } from '@/app/api/workers/claim/hold-start-shadow';
import { checkMissionLocal } from '@/app/api/workers/claim/held-gate';
import { BYPASS_DEPS_GATE_KEY, BYPASS_HELD_GATE_KEY, hasBypassFlag } from '@/lib/bypass-flags';
import { evaluateCoordinationGates } from '@/app/api/workers/claim/coordination-gates';
import { loadMissionCoordination, loadOpenPrTasksByWorkspace } from '@/app/api/workers/claim/coordination-snapshot';
import { ORDERED_BEHIND_REASON } from '@/app/api/workers/claim/claim-plan-store';
import { GATE_SLUGS } from '@buildd/core/gate-events';
import { LIVE_WORKER_STATUSES } from '@buildd/shared';

/**
 * `ordered_behind` is written once per (task, blocker), never refreshed, so
 * the blocker's liveness is what says it still applies; this only bounds the read.
 */
const ORDERED_BEHIND_FRESH_MS = 6 * 60 * 60 * 1000;

export interface ProbeTask {
  id: string;
  workspaceId: string;
  missionId?: string | null;
  pathManifest?: unknown;
  category?: unknown;
  context?: unknown;
  outputRequirement?: unknown;
  [k: string]: unknown;
}

export interface ProbeOptions {
  /** Skip the local-mission reason (the caller already lifted or reported it). */
  skipMissionLocal?: boolean;
}

export async function probeCoordination(task: ProbeTask, now: Date = new Date(), opts: ProbeOptions = {}): Promise<WaitingReason[] | null> {
  try {
    const missionId = (task.missionId as string | null) ?? null;
    const [openPrByWs, activeClaims, missionData, orderedRow] = await Promise.all([
      loadOpenPrTasksByWorkspace([task.workspaceId]),
      getActiveClaimsByWorkspace(task.workspaceId).catch(() => null),
      missionId ? loadMissionCoordination([missionId]) : Promise.resolve(null),
      db.select({ detail: gateEvents.detail, occurredAt: gateEvents.occurredAt })
        .from(gateEvents)
        .where(and(
          eq(gateEvents.taskId, task.id),
          eq(gateEvents.gate, GATE_SLUGS.CLAIM_LOOP_DEFERRAL),
          eq(gateEvents.reason, ORDERED_BEHIND_REASON),
          gte(gateEvents.occurredAt, new Date(now.getTime() - ORDERED_BEHIND_FRESH_MS)),
        ))
        .orderBy(desc(gateEvents.occurredAt))
        .limit(1)
        .then(rows => rows[0] ?? null)
        .catch(() => null),
    ]);

    const orderedDetail = (orderedRow?.detail ?? null) as Record<string, unknown> | null;
    const orderedBehind = typeof orderedDetail?.blockedBy === 'string'
      ? {
          blockedBy: orderedDetail.blockedBy,
          edge: typeof orderedDetail.edge === 'string' ? orderedDetail.edge : null,
          since: orderedRow?.occurredAt ? new Date(orderedRow.occurredAt).toISOString() : null,
        }
      : null;

    const candidateHolders = [
      ...(activeClaims ? [...activeClaims.keys()] : []),
      ...(orderedBehind ? [orderedBehind.blockedBy] : []),
    ].filter(id => id !== task.id);
    const liveRows = candidateHolders.length > 0
      ? await db.query.workers.findMany({
          where: and(inArray(workers.taskId, candidateHolders), inArray(workers.status, [...LIVE_WORKER_STATUSES])),
          columns: { taskId: true },
        })
      : [];

    const reasons = evaluateCoordinationGates(task, {
      openPrTasks: openPrByWs.get(task.workspaceId) ?? [],
      activeClaims,
      mission: missionId ? (missionData?.missionClaimMap.get(missionId) ?? null) : null,
      missionActiveCount: missionId ? (missionData?.missionActiveCountMap.get(missionId) ?? 0) : 0,
      missionAdvisoryInFlight: missionId ? (missionData?.missionAdvisoryInFlight.get(missionId) ?? null) : null,
      orderedBehind,
      liveTaskIds: new Set(liveRows.map(r => r.taskId).filter((id): id is string => !!id)),
      now,
    });
    const [depReasons, softReasons, localReason] = await Promise.all([
      dependencyReasons(task),
      softOverlapReasons(task),
      opts.skipMissionLocal ? Promise.resolve(null) : missionLocalReason(task),
    ]);
    return await withTaskLabels(orderWaitingReasons([
      ...(localReason ? [localReason] : []),
      ...depReasons,
      ...softReasons,
      ...reasons,
    ]));
  } catch (err) {
    console.warn(`[coordination-probe] task ${task.id}: probe failed, start proceeds unprobed:`, (err as Error)?.message ?? err);
    return null;
  }
}

/** Replace "task 1a2b3c4d" blocker labels with the blocker's title. */
async function withTaskLabels(reasons: WaitingReason[]): Promise<WaitingReason[]> {
  const ids = [...new Set(reasons.filter(r => r.blocker?.type === 'task').map(r => r.blocker!.id))];
  if (ids.length === 0) return reasons;
  const rows = await db.query.tasks.findMany({ where: inArray(tasks.id, ids), columns: { id: true, title: true } }).catch(() => []);
  const titles = new Map(rows.map(r => [r.id, r.title as string | null]));
  return reasons.map(r => {
    const title = r.blocker?.type === 'task' ? titles.get(r.blocker.id) : null;
    if (!title) return r;
    const label = title.length > 60 ? `${title.slice(0, 57)}…` : title;
    return { ...r, blocker: { ...r.blocker!, label: `“${label}”` } };
  });
}


const DEP_CAP = 25;
const LIVE_TASK_STATUSES = new Set(['assigned', 'in_progress']);

function holdOverlap(paths: string[], overlapKind: string | null) {
  return {
    areas: overlapAreas(paths),
    pathCount: paths.length,
    paths: paths.slice(0, 50),
    basis: 'declared' as const,
    ...(overlapKind ? { overlapKind } : {}),
  };
}

/**
 * Dependency edges that still hold: declared → `dep_declared` (never
 * forceable), inferred → `dep_inferred` (coordination; forceable for claim
 * order). "Still holds" is the claim route's own per-edge SQL predicate.
 */
async function dependencyReasons(task: ProbeTask): Promise<WaitingReason[]> {
  const deps = ((task.dependsOn as string[] | null) ?? []).filter(id => id !== task.id).slice(0, DEP_CAP);
  if (deps.length === 0) return [];
  if (hasBypassFlag(task.context as Record<string, unknown> | null, BYPASS_DEPS_GATE_KEY)) return [];
  const [holds, satisfied] = await Promise.all([
    loadTaskCoordinationHolds({ ...(task as any), status: 'pending' }).catch(() => [] as CoordinationHold[]),
    unsatisfiedDeps(task.id, deps),
  ]);
  const byId = new Map(holds.filter(h => h.holderTaskId).map(h => [h.holderTaskId!, h]));
  const inferred = new Set(((task.pathDeclaration as { inferredDependsOn?: unknown } | null)?.inferredDependsOn as string[] | undefined) ?? []);
  const out: WaitingReason[] = [];
  for (const id of deps) {
    if (!satisfied.has(id)) continue;
    const h = byId.get(id);
    const isInferred = h ? h.edge === 'inferred_dependency' : inferred.has(id);
    const blocker = {
      type: 'task' as const,
      id,
      label: `task ${id.slice(0, 8)}`,
      href: `/app/tasks/${id}`,
      live: LIVE_TASK_STATUSES.has(h?.holderStatus ?? ''),
    };
    if (isInferred) {
      const paths = h?.paths ?? [];
      const kind = h?.overlapKind ?? null;
      out.push(makeWaitingReason('dep_inferred', {
        because: paths.length === 0
          ? 'it was ordered after this task when both declared overlapping files'
          : `${kind === 'migration' ? 'both change migrations in' : `both edit ${paths.length} file${paths.length === 1 ? '' : 's'} in`} ${overlapAreas(paths).slice(0, 2).map(a => a.area).join(', ')}`,
        blocker,
        overlap: holdOverlap(paths, kind),
        provenance: { source: 'task_context', derivedFrom: 'tasks.pathDeclaration.inferredDependsOn' },
      }));
    } else {
      out.push(makeWaitingReason('dep_declared', {
        because: 'it was declared as a dependency',
        blocker,
        provenance: { source: 'task_context', derivedFrom: 'tasks.dependsOn' },
      }));
    }
  }
  return out;
}

/** The dependency ids the claim's dependency gate would still hold this task on. */
async function unsatisfiedDeps(taskId: string, deps: string[]): Promise<Set<string>> {
  const cols = Object.fromEntries(deps.map((id, i) => [`d${i}`, sql<boolean>`${dependencySatisfied(sql`${id}::uuid`)}`]));
  const rows = await db.select(cols as Record<string, ReturnType<typeof sql<boolean>>>).from(tasks).where(eq(tasks.id, taskId)).limit(1);
  const row = (rows[0] ?? {}) as Record<string, unknown>;
  return new Set(deps.filter((_, i) => row[`d${i}`] !== true && row[`d${i}`] !== 't'));
}

/**
 * Soft overlaps (pathDeclaration.softOverlaps) the claim would hold on: the
 * claim's own `evaluateSoftOverlaps`. A deterministic hold (migration / hard
 * surface) is `serialized_surface`; an advisory one is `soft_overlap`, hard
 * when the newest claim verdict was HOLD, else ordering-only (the rule or Jev
 * may still start it).
 */
async function softOverlapReasons(task: ProbeTask): Promise<WaitingReason[]> {
  const entries = readSoftOverlaps(task.pathDeclaration);
  if (entries.length === 0) return [];
  const holders = await loadSoftOverlapHolders([...new Set(entries.map(e => e.taskId))]).catch(() => null);
  const gitConfig = (task as { workspace?: { gitConfig?: unknown } }).workspace?.gitConfig ?? null;
  const verdicts = evaluateSoftOverlaps(task as any, holders, {
    isHardSurface: (paths, kind) => touchesHardOverlapSurface(paths, kind, gitConfig as any),
  });
  if (verdicts.length === 0) return [];
  const lastVerdict = await latestSoftVerdicts(task.id);
  return verdicts.map(v => {
    const blocker = { type: 'task' as const, id: v.holderTaskId, label: `task ${v.holderTaskId.slice(0, 8)}`, href: `/app/tasks/${v.holderTaskId}`, live: true };
    const overlapKind = v.kind === 'deterministic' ? v.overlapKind : v.overlapKind;
    const areas = overlapAreas(v.paths).slice(0, 2).map(a => a.area).join(', ');
    const because = v.kind === 'deterministic' && v.overlapKind === 'migration'
      ? `both change migrations in ${areas}`
      : `both edit ${v.paths.length} file${v.paths.length === 1 ? '' : 's'} in ${areas}`;
    if (v.kind === 'deterministic') {
      return makeWaitingReason('serialized_surface', {
        because, blocker,
        overlap: holdOverlap(v.paths, overlapKind),
        provenance: { source: 'probe', derivedFrom: 'tasks.pathDeclaration.softOverlaps (claim soft_overlap, deterministic)' },
      });
    }
    return makeWaitingReason('soft_overlap', {
      because, blocker,
      overlap: holdOverlap(v.paths, overlapKind),
      strength: lastVerdict.get(v.holderTaskId) === 'HOLD' ? 'hard' : 'soft',
      provenance: { source: 'ledger', derivedFrom: 'gate_events#claim_loop_deferral/soft_overlap' },
    });
  });
}

/** Newest `soft_overlap` claim verdict per holder, from the ledger. */
async function latestSoftVerdicts(taskId: string): Promise<Map<string, string>> {
  const rows = await db.select({ detail: gateEvents.detail })
    .from(gateEvents)
    .where(and(eq(gateEvents.taskId, taskId), eq(gateEvents.gate, GATE_SLUGS.CLAIM_LOOP_DEFERRAL), eq(gateEvents.reason, 'soft_overlap')))
    .orderBy(desc(gateEvents.occurredAt))
    .limit(20)
    .catch(() => [] as Array<{ detail: unknown }>);
  const out = new Map<string, string>();
  for (const r of rows) {
    const d = (r.detail ?? {}) as { holderTaskId?: unknown; verdict?: unknown };
    if (typeof d.holderTaskId === 'string' && typeof d.verdict === 'string' && !out.has(d.holderTaskId)) out.set(d.holderTaskId, d.verdict);
  }
  return out;
}

/** A local mission's task: runners never claim it unless a person hands it over. */
async function missionLocalReason(task: ProbeTask): Promise<WaitingReason | null> {
  const missionId = (task.missionId as string | null) ?? null;
  if (!missionId) return null;
  if (hasBypassFlag(task.context as Record<string, unknown> | null, BYPASS_HELD_GATE_KEY)) return null;
  if (!(await checkMissionLocal(missionId).catch(() => false))) return null;
  return makeWaitingReason('mission_local', {
    because: 'its mission runs in a person\'s own session, so runners do not pick up its tasks',
    blocker: { type: 'mission', id: missionId, label: 'a local-session mission', href: `/app/missions/${missionId}` },
    provenance: { source: 'probe', derivedFrom: "missions.executor='local'" },
  });
}
