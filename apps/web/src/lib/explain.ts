/**
 * `explain` — the deterministic read behind the MCP action of the same name.
 *
 * One question, four scopes (task / mission / workspace / PR), one response
 * shape. It answers "what state is this in, what is it waiting on, and what is
 * the evidence" by reading authoritative rows and running the derivations that
 * already own each axis. There is no model call anywhere in this module, by
 * design: the caller narrates, `explain` supplies facts with provenance.
 *
 * Two consequences of "deterministic" that are easy to get wrong and are
 * enforced here:
 *
 * - `canCompleteMission` is called with `evaluateCriteria: false`. The default
 *   PULLS a verdict when none exists, which dispatches verification tasks and
 *   spends tokens — correct for the completion path, wrong for a read.
 * - The conflicted-PR chain never shells out to a merge attempt. Both touch
 *   sets are already stored (`workers.observedTouches`, `tasks.pathManifest`).
 *
 * State comes from `deriveMissionStateView`, which owns the precedence between
 * the five underlying derivations. This module does not decide what a state is;
 * it only supplies the accessor's inputs and turns its answer into evidence.
 */
import { loadQuestionWaits } from './question-waits';
import { isOpenAsk, missionOpenQuestions } from './open-ask';
import { loadTaskAccess } from './agent-capabilities/access-log';
import { BACKEND_ROUTING_KEY, describeBackendRouting } from '@buildd/core/backend-policy';
import { OPEN_TASK_STATUSES as SHARED_OPEN_TASK_STATUSES, LIVE_WORKER_STATUSES as SHARED_LIVE_WORKER_STATUSES, VISUAL_AUDITOR_ROLE_SLUG, INTERACTIVE_WORKER_RUNNER, RUNNER_RECENTLY_SEEN_MS, type QueueWait, type TaskEvidence, type TaskMismatch } from '@buildd/shared';
import { loadRunnerBeats, offlineRunnerWaitLine, runnerLiveness, type RunnerLiveness } from '@/lib/runner-offline';
import { isWorktreeSetupTimeoutError } from '@/lib/worker-exit-taxonomy';
import { collectLineage } from '@/lib/attempt-lineage';
import { evidenceHint } from '@/lib/task-evidence';
import { loadInlineEvidence, type InlineEvidenceObject } from '@/lib/evidence-inline';
import type { EvidenceActor } from '@/lib/evidence-audit';
import { db } from '@buildd/core/db';
import { missions, tasks, workers, gateEvents, workspaces } from '@buildd/core/db/schema';
import { and, desc, eq, gt, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import { deriveCriteriaGatePresentation, attachAttempts, isDeliverableTask } from '@buildd/core/mission-helpers';
import { deriveTaskHealthSignal, foreignDependencyIds, unmetDependencyIds, unmetDependencyPrs, type DependencyRow } from '@/lib/mission-helpers';
import { continueOnRunnerBlockedReason, deriveLocalStrand } from '@/lib/local-strand';
import { loadDependencyRows } from '@/lib/dependency-rows';
import { resolveDependencyHolders, type DependencyHolder, type DependencyViewer } from '@/lib/task-dependency-reach';
import { resolvePrDisplayState } from '@/lib/pr-presentation';
import { deliverySettled } from '@/lib/workflow/delivery-display';
import type { DeliveryView } from '@/lib/workflow/projections';
import { GATE_SLUGS } from '@buildd/core/gate-slugs';
import { deriveLandingBlocker, type LandingBlocker } from '@/lib/landing-blocker';
import { canCompleteMission } from '@/lib/mission-completion';
import { evaluateMissionGate } from '@/lib/mission-dependency';
import { classifyMissionWait, type WaitClassifiableTask } from '@/lib/heartbeat-prepass';
import { evaluateMissionWorkState } from '@/lib/mission-pr';
import { presentMissionState } from '@/lib/mission-state-presentation';
import { deriveMissionStateView, type MissionStateInput, type MissionStateView } from '@/lib/mission-state-view';
import { computeSupersededFailedTasks } from '@/lib/mission-task-superseded';
import { getDeliveryViewsForTasks, kernelDeliveryOwnerForPr, replacedFailedTaskIds } from '@/lib/workflow/delivery-view';
import { missionEpochsOf } from '@/lib/workflow/delivery-ship';
import { deliveryDisagreements, overlayDeliveryLifecycle, type DeliveryDisagreement } from '@/lib/delivery-overlay';
import { attemptLine } from '@/lib/workflow/projections';
import { loadClaimHolds, loadMissionClaimDeferrals, type ClaimHoldFacts } from '@/lib/mission-claim-deferrals';
import { derivePendingTaskHold, type HolderSourceRow, type PendingHolderFacts, type PendingTaskHoldInput } from '@/lib/mission-task-hold';
import { isMissionAuditTask } from '@buildd/core/surface-audit';
import { openCriteriaChecks, summarizeVisualReview } from '@/lib/mission-open-checks';
import { isBuildComplete } from '@/lib/mission-checks';
import { deriveMissionIntegrationPr } from '@/lib/mission-integration-pr';
import { missionCardProgress, ownerUnmergedPrs, type MissionCardTaskRow } from '@/lib/mission-card-view';
import { REPO_WIDE_SENTINEL } from '@buildd/core/path-overlap';
import { coordinationGateDetail, coordinationLink, hiddenHold, latestOverlapStarts, overlapStartLink, type CoordinationHold } from '@/lib/explain-coordination';
import { loadCoordinationHolds, type HoldTask } from '@/lib/coordination-holds';
import { latestDispatchForTask } from '@buildd/core/dispatch-outbox';
import { loadBrowserRunnerHeartbeats, loadRunnerOnlineByWorkspace } from './runner-heartbeats';
import { browserRunnerOnline } from './visual-audit-runner';
import { deriveCiRedChains } from './ci-red-chain';
import {
  buildStateBecause,
  buildConflictBecause,
  deliveryTransitionLink,
  reviewRoundLink,
  deliveryDisagreementLink,
  dispatchWakeLink,
  withDispatchLink,
  entitlementHoldLink,
  taskRecoveryLink,
  offlineRunnerLink,
  type BaseSideMerge,
  type StateBecauseExtras,
  type ConflictSubject,
  type TouchSource,
} from '@/lib/explain-because';
import {
  orderChain,
  rankGatedSubjects,
  type ExplainAnswer,
  type ExplainResult,
  type HistoryNode,
  type GateHistoryEntry,
} from '@/lib/explain-types';
import { sqlOrderBy, sqlOrderByFn, sqlWhere } from '@buildd/core/db/relational-sql';

/** How many recent gate_events rows a task's `explain` answer carries. */
const GATE_HISTORY_LIMIT = 10;

/**
 * Recent gate_events rows for a task — deferrals, rejections, warnings, and
 * strandings, newest first. This is the durable half of the claim loop's
 * per-poll `deferrals` counters (which die with the response object) made
 * readable without SQL.
 */
async function loadGateHistory(taskId: string): Promise<GateHistoryEntry[]> {
  return (await loadGateRows(taskId)).map(r => r.entry);
}

async function loadGateRows(taskId: string): Promise<Array<{ entry: GateHistoryEntry; detail: unknown }>> {
  const rows = await db.query.gateEvents.findMany({
    where: sqlWhere(eq(gateEvents.taskId, taskId)),
    orderBy: sqlOrderBy([desc(gateEvents.occurredAt)]),
    limit: GATE_HISTORY_LIMIT,
    columns: { occurredAt: true, gate: true, outcome: true, reason: true, detail: true },
  });
  return rows.map(r => {
    const detail = r.detail as Record<string, unknown> | null;
    const holder = coordinationGateDetail(detail);
    return {
      entry: {
        occurredAt: r.occurredAt.toISOString(),
        gate: r.gate,
        outcome: r.outcome as GateHistoryEntry['outcome'],
        reason: r.reason,
        consecutiveDeferrals: typeof detail?.consecutiveDeferrals === 'number' ? detail.consecutiveDeferrals : null,
        firstDeferredAt: typeof detail?.firstDeferredAt === 'string' ? detail.firstDeferredAt : null,
        ...(holder ? { holder } : {}),
      },
      detail,
    };
  });
}

// ─── R-14: why a pending row is not running ───────────────────────────────────

const holdStr = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/** The task an overlap deferral recorded as the blocker, when it named one. */
function deferralBlockerId(h: ClaimHoldFacts | undefined): string | null {
  return holdStr(h?.detail?.blockingTaskId) ?? holdStr(h?.detail?.holderTaskId);
}

/** The task a queue wait names: its declared dependency, its lane's holder, or the one ahead of it. */
function waitBlockerId(w: QueueWait | undefined): string | null {
  if (!w) return null;
  return w.kind === 'declared' ? w.blockerId ?? null : w.kind === 'lane' ? w.holderTaskId ?? w.aheadTaskId ?? null : null;
}

/**
 * The one reason each pending row waits, read live from the claim route's own
 * query and gates (lib/queue-wait-load.ts; spec: Overlap scheduling, AC-10).
 * Loaded lazily, like the holder loader below. A failed read is an empty map:
 * the rows then keep the ledger reading.
 */
async function loadWaits(ids: readonly string[]): Promise<Map<string, QueueWait>> {
  if (ids.length === 0) return new Map();
  const { loadQueueWaitMap } = await import('@/lib/queue-wait-load');
  return loadQueueWaitMap(ids).catch(() => new Map<string, QueueWait>());
}

/**
 * The holder loader, loaded at call time: a static edge from this module
 * into the db-backed loader reshaped the server chunk graph into a Turbopack
 * output-path collision (two unrelated lib chunks with one name), the same
 * failure answer-attempt.ts met; a lazy edge keeps the graph as it was.
 */
async function loadHolders(ids: readonly string[], known: ReadonlyMap<string, HolderSourceRow>): Promise<Map<string, PendingHolderFacts>> {
  if (ids.length === 0) return new Map();
  const { loadPendingHolderFacts } = await import('@/lib/mission-task-hold-load');
  return loadPendingHolderFacts(ids, known);
}

/** A loaded row in the shape the holder loader reads, so a known holder costs no query. */
function holderSourceRows(rows: Iterable<[string, DependencyRow | LoadedTask]>): Map<string, HolderSourceRow> {
  const out = new Map<string, HolderSourceRow>();
  for (const [id, r] of rows) {
    const reach = r as DependencyRow;
    out.set(id, {
      id, title: r.title ?? null, status: r.status, startAt: (r as LoadedTask).startAt ?? null, workers: r.workers ?? [],
      ...(reach.hidden ? { hidden: true } : {}),
      ...(reach.workspaceName ? { workspaceName: reach.workspaceName } : {}),
    });
  }
  return out;
}

/**
 * A holder as the caller may be told about it: one it cannot see keeps only
 * its id (never rendered) and the mark, so no note, state or title reaches
 * the answer (spec e28018c2 R-6, R-7).
 */
function holderForViewer(f: PendingHolderFacts, reach: { hidden?: boolean; workspaceName?: string | null } | DependencyHolder | undefined): PendingHolderFacts {
  if (reach?.hidden) return { id: f.id, title: null, hidden: true };
  return reach?.workspaceName ? { ...f, workspaceName: reach.workspaceName } : f;
}

/**
 * The facts `derivePendingTaskHold` reads for one pending row: its newest
 * refusal with the blocker it named, its unmet dependencies as holder facts,
 * its schedule. Empty for a row that is not pending.
 */
function pendingRowFacts(
  t: LoadedTask,
  holds: ReadonlyMap<string, ClaimHoldFacts>,
  unmetDeps: readonly string[],
  holders: ReadonlyMap<string, PendingHolderFacts>,
  waits: ReadonlyMap<string, QueueWait> = new Map(),
): Pick<PendingTaskHoldInput, 'deferral' | 'dependencies' | 'createdAt' | 'startAt' | 'budgetExhausted' | 'wait'> & { queueWait?: QueueWait | null } {
  if (t.status !== 'pending') return {};
  const h = holds.get(t.id);
  const w = waits.get(t.id) ?? null;
  return {
    wait: w,
    queueWait: w,
    deferral: h ? { reason: h.reason, firstDeferredAt: h.firstDeferredAt, detail: h.detail } : null,
    dependencies: unmetDeps.map(id => holders.get(id)).filter((f): f is PendingHolderFacts => !!f),
    createdAt: t.createdAt,
    startAt: t.startAt,
    budgetExhausted: (t.context as Record<string, unknown> | null)?.budgetExhausted === true,
  };
}

/** The hold as the because[] chain prints it. */
function pendingHoldSummary(input: PendingTaskHoldInput): NonNullable<NonNullable<StateBecauseExtras['openTasks']>[number]['pendingHold']> {
  const h = derivePendingTaskHold(input);
  return { row: h.row, kind: h.kind, holder: h.holder, ...(h.fromClaimGates ? { fromClaimGates: true } : {}) };
}

/** The mission's base is red (a delivery is BLOCKED_ON_TRUNK): queued work reads `merges paused`. */
function trunkRedOf(deliveries: ReadonlyMap<string, DeliveryView>, loaded: readonly LoadedTask[], fallback: string | null): { branch: string } | null {
  for (const [taskId, d] of deliveries) {
    if (d.state !== 'BLOCKED_ON_TRUNK') continue;
    const base = loaded.find(t => t.id === taskId)?.workers?.find(w => w.prBaseRef)?.prBaseRef ?? fallback ?? 'trunk';
    return { branch: base };
  }
  return null;
}

/** Who holds a pending task, and why (lib/coordination-holds.ts). A failure omits it. */
function loadCoordination(
  task: HoldTask,
  gateRows: Array<{ entry: GateHistoryEntry; detail: unknown }>,
): Promise<CoordinationHold[]> {
  return loadCoordinationHolds(task, gateRows.map(r => ({ reason: r.entry.reason, detail: r.detail })));
}

/** Cap on how many gated subjects a workspace answer returns. */
const WORKSPACE_SUBJECT_LIMIT = 12;
/** Cap on base-side merges examined for a conflicted PR. */
const BASE_SIDE_LIMIT = 40;
/**
 * Cap on concurrent `explainMission`/`explainTask` calls during workspace
 * fan-out. Each call is several DB round trips, so unbounded `Promise.all`
 * over up to 200 missions/tasks would spike Neon HTTP-driver fan-out; a
 * sequential loop, the other extreme, made a single busy workspace's
 * `GET /api/explain` call slow. This bounds both.
 */
const WORKSPACE_FANOUT_CONCURRENCY = 8;

/**
 * Runs `fn` over `items` with at most `limit` in flight at once. Results are
 * returned in input order regardless of completion order.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (let i = next++; i < items.length; i = next++) {
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Cap on active missions scanned per workspace answer — mirrors the orphan-tasks cap below. */
const MISSION_SCAN_LIMIT = 200;

// ─── Shared loading ───────────────────────────────────────────────────────────

type LoadedTask = {
  id: string;
  title: string;
  status: string;
  roleSlug?: string | null;
  mode: string | null;
  kind: string | null;
  taskClass: string;
  parentTaskId: string | null;
  creationSource: string | null;
  category: string | null;
  subjectPrNumber: number | null;
  pathManifest: string[] | null;
  context: Record<string, unknown> | null;
  startAt: Date | null;
  loopConfig: unknown;
  loopState: unknown;
  result: unknown;
  createdAt: Date | null;
  updatedAt?: Date | null;
  dependsOn?: string[] | null;
  workers: Array<{
    id: string;
    status: string;
    prNumber: number | null;
    prUrl: string | null;
    branch: string | null;
    prBaseRef: string | null;
    prLifecycleStatus: string | null;
    mergedAt: Date | null;
    observedTouches: string[] | null;
    error: string | null;
    startedAt: Date | null;
    waitingFor?: unknown;
    supersededByPrNumber: number | null;
    supersededByPrUrl: string | null;
    supersededReason: string | null;
    abandonedAt?: Date | null;
    abandonedReason?: string | null;
    supersessionScan?: import('@buildd/core/pr-shipped').SupersessionScan | null;
    /** The runner this worker ran under, for the offline-runner wait (lib/runner-offline.ts). */
    runner?: string | null;
    localUiUrl?: string | null;
    accountId?: string | null;
    parkedUntil?: Date | null;
    leaseExpiresAt?: Date | null;
  }>;
};

const TASK_COLUMNS = {
  id: true, title: true, status: true, roleSlug: true, mode: true, kind: true, taskClass: true,
  parentTaskId: true, creationSource: true, category: true, subjectPrNumber: true,
  pathManifest: true, context: true, startAt: true, loopConfig: true, loopState: true,
  result: true, createdAt: true, updatedAt: true, dependsOn: true,
} as const;

/**
 * Newest worker first — the same "latest worker per task" rule the PR
 * predicates use, so `workers[0]` means the same thing everywhere.
 */
const WORKER_WITH = {
  columns: {
    id: true, status: true, prNumber: true, prUrl: true, branch: true,
    prBaseRef: true, prLifecycleStatus: true, mergedAt: true,
    observedTouches: true, error: true, startedAt: true,
    // The session heartbeat `deriveLocalStrand` reads, and the PR grace window.
    updatedAt: true, completedAt: true,
    supersededByPrNumber: true, supersededByPrUrl: true, supersededReason: true,
    abandonedAt: true, abandonedReason: true, supersessionScan: true,
    // A worker parked on a question: what it asked (`missionOpenQuestions`).
    waitingFor: true,
    // Which runner a live worker is under, so a task whose runner went quiet
    // reads as waiting on that runner rather than RUNNING (`offlineRunnerWaitFor`).
    runner: true, localUiUrl: true, accountId: true, parkedUntil: true, leaseExpiresAt: true,
  },
  orderBy: sqlOrderBy([desc(workers.startedAt)]),
};

/**
 * A live-status worker whose own runner has gone quiet (lib/runner-offline.ts):
 * past the "demonstrably up" window the task is not RUNNING, it is waiting
 * for that runner to be confirmed dead, after which the offline-runner reaper
 * requeues it. Null when the runner is fine, the worker is interactive or
 * parked, or nothing can be judged (an unreadable heartbeat table is not
 * evidence of anything).
 */
async function offlineRunnerWaitFor(w: LoadedTask['workers'][number] | undefined, now: Date): Promise<RunnerLiveness | null> {
  if (!w || !(w.status === 'running' || w.status === 'starting' || w.status === 'idle')) return null;
  if (w.runner === INTERACTIVE_WORKER_RUNNER || !w.accountId) return null;
  if (w.parkedUntil && new Date(w.parkedUntil).getTime() > now.getTime()) return null;
  const beats = await loadRunnerBeats(w.accountId).catch(() => null);
  if (!beats) return null;
  const liveness = runnerLiveness(w, beats, now);
  if (liveness.verdict === 'dead' || liveness.verdict === 'unvouched') return liveness;
  return liveness.verdict === 'live' && liveness.silentMs !== null && liveness.silentMs >= RUNNER_RECENTLY_SEEN_MS ? liveness : null;
}

/** The answer's headline and next action say what the task waits on: the runner's death, not RUNNING. */
function withOfflineRunnerWait(answer: ExplainAnswer, wait: RunnerLiveness | null): ExplainAnswer {
  if (!wait) return answer;
  const line = offlineRunnerWaitLine(wait);
  const headline = `${line.charAt(0).toUpperCase()}${line.slice(1).split(':')[0]}.`;
  return {
    ...answer,
    nextAction: line,
    situation: { ...answer.situation, headline, nextAction: line },
    derivedFrom: { ...answer.derivedFrom, nextAction: 'workers.runner + workerHeartbeats.lastHeartbeatAt' },
  };
}

const LIVE_WORKER_STATUSES = new Set<string>(SHARED_LIVE_WORKER_STATUSES);
const OPEN_TASK_STATUSES = new Set<string>(SHARED_OPEN_TASK_STATUSES);

/** Unknown reads stay unknown; local-session missions do not need runner eligibility. */
async function missingBrowserFor(rows: LoadedTask[], workspaceId: string | null, local: boolean): Promise<boolean> {
  if (local || !workspaceId || !rows.some(t => t.roleSlug === VISUAL_AUDITOR_ROLE_SLUG && t.status === 'pending' && !hasLiveWorker(t))) return false;
  try {
    const ws = await db.query.workspaces.findFirst({
      where: sqlWhere(eq(workspaces.id, workspaceId)),
      columns: { id: true, teamId: true, accessMode: true, gitConfig: true, webhookConfig: true },
    });
    if (!ws) return false;
    const now = Date.now();
    const hbs = await loadBrowserRunnerHeartbeats(ws, now);
    return hbs !== null && !browserRunnerOnline(hbs, workspaceId, now);
  } catch {
    return false;
  }
}

/** `false` only when the lookup succeeded and no runner can claim here; unknown and local-session missions stay undefined. */
async function runnerOnlineFor(rows: LoadedTask[], workspaceId: string | null, local: boolean): Promise<boolean | undefined> {
  if (local || !workspaceId || !rows.some(t => t.status === 'pending')) return undefined;
  return (await loadRunnerOnlineByWorkspace([workspaceId])).get(workspaceId);
}

/** True when a worker in a live status is on this row — the per-task half of `activeAgents`. */
function hasLiveWorker(t: { workers?: Array<{ status: string }> | null }): boolean {
  return (t.workers ?? []).some(w => LIVE_WORKER_STATUSES.has(w.status));
}

/** True when this row's worker is parked on a question for a person. */
function hasOpenAsk(t: { status: string; workers?: Array<{ status: string }> | null }): boolean {
  return (t.workers ?? []).some(w => isOpenAsk(t.status, w.status));
}

/** The canonical "is a fix attempt open on this task" descriptor — see mission-state-view.ts rule 6½. */
/**
 * A failed task whose failure is the host's, not the work's: retries spent on
 * infra (`infra_stalled`), or the runner could not build the session's
 * worktree (it refuses the shared clone, so nothing ran). Read from the error
 * text as well as `errorType`, because a setup failure reported before the
 * retry budget is spent carries only the text.
 */
export function isInfraFailedTask(t: { result?: unknown; context?: unknown }): boolean {
  const result = (t.result ?? null) as Record<string, unknown> | null;
  if (result?.errorType === 'infra_stalled') return true;
  const ctx = (t.context ?? null) as { failureContext?: { summary?: unknown } } | null;
  const texts = [result?.error, ctx?.failureContext?.summary];
  return texts.some(x => typeof x === 'string' && (isWorktreeSetupTimeoutError(x) || /Worktree setup failed for branch .*refusing to run in the shared clone/s.test(x)));
}

export interface OpenAttemptInfo {
  taskId: string;
  title: string;
  status: string;
  iteration: number | null;
  maxIterations: number | null;
  claimed: boolean;
  /** 00d288fd: a reviewer is a review, never a fix (its `iteration` is the round, not a fix attempt). */
  kind?: 'review' | 'fix';
}

/**
 * The newest OPEN fix attempt (builder-after-review, CI retry) among a task's
 * children. While one is open the PR is about to change, so it — not a merge —
 * is what the task is waiting on. The single definition every surface that
 * needs this fact reads: `viewForTask` (this module), and any caller outside
 * explain.ts via {@link loadOpenAttempt}. Do not re-derive this predicate
 * elsewhere — see the task-detail PR card and the Home action queue for two
 * callers that used to each have their own partial version of it.
 */
function deriveOpenAttempt(attempts: LoadedTask[]): OpenAttemptInfo | null {
  const openAttemptRow = attempts
    .filter(a => a.taskClass === 'attempt' && OPEN_TASK_STATUSES.has(a.status))
    .sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime())[0];
  if (!openAttemptRow) return null;
  const attemptCtx = (openAttemptRow.context ?? {}) as { iteration?: unknown; maxIterations?: unknown };
  return {
    taskId: openAttemptRow.id,
    title: openAttemptRow.title,
    status: openAttemptRow.status,
    iteration: typeof attemptCtx.iteration === 'number' ? attemptCtx.iteration : null,
    maxIterations: typeof attemptCtx.maxIterations === 'number' ? attemptCtx.maxIterations : null,
    kind: openAttemptRow.category === 'review' ? 'review' : 'fix',
    claimed:
      openAttemptRow.status !== 'pending' ||
      (openAttemptRow.workers ?? []).some(w => LIVE_WORKER_STATUSES.has(w.status)),
  };
}

/**
 * The read behind {@link loadOpenAttempt}: `taskId`'s open attempts with only
 * what `deriveOpenAttempt` reads (two context keys, the workers' status), not
 * the full rows `viewForTask` loads. A page batches it and hands the rows to
 * {@link openAttemptOf}.
 */
export function openAttemptQuery(taskId: string) {
  return db.query.tasks.findMany({
    where: sqlWhere(and(
      eq(tasks.parentTaskId, taskId),
      eq(tasks.taskClass, 'attempt'),
      inArray(tasks.status, [...SHARED_OPEN_TASK_STATUSES]),
    )),
    columns: { id: true, title: true, status: true, taskClass: true, category: true, createdAt: true },
    extras: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      context: (t: any, _ops?: unknown) => sql<Record<string, unknown>>`jsonb_build_object('iteration', ${t.context}->'iteration', 'maxIterations', ${t.context}->'maxIterations')`.as('attempt_context'),
    },
    with: { workers: { columns: { status: true } } },
  });
}

/** The open-attempt fact from {@link openAttemptQuery}'s rows. */
export function openAttemptOf(rows: Awaited<ReturnType<typeof openAttemptQuery>>): OpenAttemptInfo | null {
  return deriveOpenAttempt(rows as unknown as LoadedTask[]);
}

/**
 * Convenience wrapper for a caller that only wants the open-attempt fact, not
 * a full `explainTask` answer (history, gate history, evidence objects, …).
 * One extra query — open children of `taskId` with their workers' status —
 * under the same predicate `viewForTask` applies.
 */
export async function loadOpenAttempt(taskId: string): Promise<OpenAttemptInfo | null> {
  return openAttemptOf(await openAttemptQuery(taskId));
}

function iso(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  return d instanceof Date ? d.toISOString() : new Date(d).toISOString();
}

/**
 * A history node's PR state: `resolvePrDisplayState`, projected onto
 * `HistoryNode['prState']`. A task that owns a kernel-owned delivery reads the
 * delivery (§17.5), never the worker's fact-cache columns.
 */
export function historyPrStateOf(
  w: Pick<LoadedTask['workers'][number], 'prNumber' | 'prLifecycleStatus' | 'mergedAt'> | undefined,
  delivery?: (Pick<DeliveryView, 'prState' | 'prNumber'> & { state?: DeliveryView['state'] }) | null,
): HistoryNode['prState'] {
  if (!w?.prNumber && !(delivery?.prState && delivery.prNumber != null)) return 'none';
  // A delivery that has not projected a PR state yet is "open", not the worker
  // row's: that column is the fact cache of a past CI run (a head ago), which
  // is how an approved PR with green checks read ci_failed in its own history.
  if (delivery && delivery.prNumber != null && !delivery.prState && delivery.state && !deliverySettled({ state: delivery.state })) return 'open';
  const state = resolvePrDisplayState({ delivery, prLifecycleStatus: w?.prLifecycleStatus, mergedAt: w?.mergedAt });
  switch (state) {
    case 'merged': case 'closed': case 'conflict': case 'ci_failed': return state;
    case 'unresolvable': return 'closed';
    default: return 'open';
  }
}

/**
 * Attempts collapsed under their parent via `parentTaskId` + `taskClass`.
 * Nesting is read through `attachAttempts` (PR #1674) — not re-derived here.
 */
function buildHistory(loaded: LoadedTask[], deliveries: ReadonlyMap<string, DeliveryView> = new Map()): HistoryNode[] {
  const attemptsByParent = attachAttempts(loaded);
  const ids = new Set(loaded.map(t => t.id));
  const byCreated = (a: LoadedTask, b: LoadedTask) =>
    (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0);

  const toNode = (t: LoadedTask, path: Set<string>): HistoryNode => {
    const w = t.workers?.[0];
    const result = (t.result ?? null) as { evidence?: TaskEvidence; mismatch?: TaskMismatch[] } | null;
    const hint = evidenceHint(result?.evidence);
    const nextPath = new Set(path).add(t.id);
    return {
      taskId: t.id,
      title: t.title,
      status: t.status,
      taskClass: t.taskClass,
      prNumber: w?.prNumber ?? null,
      prState: historyPrStateOf(w, ownerView(deliveries, t.id)),
      createdAt: iso(t.createdAt),
      ...(hint ? { evidence: hint } : {}),
      ...(Array.isArray(result?.mismatch) && result.mismatch.length > 0 ? { mismatch: result.mismatch } : {}),
      // Attempts nest through attempts (a CI fix's own CI fix), not one level.
      attempts: (attemptsByParent.get(t.id) ?? [])
        .filter(a => !nextPath.has(a.id))
        .sort(byCreated)
        .map(a => toNode(a, nextPath)),
    };
  };

  // A root is any task that is not an attempt of another task in view. An
  // attempt whose parent is outside the loaded set still reads as a root, so
  // the history of an attempt subject is never empty.
  const parentInView = (t: LoadedTask) => t.parentTaskId != null && ids.has(t.parentTaskId);
  return loaded
    .filter(t => t.taskClass !== 'attempt' || !parentInView(t))
    .sort(byCreated)
    .map(t => toNode(t, new Set()));
}

/** `workers.observedTouches` ∪ `tasks.pathManifest`, with how it was determined. */
function touchSetOf(
  task: { pathManifest: string[] | null } | null,
  worker: { observedTouches: string[] | null } | null,
): { touches: string[]; touchSource: TouchSource } {
  const observed = (worker?.observedTouches ?? []).filter(Boolean);
  const declared = (task?.pathManifest ?? []).filter(p => p && p !== REPO_WIDE_SENTINEL);
  const touches = [...new Set([...observed, ...declared])];

  if (touches.length === 0) return { touches, touchSource: 'undeclared' };
  if (observed.length > 0 && declared.length > 0) {
    return { touches, touchSource: 'observedTouches+pathManifest' };
  }
  return { touches, touchSource: observed.length > 0 ? 'observedTouches' : 'pathManifest' };
}

// ─── Mission scope ────────────────────────────────────────────────────────────

/**
 * Assemble the accessor's inputs for a mission by running each derivation
 * exactly once, then hand them to `deriveMissionStateView`.
 */
/**
 * What a page already loaded for this mission (spec 3ef37387 R-11): explain
 * reads none of it again. `tasks` are the raw rows (no delivery overlay), each
 * with its workers newest first and the `context` / `result` keys the
 * accessor reads; `visualReviewState` is the page's one read of it.
 */
export interface MissionExplainInputs {
  mission: Record<string, unknown>;
  tasks: ReadonlyArray<Record<string, unknown>>;
  deliveries: Map<string, DeliveryView>;
  missionDeliveries: Awaited<ReturnType<typeof missionEpochsOf>>;
  foreignDeps: Map<string, DependencyRow>;
  supersededMap: Awaited<ReturnType<typeof computeSupersededFailedTasks>>;
  visualReviewState: import('@/lib/workflow/visual-review-state').MissionVisualReviewState | null;
  /** The completion gate's own read of the visual review model, when the page holds it. */
  visualModel?: import('@buildd/shared').VisualReviewModel;
}

async function viewForMission(missionId: string, inputs?: MissionExplainInputs, viewer?: DependencyViewer): Promise<{
  view: MissionStateView;
  mission: Record<string, unknown>;
  loaded: LoadedTask[];
  answerExtras: StateBecauseExtras;
  /** Owner PR rows whose merge columns disagree with their delivery (AC-26). */
  disagreements: DeliveryDisagreement[];
  deliveries: Map<string, DeliveryView>;
} | null> {
  const mission = inputs?.mission ?? await db.query.missions.findFirst({
    where: sqlWhere(eq(missions.id, missionId)),
    with: { schedule: true },
  });
  if (!mission) return null;

  const rawLoaded = (inputs?.tasks ?? await db.query.tasks.findMany({
    where: sqlWhere(eq(tasks.missionId, missionId)),
    columns: TASK_COLUMNS,
    with: { workers: WORKER_WITH },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  })) as any as LoadedTask[];

  const m = mission as unknown as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  // §7 (workflow-kernel-library.md): where each delivery-owned task's PR
  // stands is its delivery's, and a mission PR's is its delivery records'
  // (§6). One load each; the worker rows below carry the delivery's lifecycle
  // (derived on read, nothing written), and a row that disagrees is named.
  const [deliveries, missionDeliveries] = inputs
    ? [inputs.deliveries, m.integrationBranchEnabled === true ? inputs.missionDeliveries : []]
    : await Promise.all([
        getDeliveryViewsForTasks(rawLoaded.map(t => t.id)),
        m.integrationBranchEnabled === true ? missionEpochsOf(missionId) : Promise.resolve([]),
      ]);
  const loaded = overlayDeliveryLifecycle(rawLoaded, deliveries);
  const disagreements = deliveryDisagreements(rawLoaded, deliveries);
  const schedule = m.schedule as { lastDeferralReason?: string | null; nextRunAt?: Date | null } | null;
  // Same read the mission detail page does: a heartbeat that is deliberately
  // holding records its resume time on the schedule row.
  const heartbeatWaitingUntil =
    schedule?.lastDeferralReason === 'heartbeat_waiting' ? schedule?.nextRunAt ?? null : null;

  // Dependencies outside this mission are judged from their own rows, never
  // guessed (unknown is not unmet): one query by id list.
  // With a caller, each is resolved for it (spec e28018c2 R-6).
  const foreignDeps = inputs?.foreignDeps ?? await loadDependencyRows(
    foreignDependencyIds(loaded),
    viewer ? { viewer, teamId: (m.teamId as string | null | undefined) ?? null, dependentWorkspaceId: (m.workspaceId as string | null) ?? null } : undefined,
  );
  const deliverables = loaded.filter(isDeliverableTask);
  const failedDeliverables = deliverables.filter(t => t.status === 'failed');
  const supersededMap = inputs?.supersededMap ?? await computeSupersededFailedTasks(
    missionId,
    (m.workspaceId as string | null) ?? null,
    failedDeliverables.map(t => ({
      id: t.id,
      title: t.title,
      subjectPrNumber: t.subjectPrNumber,
      createdAt: t.createdAt,
      roleSlug: t.roleSlug,
    })),
    m.autoSurfaceAudit as boolean | null | undefined,
  );

  // S35: a failed attempt the kernel already replaced (its delivery is live or
  // shipped) is history too, read from the DeliveryView, not a title heuristic.
  const kernelReplaced = replacedFailedTaskIds(deliveries, failedDeliverables.map(t => t.id));
  const health = deriveTaskHealthSignal(
    { ...m, heartbeatWaitingUntil },
    loaded.map(t => ({ ...t, superseded: supersededMap.has(t.id) || kernelReplaced.has(t.id) })),
    { dependencies: foreignDeps },
  );

  // The card's n/N (`missionCardProgress`): rows folded (D1), cancelled out of
  // N, a completed task with an open PR not done. One definition, so the
  // criteria gate below presents the same on the card and on this page.
  const counted = missionCardProgress(loaded as unknown as MissionCardTaskRow[]);
  const progress = counted.total > 0 ? counted.progress : undefined;

  const criteria = Array.isArray(m.goalCriteria) ? (m.goalCriteria as unknown[]) : [];
  const criteriaState = (m.goalCriteriaState ?? null) as
    | { overall?: string; criteria?: Array<{ verdict: string; label?: string; type?: string; evidence?: string }> }
    | null;
  const criteriaItems = criteriaState?.criteria ?? [];
  const criteriaGate = ['completed', 'cancelled', 'archived'].includes(String(m.status))
    ? null
    : deriveCriteriaGatePresentation({
        criteriaCount: criteria.length,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        overall: (criteriaState?.overall as any) ?? null,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        items: criteriaItems as any,
        completionAttempted: progress !== undefined && progress >= 100,
      });

  // evaluateCriteria: false — a read must never dispatch a verification task or
  // spend a token to answer "what is this waiting on".
  // A page's render reads stored evidence only and passes the rows it holds.
  const completion = await canCompleteMission(missionId, inputs
    ? { evaluateCriteria: false, render: true, loaded: { mission: m as never, tasks: rawLoaded as never, visualModel: inputs.visualModel } }
    : { evaluateCriteria: false });
  // A missing visual review is the owner's to run only when the policy asks. Read
  // the canonical state only then, so every other explain stays one query lighter.
  // An open audit row also needs it: the header follows the visual review state
  // (waived, blocked, running), not the audit task row (spec 8e137fdb I-1, I-5).
  const openAudit = loaded.some(t => OPEN_TASK_STATUSES.has(t.status) && isMissionAuditTask(t));
  // An open mission PR needs it too: "ready to merge" is said only when the review does not hold it (spec 072de598 I-12).
  const visualReviewState = !(completion.code === 'surface_audit_missing' || completion.code === 'awaiting_mission_pr' || openAudit) ? null
    : inputs ? inputs.visualReviewState
    : await import('@/lib/workflow/visual-review-state-load')
        .then(m => m.getMissionVisualReviewState(missionId))
        .catch(() => null);
  const visualReviewActor = completion.code === 'surface_audit_missing' ? visualReviewState?.nextActor ?? null : null;
  const visualReview = summarizeVisualReview(visualReviewState);

  const wait = classifyMissionWait(loaded as unknown as WaitClassifiableTask[]);

  // Only meaningful for a mission on an integration branch; for every other
  // mission it would answer a question nobody asked and cost a query.
  const workState = m.integrationBranchEnabled && m.workingBranch
    ? await evaluateMissionWorkState(missionId)
    : null;

  // The claim loop's durable refusal ledger. Read unconditionally: the whole
  // point is that a task nothing has been allowed to start looks, from every
  // other source, exactly like a task nothing is wrong with.
  //
  // Filtered to tasks still `pending`: `gate_events` never gets a "cleared"
  // row when a task finally dispatches (see `DEFERRAL_FRESHNESS_MS`'s own
  // note), so a task that was deferred and then claimed and completed within
  // the freshness window still reads as stuck by age alone. The row set
  // already loaded above is the current answer to "did it leave pending" and
  // costs nothing extra to consult.
  const pendingTaskIds = new Set(loaded.filter(t => t.status === 'pending').map(t => t.id));
  const [deferralRows, claimHolds, queueWaits] = await Promise.all([
    loadMissionClaimDeferrals(missionId),
    // R-33 / Navigation R-14: the newest refusal, with the blocker it named,
    // says why a pending task has not started.
    loadClaimHolds([...pendingTaskIds]),
    // ...and what the claim route's own query and gates say now, which decides.
    loadWaits([...pendingTaskIds]),
  ]);
  const deferrals = deferralRows.filter(d => pendingTaskIds.has(d.taskId));
  const holdReasons = new Map([...claimHolds].map(([id, h]) => [id, h.reason]));

  // `canCompleteMission` knows the mission PR has not merged; only the task
  // rows know where it is. Supplying it turns "the mission PR has not merged"
  // into an affordance with a destination.
  const integrationPr = deriveMissionIntegrationPr({
    deliveries: missionDeliveries,
    mission: m as { workingBranch?: string | null; integrationBranchEnabled?: boolean | null },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tasks: loaded as any,
  });

  const activeAgents = loaded.flatMap(t => t.workers ?? []).filter(w => LIVE_WORKER_STATUSES.has(w.status)).length;
  const openTasks = deliverables.filter(t => OPEN_TASK_STATUSES.has(t.status));
  // A pending row waiting on an unmet dependency cannot be the blocker; the
  // accessor cites the dependency instead (same rule as the claim gate).
  const loadedById = new Map<string, DependencyRow>(foreignDeps);
  for (const t of loaded) loadedById.set(t.id, t);
  const waitingOnOf = (t: LoadedTask) => (t.status === 'pending' ? unmetDependencyIds(t, loadedById) : []);
  // R-14: the tasks the pending rows wait behind, by name: each unmet
  // dependency, and the task an overlap deferral recorded as its blocker (which
  // may sit in another mission). One read for the rows not already loaded.
  const holderIds = new Set<string>();
  for (const t of openTasks) {
    if (t.status !== 'pending') continue;
    const blocker = deferralBlockerId(claimHolds.get(t.id));
    if (blocker && blocker !== t.id) holderIds.add(blocker);
    const waitBlocker = waitBlockerId(queueWaits.get(t.id));
    if (waitBlocker && waitBlocker !== t.id) holderIds.add(waitBlocker);
    for (const id of waitingOnOf(t)) holderIds.add(id);
  }
  const holders = await loadHolders([...holderIds], holderSourceRows(loadedById));
  const trunkRed = trunkRedOf(deliveries, loaded, m.integrationBranchEnabled && m.workingBranch ? String(m.workingBranch) : null);
  // The card's own reading of the same rows (`ownerUnmergedPrs`,
  // `deriveLocalStrand`), so a card and this answer cannot disagree on
  // "waiting on you to merge" or "stranded".
  const now = Date.now();
  const strand = deriveLocalStrand({
    executor: m.executor ?? null,
    isHeld: m.isHeld === true,
    status: String(m.status),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tasks: loaded as any,
    dependencies: foreignDeps,
    now,
  });
  // Superseded failures shipped their deliverable under a different task/PR —
  // see mission-task-superseded.ts. Excluded here so they never drive the
  // mission into a `failing` state; reported separately below instead.
  const failedTasks = failedDeliverables.filter(t => !supersededMap.has(t.id) && !kernelReplaced.has(t.id));
  const supersededTasks = failedDeliverables
    .filter(t => supersededMap.has(t.id))
    .map(t => ({ task: t, superseded: supersededMap.get(t.id)! }));

  const missingBrowser = await missingBrowserFor(openTasks, m.workspaceId ?? null, m.executor === 'local');
  const runnerOnline = await runnerOnlineFor(openTasks, m.workspaceId ?? null, m.executor === 'local');
  // The same facts for the view and for the because[] rows, so the header and
  // the chain word one hold one way.
  const holdInputOf = (t: LoadedTask): PendingTaskHoldInput => ({
    now,
    ...pendingRowFacts(t, claimHolds, waitingOnOf(t), holders, queueWaits),
    holders,
    runnerOnline: m.executor === 'local' ? null : runnerOnline ?? null,
    missingBrowser: missingBrowser && t.roleSlug === VISUAL_AUDITOR_ROLE_SLUG,
    trunkRed,
  });
  const input: MissionStateInput = {
    runnerOnline,
    now,
    holders,
    trunkRed,
    status: String(m.status),
    isHeld: m.isHeld === true,
    armedAt: m.armedAt ?? null,
    executor: m.executor ?? null,
    orchestrationMode: m.orchestrationMode ?? null,
    activeAgents,
    progress,
    health,
    dependsOnMissionId: m.dependsOnMissionId ?? null,
    criteriaEscalatedAt: m.criteriaEscalatedAt ?? null,
    hasPendingDeliverableWork: deliverables.some(
      t => !['completed', 'cancelled', 'failed'].includes(t.status),
    ),
    criteriaGate,
    criteriaItems,
    completion,
    visualReviewActor,
    wait,
    workState,
    openTasks: openTasks.map(t => ({
      id: t.id, status: t.status, title: t.title, waitingOnTaskIds: waitingOnOf(t),
      ...(t.status === 'pending' ? { waitingOnPrs: unmetDependencyPrs(t, loadedById) } : {}),
      surfaceAudit: isMissionAuditTask(t),
      holdReason: t.status === 'pending' ? holdReasons.get(t.id) ?? null : null,
      ...pendingRowFacts(t, claimHolds, waitingOnOf(t), holders, queueWaits),
      missingBrowser: missingBrowser && t.roleSlug === VISUAL_AUDITOR_ROLE_SLUG,
    })),
    visualReview,
    // AC-7: what is left when nothing else is outstanding, the rail's own reading.
    openChecks: openCriteriaChecks(m.goalCriteria, m.goalCriteriaState, {
      branch: m.integrationBranchEnabled ? 'mission-branch' : 'direct',
      prMerged: integrationPr?.state === 'merged',
      // The one build-complete predicate every surface reads (Navigation R-15).
      buildComplete: isBuildComplete(counted),
    }),
    missionPrMerged: integrationPr?.state === 'merged',
    openQuestions: missionOpenQuestions(loaded),
    localStrand: strand
      ? { ...strand, flipBlockedReason: continueOnRunnerBlockedReason({ status: String(m.status), workspaceId: (m.workspaceId as string | null) ?? null }) }
      : null,
    unmergedPrs: ownerUnmergedPrs(loaded as unknown as MissionCardTaskRow[], now),
    failedTasks: failedTasks.map(t => ({
      id: t.id,
      title: t.title,
      infra: isInfraFailedTask(t),
    })),
    deferrals,
    // `merged` carries no outstanding fact — the mission is on its way to
    // completing, not waiting on a PR — so it collapses to null same as no PR
    // at all. `open` / `closed` / `not_opened` are passed through as-is:
    // `mergeFact` is what turns each into honest text (or none).
    missionPr: integrationPr && integrationPr.state !== 'merged'
      ? { state: integrationPr.state, prNumber: integrationPr.prNumber, prUrl: integrationPr.prUrl, ...(integrationPr.ciRed ? { ciRed: true } : {}) }
      : null,
    ciRed: deriveCiRedChains(
      (completion?.awaitingMergeDetails ?? []).filter(d => !d.closedUnsuperseded),
      loaded,
    ),
  };

  return {
    view: deriveMissionStateView(input),
    mission: m,
    loaded,
    disagreements,
    deliveries,
    answerExtras: {
      openTasks: openTasks.map(t => ({
        id: t.id,
        title: t.title,
        status: t.status,
        live: hasLiveWorker(t),
        waiting: hasOpenAsk(t),
        runnerClaimable: !!(t.context as Record<string, unknown> | null)?.reviewerFor,
        missingBrowser: missingBrowser && t.roleSlug === VISUAL_AUDITOR_ROLE_SLUG,
        holdReason: t.status === 'pending' ? holdReasons.get(t.id) ?? null : null,
        ...(t.status === 'pending' ? { pendingHold: pendingHoldSummary(holdInputOf(t)) } : {}),
        waitingOn: waitingOnOf(t).map(id => ({ id, title: loadedById.get(id)?.title ?? null })),
      })),
      failedTasks: failedTasks.map(t => ({
        id: t.id,
        title: t.title,
        errorSignature: t.workers?.[0]?.error ? t.workers[0].error.split('\n')[0].slice(0, 200) : null,
      })),
      unmergedPrs: completion.awaitingMergeDetails ?? [],
      dependencyTitle: null,
      supersededTasks: supersededTasks.map(({ task, superseded }) => ({
        id: task.id,
        title: task.title,
        prNumber: superseded.prNumber,
        supersedingTaskId: superseded.supersedingTaskId,
        ...(superseded.replacedByAudit ? { replacedByAudit: true as const } : {}),
        ...(superseded.waived ? { waived: true as const } : {}),
      })),
    },
  };
}

function answerFrom(
  view: MissionStateView,
  subject: ExplainAnswer['subject'],
  history: HistoryNode[],
  because: ExplainAnswer['because'],
  gateHistory: GateHistoryEntry[] = [],
  evidenceObjects: InlineEvidenceObject[] = [],
): ExplainAnswer {
  return {
    subject,
    state: view.kind,
    displayState: view.displayState,
    chip: view.chip,
    presentation: presentMissionState(view),
    waitingOn: view.waitingOn,
    outstanding: view.outstanding,
    situation: view.situation,
    because,
    history,
    nextAction: view.nextAction,
    gateHistory,
    ...(evidenceObjects.length > 0 ? { evidenceObjects } : {}),
    derivedFrom: {
      state: view.derivedFrom.kind,
      waitingOn: view.derivedFrom.waitingOn,
      because: [...new Set(because.map(b => b.derivedFrom))],
      history: history.length > 0 ? 'tasks.parentTaskId + tasks.taskClass (attachAttempts)' : null,
      nextAction: view.derivedFrom.nextAction,
      gateHistory: gateHistory.length > 0 ? 'gate_events.taskId' : null,
    },
  };
}

/**
 * `inputs`: what a page already loaded (spec 3ef37387 R-11), so the mission
 * and its tasks are read once per render. `history: false` leaves out the
 * attempt history a page does not show.
 */
export async function explainMission(
  missionId: string,
  opts: { inputs?: MissionExplainInputs; history?: boolean; viewer?: DependencyViewer } = {},
): Promise<ExplainResult | null> {
  const loadedMission = await viewForMission(missionId, opts.inputs, opts.viewer);
  if (!loadedMission) return null;
  const { view, mission, loaded, answerExtras, disagreements, deliveries } = loadedMission;

  // Name the upstream mission, and the exact condition its gate still lacks,
  // rather than pointing at a UUID. A read: the gate is not stamped from here.
  if (view.waitingOn?.kind === 'dependency') {
    const gate = (mission as { gateCondition?: string | null }).gateCondition === 'completed' ? 'completed' : 'merged';
    const verdict = await evaluateMissionGate(view.waitingOn.missionId, gate).catch(() => null);
    if (verdict) {
      answerExtras.dependencyTitle = verdict.title;
      answerExtras.dependencyGate = { gate, met: verdict.met, unmet: verdict.unmet };
    } else {
      const upstream = await db.query.missions.findFirst({
        where: sqlWhere(eq(missions.id, view.waitingOn.missionId)),
        columns: { title: true },
      });
      answerExtras.dependencyTitle = upstream?.title ?? null;
    }
  }

  const subject: ExplainAnswer['subject'] = {
    scope: 'mission',
    id: missionId,
    label: String(mission.title ?? missionId),
    workspaceId: (mission.workspaceId as string) ?? null,
    missionId,
    taskId: null,
    prNumber: null,
  };

  const because = withDisagreements(buildStateBecause(
    view,
    { missionId, workspaceId: subject.workspaceId },
    answerExtras,
  ), disagreements, { missionId, workspaceId: subject.workspaceId });

  return { scope: 'mission', subjects: [answerFrom(view, subject, opts.history === false ? [] : buildHistory(loaded, deliveries), because)] };
}

// ─── Task scope ───────────────────────────────────────────────────────────────

/**
 * A task answers the same question with the same shape: the accessor's inputs
 * are simply scoped to this one row and its attempts. Feeding it a single-task
 * "mission" is deliberate — a second accessor for tasks is exactly the
 * divergence this whole line of work exists to prevent.
 */
/** Attach "why is it on this backend" when something moved the task (see ExplainAnswer.backendRouting). */
function withBackendRouting(answer: ExplainAnswer, task: { context: Record<string, unknown> | null; backend?: string | null }): ExplainAnswer {
  const routing = describeBackendRouting(task.context, task.backend);
  if (!routing) return answer;
  return {
    ...answer,
    backendRouting: routing,
    derivedFrom: {
      ...answer.derivedFrom,
      backendRouting: routing.source === 'claim'
        ? `tasks.context.${BACKEND_ROUTING_KEY}`
        : 'tasks.context.failedOverFrom + tasks.backend',
    },
  };
}

/** AC-26: one because[] link per worker row that disagrees with its delivery. */
function withDisagreements(chain: ExplainAnswer['because'], ds: readonly DeliveryDisagreement[], subject: { missionId?: string | null; workspaceId?: string | null }): ExplainAnswer['because'] {
  return ds.reduce((c, d) => withDispatchLink(c, deliveryDisagreementLink(d, subject)), chain);
}

/** The delivery `taskId` owns, from a loaded map; null when it is an attempt or legacy. */
function ownerView(m: ReadonlyMap<string, DeliveryView>, taskId: string): DeliveryView | null {
  const v = m.get(taskId);
  return v && v.ownerTaskId === taskId ? v : null;
}

/**
 * The delivery whose PR this task's worker points at: its own, or, for a
 * review-fix or repair attempt that pushed to its delivery's PR, that one.
 * The PR's state is then the delivery's, never the attempt's worker columns
 * (task fa37ed4b: a completed fix on an ESCALATED PR read as ready to merge).
 */
function prDeliveryView(m: ReadonlyMap<string, DeliveryView>, taskId: string, prNumber: number | null | undefined): DeliveryView | null {
  const own = ownerView(m, taskId);
  if (own) return own;
  const v = m.get(taskId);
  return v && prNumber != null && v.prNumber === prNumber ? v : null;
}

/**
 * §17.5: the owner task's unmerged PR, read from its kernel-owned delivery.
 * Merged, superseded and abandoned deliveries are settled; a closed one with no
 * edge is closed-unsuperseded (the remedy is a supersession, not a merge).
 */
export function kernelUnmergedPr(
  task: { id: string; title: string; status: string },
  worker: { prUrl?: string | null; supersessionScan?: { suggestion?: unknown; refreshCheck?: unknown } | null } | undefined,
  d: Pick<DeliveryView, 'state' | 'prNumber'>,
): NonNullable<StateBecauseExtras['unmergedPrs']> {
  if (task.status === 'cancelled' || task.status === 'pending' || d.prNumber == null) return [];
  if (d.state === 'MERGED' || d.state === 'SUPERSEDED' || d.state === 'ABANDONED' || d.state === 'FAILED') return [];
  const closed = d.state === 'CLOSED_UNMERGED';
  const suggestion = closed ? worker?.supersessionScan?.suggestion : undefined;
  const refreshCheck = closed ? worker?.supersessionScan?.refreshCheck : undefined;
  return [{
    taskId: task.id,
    title: task.title,
    prNumber: d.prNumber,
    prUrl: worker?.prUrl ?? null,
    ...(task.status === 'failed' ? { taskFailed: true as const } : {}),
    ...(closed ? { closedUnsuperseded: true as const } : {}),
    ...(suggestion ? { suggestion: suggestion as never } : {}),
    ...(refreshCheck ? { refreshCheck: refreshCheck as never } : {}),
  }];
}

/**
 * The landing blocker for a task's one unmerged PR (lib/landing-blocker.ts):
 * the newest `pr_landing` row, the conflict/migration repairs anywhere in its
 * lineage (a kernel fix is parented to the delivery owner), and the kernel or
 * legacy conflict fact. Stored facts only — explain never calls GitHub.
 */
function headShaOf(detail: unknown): string | null {
  const h = (detail as { headSha?: unknown } | null)?.headSha;
  return typeof h === 'string' ? h : null;
}

async function loadLandingBlocker(
  task: { id: string },
  pr: { taskId: string; prNumber: number | null; prUrl: string | null },
  delivery: DeliveryView | null,
  prLifecycleStatus: string | null,
  lineage: LoadedTask[],
): Promise<LandingBlocker[]> {
  const rows = await db.query.gateEvents.findMany({
    where: sqlWhere(and(eq(gateEvents.taskId, task.id), eq(gateEvents.gate, GATE_SLUGS.PR_LANDING))),
    orderBy: sqlOrderBy([desc(gateEvents.occurredAt)]),
    limit: 1,
    columns: { occurredAt: true, gate: true, outcome: true, reason: true, detail: true },
  }).catch(() => []);
  const row = rows.find(r => r.gate === GATE_SLUGS.PR_LANDING) ?? null;
  const repairs = lineage
    .filter(t => t.id !== task.id && t.creationSource === 'conflict')
    .sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime())
    .map(t => ({
      status: t.status,
      claimed: t.status !== 'pending' || (t.workers ?? []).some(w => LIVE_WORKER_STATUSES.has(w.status)),
      // Terminal rows stop updating, so updatedAt is when the repair ended.
      completedAt: t.status === 'completed' && t.updatedAt ? new Date(t.updatedAt).toISOString() : null,
    }));
  const blocker = deriveLandingBlocker({
    ...pr,
    delivery,
    prLifecycleStatus,
    repairs,
    landing: row
      ? {
          occurredAt: new Date(row.occurredAt).toISOString(),
          outcome: row.outcome,
          reason: row.reason,
          headSha: headShaOf(row.detail),
        }
      : null,
  });
  return blocker ? [blocker] : [];
}

async function viewForTask(taskId: string, viewer: DependencyViewer): Promise<{
  view: MissionStateView;
  /** Every DeliveryView the chain's tasks belong to, keyed by task id. */
  deliveries: Map<string, DeliveryView>;
  /** The kernel delivery this task's PR belongs to: the one it owns, or the one its fix attempt pushed to. */
  prDelivery: DeliveryView | null;
  task: LoadedTask;
  family: LoadedTask[];
  /** The whole fix-attempt chain this task sits in, for `history` only — state is still derived from `family`. */
  lineage: LoadedTask[];
  answerExtras: StateBecauseExtras;
  workspaceId: string | null;
  missionId: string | null;
  /** A pending task's one wait, from the claim route's own query and gates; null when not pending or unread. */
  queueWait: QueueWait | null;
  teamId: string | null;
} | null> {
  const task = (await db.query.tasks.findFirst({
    where: sqlWhere(eq(tasks.id, taskId)),
    columns: { ...TASK_COLUMNS, workspaceId: true, missionId: true, dependsOn: true, backend: true, pathDeclaration: true },
    with: { workers: WORKER_WITH, workspace: { columns: { teamId: true } } },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  })) as any as (LoadedTask & { workspaceId: string | null; missionId: string | null; dependsOn: string[] | null; backend?: string | null; pathDeclaration?: unknown; workspace?: { teamId?: string | null } | null }) | undefined;
  if (!task) return null;

  const attempts = (await db.query.tasks.findMany({
    where: sqlWhere(eq(tasks.parentTaskId, taskId)),
    columns: TASK_COLUMNS,
    with: { workers: WORKER_WITH },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  })) as any as LoadedTask[];

  // The parent mission's executor. A local mission's pending task is waiting
  // for the person's session to claim it, not stalled for want of a runner.
  // A held mission is the pause and wins, so it is not read as local.
  const parentMission = task.missionId
    ? await db.query.missions.findFirst({
        where: sqlWhere(eq(missions.id, task.missionId)),
        columns: { executor: true, isHeld: true },
      })
    : null;
  // A reviewer task is runner-claimable whatever the mission's executor (the
  // claim gate's missionNotLocal() exempts context.reviewerFor), so it is never
  // read as waiting on a local session.
  const isReviewerTask = !!(task.context as Record<string, unknown> | null)?.reviewerFor;
  const executor = parentMission && !parentMission.isHeld && !isReviewerTask ? parentMission.executor ?? null : null;

  const family = [task as LoadedTask, ...attempts];
  // History reads the whole chain: from an attempt (a CI fix that opened a PR
  // of its own after a failed resume) the direct children alone leave the
  // predecessor PR and its siblings out.
  const lineage = await collectLineage<LoadedTask>(taskId, {
    fetchTask: async (id) =>
      id === taskId
        ? (task as LoadedTask)
        : (((await db.query.tasks.findFirst({
            where: sqlWhere(eq(tasks.id, id)),
            columns: TASK_COLUMNS,
            with: { workers: WORKER_WITH },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          })) as any as LoadedTask | undefined) ?? null),
    fetchChildren: async (parentIds) =>
      (await db.query.tasks.findMany({
        where: sqlWhere(inArray(tasks.parentTaskId, parentIds)),
        columns: TASK_COLUMNS,
        with: { workers: WORKER_WITH },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      })) as any as LoadedTask[],
  });
  const historyTasks = [...new Map([...lineage, ...family].map(t => [t.id, t])).values()];
  const activeAgents = family.flatMap(t => t.workers ?? []).filter(w => LIVE_WORKER_STATUSES.has(w.status)).length;

  const worker = task.workers?.[0];
  // One DeliveryView load for the whole chain (§17.5). A task that owns a
  // kernel-owned delivery, or an attempt that pushed to its PR, takes its PR
  // reading from the delivery; the worker columns below are the legacy path only.
  const deliveries = await getDeliveryViewsForTasks(historyTasks.map(t => t.id));
  const prDelivery = prDeliveryView(deliveries, taskId, worker?.prNumber);
  // A PR recorded as superseded (task fcaf83d5) shipped anyway, under a
  // different, merged PR — verified against GitHub at write time, so it reads
  // as shipped here without a second check. Never awaiting-merge.
  // An abandoned PR (closed, with a person's reason) is settled, not awaiting.
  const unmergedPr: NonNullable<StateBecauseExtras['unmergedPrs']> = prDelivery
    ? kernelUnmergedPr(task, worker, prDelivery)
    : task.status === 'completed' && worker?.prNumber && !worker.mergedAt && !worker.supersededByPrNumber
      && !(worker.prLifecycleStatus === 'closed' && worker.abandonedAt)
      ? [{
          taskId: task.id,
          title: task.title,
          prNumber: worker.prNumber,
          prUrl: worker.prUrl,
          ...(worker.prLifecycleStatus === 'closed' ? { closedUnsuperseded: true as const } : {}),
          ...(worker.prLifecycleStatus === 'closed' && worker.supersessionScan?.suggestion
            ? { suggestion: worker.supersessionScan.suggestion }
            : {}),
          ...(worker.prLifecycleStatus === 'closed' && worker.supersessionScan?.refreshCheck
            ? { refreshCheck: worker.supersessionScan.refreshCheck }
            : {}),
        }]
      : [];

  // The newest open fix attempt (builder-after-review, CI retry). While one is
  // open the PR is about to change, so it — not the merge — is what this task
  // is waiting on. Without this the task read "waiting on you to merge" while a
  // request-changes fix sat queued for a worker.
  const openAttempt = deriveOpenAttempt(attempts);

  const terminal = ['completed', 'failed', 'cancelled'].includes(task.status);
  // R-14: a pending task names what holds it: its unmet dependencies (judged
  // from their own rows, never guessed), the blocker its newest refusal named,
  // its schedule. Nothing is read for a task that is not pending.
  const pending = task.status === 'pending';
  // Every holder is resolved for the caller (spec e28018c2 R-7): one in a
  // workspace it cannot see is named, refs and all, as a task it cannot see.
  const reachScope = { viewer, teamId: task.workspace?.teamId ?? null, dependentWorkspaceId: task.workspaceId ?? null };
  const [claimHolds, depRows, queueWaits] = await Promise.all([
    pending ? loadClaimHolds([taskId]) : Promise.resolve(new Map<string, ClaimHoldFacts>()),
    pending && (task.dependsOn?.length ?? 0) > 0 ? loadDependencyRows(task.dependsOn!, reachScope) : Promise.resolve(new Map<string, DependencyRow>()),
    // The one reason the claim route's own query and gates give now (spec: Overlap scheduling, AC-10).
    pending ? loadWaits([taskId]) : Promise.resolve(new Map<string, QueueWait>()),
  ]);
  const unmetDeps = pending ? unmetDependencyIds(task, depRows) : [];
  const blockerId = pending ? deferralBlockerId(claimHolds.get(taskId)) : null;
  const waitBlocker = pending ? waitBlockerId(queueWaits.get(taskId)) : null;
  const holderIds = [...new Set([...unmetDeps, ...[blockerId, waitBlocker].filter((id): id is string => !!id && id !== taskId)])];
  const [loadedHolders, holderReach] = await Promise.all([
    loadHolders(holderIds, holderSourceRows([...depRows].filter(([id]) => id !== taskId))),
    resolveDependencyHolders(reachScope, holderIds.filter(id => !depRows.has(id))).catch(() => new Map()),
  ]);
  const holders = new Map([...loadedHolders].map(([id, f]) => [id, holderForViewer(f, depRows.get(id) ?? holderReach.get(id))]));
  const rowFacts = pendingRowFacts(task as LoadedTask, claimHolds, unmetDeps, holders, queueWaits);
  const openTasks = OPEN_TASK_STATUSES.has(task.status)
    ? [{
        id: task.id, status: task.status, title: task.title,
        ...(pending ? { waitingOnTaskIds: unmetDeps, waitingOnPrs: unmetDependencyPrs(task, depRows), ...rowFacts } : {}),
      }]
    : openAttempt
      ? [{ id: openAttempt.taskId, status: openAttempt.status, title: openAttempt.title }]
      : [];
  // S35: a failed attempt the kernel already carried past is history, not a failure.
  // While the PR's delivery is live it owns the state, so no failed row in the
  // family overrides it: two PRs escalated on one rule read alike whether or not
  // a fix attempt failed on the way (task 8d440b64).
  const deliveryLive = !!prDelivery && !deliverySettled(prDelivery);
  const replaced = replacedFailedTaskIds(deliveries, family.filter(t => t.status === 'failed').map(t => t.id));
  const failedTasks = deliveryLive ? [] : family.filter(t => t.status === 'failed' && !replaced.has(t.id));
  // Family scope: the attempts ARE this task's work, so they count here even
  // though mission-scope health (deliverables only) ignores them.
  const health = deriveTaskHealthSignal({}, deliveryLive ? family.filter(t => t.status !== 'failed') : family, { scope: 'family' });

  // Why the unmerged PR cannot land, from stored landing facts (§13.11 rule 3).
  const openPr = unmergedPr.find(p => !p.closedUnsuperseded) ?? null;
  const ciRed = deriveCiRedChains(
    unmergedPr.filter(p => !p.closedUnsuperseded).map(p => (prDelivery ? { ...p, ciRed: prDelivery.prState === 'ci_failed' } : p)),
    family,
  );
  // An exhausted CI-fix chain says more than "its checks are failing", so it keeps the reading.
  const landingBlocked = (openPr ? await loadLandingBlocker(task, openPr, prDelivery, worker?.prLifecycleStatus ?? null, historyTasks) : [])
    .filter(b => b.cause !== 'ci_failed' || !ciRed.some(c => c.prNumber === b.prNumber));

  const runnerOnline = await runnerOnlineFor(family, task.workspaceId, executor === 'local');
  const missingBrowser = await missingBrowserFor(family, task.workspaceId, executor === 'local');
  const input: MissionStateInput = {
    // A cancelled task is closed, not idle. `completed` is only terminal for
    // this view once its PR has landed — the merge rule below decides that.
    status: task.status === 'cancelled'
      || (task.status === 'completed' && unmergedPr.length === 0 && !openAttempt)
      || (!!prDelivery && deliverySettled(prDelivery) && prDelivery.state !== 'FAILED' && !openAttempt)
      ? 'completed'
      : 'active',
    openAttempt,
    isHeld: false,
    runnerOnline,
    holders,
    executor,
    activeAgents,
    health,
    progress: terminal ? 100 : undefined,
    openTasks,
    openQuestions: missionOpenQuestions(family),
    failedTasks: failedTasks.map(t => ({
      id: t.id,
      title: t.title,
      infra: isInfraFailedTask(t),
    })),
    wait: classifyMissionWait(family as unknown as WaitClassifiableTask[]),
    landingBlocked,
    ciRed,
    completion: unmergedPr.length > 0 && !openAttempt
      ? {
          ok: false,
          code: 'awaiting_merge',
          reason: `${unmergedPr[0].taskFailed ? 'Task failed, but' : 'Task completed but'} PR #${unmergedPr[0].prNumber} `
            + (unmergedPr[0].closedUnsuperseded ? 'closed unmerged, no supersession recorded' : 'has not merged'),
          awaitingMerge: 1,
          awaitingMergeDetails: unmergedPr,
        }
      : null,
  };

  return {
    view: deriveMissionStateView(input),
    deliveries,
    prDelivery,
    task: task as LoadedTask,
    family,
    lineage: historyTasks,
    workspaceId: task.workspaceId ?? null,
    missionId: task.missionId ?? null,
    queueWait: queueWaits.get(taskId) ?? null,
    answerExtras: {
      openTasks: openTasks.map(t => ({
        id: t.id, title: t.title, status: t.status,
        live: family.some(f => f.id === t.id && hasLiveWorker(f)),
        waiting: family.some(f => f.id === t.id && hasOpenAsk(f)),
        missingBrowser: missingBrowser && family.some(f => f.id === t.id && f.roleSlug === VISUAL_AUDITOR_ROLE_SLUG),
        ...(t.id === taskId && pending
          ? {
              waitingOn: unmetDeps.map(id => {
                const d = depRows.get(id);
                if (d?.hidden) return { id, title: null, hidden: true };
                return { id, title: d?.title ?? null, ...(d?.workspaceName ? { workspaceName: d.workspaceName } : {}) };
              }),
              pendingHold: pendingHoldSummary({
                ...rowFacts, holders, trunkRed: null,
                runnerOnline: executor === 'local' ? null : runnerOnline ?? null,
                missingBrowser: missingBrowser && task.roleSlug === VISUAL_AUDITOR_ROLE_SLUG,
              }),
            }
          : {}),
      })),
      failedTasks: failedTasks.map(t => ({
        id: t.id,
        title: t.title,
        errorSignature: t.workers?.[0]?.error ? t.workers[0].error.split('\n')[0].slice(0, 200) : null,
      })),
      unmergedPrs: unmergedPr,
    },
    teamId: reachScope.teamId,
  };
}

/** Coordination holds as the caller may read them: a holder it cannot see is said to be one, and nothing more (spec e28018c2 R-7). */
async function holdsForViewer(
  holds: CoordinationHold[],
  scope: { viewer: DependencyViewer; teamId: string | null; dependentWorkspaceId: string | null },
): Promise<CoordinationHold[]> {
  const ids = holds.map(h => h.holderTaskId).filter((id): id is string => !!id);
  if (ids.length === 0) return holds;
  const reach = await resolveDependencyHolders(scope, ids).catch(() => null);
  return holds.map(h => (h.holderTaskId && (!reach || reach.get(h.holderTaskId)?.hidden) ? hiddenHold(h) : h));
}

/**
 * `actor` is who the inline evidence list is audited to. Reach is the caller's
 * job: GET /api/explain has already decided the actor can read the workspace.
 */
/**
 * Attach the kernel's DeliveryView reading when the task's delivery is kernel-owned (S28).
 * While the delivery is live it names the owner of the next move, so the
 * presentation's needsYou is the delivery's: one answer never says both (task 8d440b64).
 */
function withDelivery(answer: ExplainAnswer, v: DeliveryView | null): ExplainAnswer {
  if (!v) return answer;
  return {
    ...answer,
    ...(deliverySettled(v) ? {} : { presentation: { ...answer.presentation, needsYou: v.needsYou } }),
    delivery: {
      state: v.state, owner: v.owner, needsYou: v.needsYou, headline: v.headline, detail: v.detail, attempts: attemptLine(v.attempts),
      ...(v.review ? { review: {
        stateLine: v.review.stateLine, verdict: v.review.verdict, round: v.review.round, roundsSpent: v.review.roundsSpent,
        roundBudget: v.review.roundBudget, openFindings: v.review.openFindings.map((f) => f.text),
      } } : {}),
    },
  };
}

/** The task verdict for `explain`: rules plus any cached wording for the same state. */
async function loadTaskVerdictForExplain(taskId: string): Promise<ExplainAnswer['verdict'] | null> {
  const { loadVerdictRecord } = await import('./task-verdict-decision-refresh');
  const { applyVerdictDecision } = await import('./task-verdict');
  const { verdict, stored } = await loadVerdictRecord(taskId);
  if (!verdict) return null;
  const v = applyVerdictDecision(verdict, stored);
  return { state: v.state, headline: v.headline, cause: v.cause, actions: v.actions, wordedBy: v.wordedBy };
}

export async function explainTask(taskId: string, actor: EvidenceActor, viewer: DependencyViewer = { kind: 'member' }): Promise<ExplainResult | null> {
  const loaded = await viewForTask(taskId, viewer);
  if (!loaded) return null;
  const { view, task, lineage, answerExtras, workspaceId, missionId, deliveries, queueWait } = loaded;

  const subject: ExplainAnswer['subject'] = {
    scope: 'task',
    id: taskId,
    label: task.title,
    workspaceId,
    missionId,
    taskId,
    prNumber: task.workers?.[0]?.prNumber ?? null,
  };

  // A pending task may be waiting on its wake rather than on a claim gate:
  // the latest outbox row is undelivered, handed off past due, or failed.
  // Read only for pending tasks; a read failure leaves the chain as it was.
  const wake = task.status === 'pending'
    ? dispatchWakeLink(await latestDispatchForTask(taskId).catch(() => null), { taskId, workspaceId }, Date.now())
    : null;
  const dv = deliveries.get(taskId) ?? null;
  const transition = deliveryTransitionLink(dv ? { ...dv, attemptLine: attemptLine(dv.attempts) } : null, { taskId, workspaceId });
  const roundWhy = reviewRoundLink(dv, { taskId, workspaceId });
  const hold = task.status === 'pending' ? entitlementHoldLink(task.context, { taskId, workspaceId }) : null;
  const gateRows = await loadGateRows(taskId);
  const gateHistory = gateRows.map(r => r.entry);
  const holds = await holdsForViewer(
    await loadCoordination(task as any, gateRows).catch(() => [] as CoordinationHold[]),
    { viewer, teamId: loaded.teamId, dependentWorkspaceId: workspaceId },
  );
  const coordLink = coordinationLink(holds, { taskId, workspaceId });
  // A task that started past an overlap on mergeable files says so (I-38).
  const alongside = task.status !== 'pending'
    ? overlapStartLink(latestOverlapStarts(gateRows.map(r => ({ reason: r.entry.reason, detail: r.detail }))), { taskId, workspaceId })
    : null;
  const recovery = taskRecoveryLink(task.status, task.context, { taskId, workspaceId });
  // A live worker whose runner went quiet: the task waits on that runner's
  // death, not on anything the state accessor can see.
  const runnerWait = await offlineRunnerWaitFor(task.workers?.[0], new Date());
  const runnerLink = runnerWait ? offlineRunnerLink(runnerWait, { taskId, workspaceId }, task.workers?.[0]?.id ?? null) : null;
  const because = withDisagreements(withDispatchLink(withDispatchLink(withDispatchLink(
    withDispatchLink(withDispatchLink(withDispatchLink(withDispatchLink(buildStateBecause(view, { taskId, missionId, workspaceId }, answerExtras), transition), roundWhy), wake), hold),
    (coordLink ?? alongside) as Parameters<typeof withDispatchLink>[1],
  ), recovery), runnerLink), deliveryDisagreements([task], deliveries), { missionId, workspaceId });
  const evidenceObjects = workspaceId
    ? await loadInlineEvidence(workspaceId, taskId, { surface: 'explain', actor })
    : [];
  // What the task's runs were given and refused; the most recent 40, so a
  // long-running task's renewals do not crowd out the answer.
  const access = (await loadTaskAccess(taskId).catch(() => [])).slice(-40);
  const routed = withBackendRouting(answerFrom(view, subject, buildHistory(lineage, deliveries), because, gateHistory, evidenceObjects), task);
  const answer = withOfflineRunnerWait(withDelivery(routed, dv), runnerWait);
  // The verdict the task page leads with, from the same loader the
  // state-change recompute uses. Read-only: no model call. A failure omits it.
  const verdict = await loadTaskVerdictForExplain(taskId).catch(() => null);
  const withCoordination = holds.length > 0 ? { ...answer, coordination: { holds } } : answer;
  const withAccess = access.length > 0 ? { ...withCoordination, access } : withCoordination;
  const withWait = queueWait ? { ...withAccess, queueWait } : withAccess;
  // An open question: what waits on its answer, the same projection the cards read (spec 1b257609 R-10).
  const questionWaits = await loadQuestionWaits({ taskId, viewer, requireQuestion: true }).catch(() => null);
  const withWaits = questionWaits ? { ...withWait, questionWaits } : withWait;
  return { scope: 'task', subjects: [verdict ? { ...withWaits, verdict } : withWaits] };
}

// ─── PR scope ─────────────────────────────────────────────────────────────────

/**
 * The base-side merges that could have conflicted with a PR: workers in the
 * same workspace whose PR merged into the same base after this one opened.
 *
 * `workers.mergedAt` + `workers.prBaseRef` are the authoritative edges. No
 * GitHub call, no git command.
 */
async function loadBaseSideMerges(input: {
  workspaceId: string;
  baseRef: string;
  since: Date;
  excludeWorkerId: string;
}): Promise<BaseSideMerge[]> {
  const rows = await db.query.workers.findMany({
    where: sqlWhere(and(
      eq(workers.workspaceId, input.workspaceId),
      eq(workers.prBaseRef, input.baseRef),
      isNotNull(workers.mergedAt),
      gt(workers.mergedAt, input.since),
      ne(workers.id, input.excludeWorkerId),
    )),
    columns: {
      id: true, taskId: true, prNumber: true, branch: true,
      mergedAt: true, lastCommitSha: true, observedTouches: true,
    },
    orderBy: sqlOrderByFn((w, { desc: d }) => [d(w.mergedAt)]),
    limit: BASE_SIDE_LIMIT,
  });
  if (rows.length === 0) return [];

  const taskIds = rows.map(r => r.taskId).filter((t): t is string => !!t);
  const taskRows = taskIds.length > 0
    ? await db.query.tasks.findMany({
        where: sqlWhere(inArray(tasks.id, taskIds)),
        columns: { id: true, title: true, pathManifest: true },
      })
    : [];
  const taskById = new Map(taskRows.map(t => [t.id, t]));

  return rows.map(r => {
    const t = r.taskId ? taskById.get(r.taskId) ?? null : null;
    const { touches, touchSource } = touchSetOf(
      t ? { pathManifest: (t.pathManifest as string[] | null) ?? null } : null,
      { observedTouches: (r.observedTouches as string[] | null) ?? null },
    );
    return {
      prNumber: r.prNumber ?? null,
      taskId: r.taskId ?? null,
      title: t?.title ?? null,
      branch: r.branch ?? null,
      mergedAt: iso(r.mergedAt),
      headSha: r.lastCommitSha ?? null,
      touches,
      touchSource,
    };
  });
}

/** The mission whose integration branch a PR targets, for a PR whose task names none (#5623). */
async function missionForBaseRef(workspaceId: string, baseRef: string | null): Promise<string | null> {
  if (!baseRef) return null;
  const m = await db.query.missions.findFirst({
    where: sqlWhere(and(eq(missions.workspaceId, workspaceId), eq(missions.workingBranch, baseRef))),
    columns: { id: true, integrationBranchEnabled: true, workingBranch: true },
  }).catch(() => null);
  return m && m.integrationBranchEnabled && m.workingBranch === baseRef ? m.id : null;
}

/**
 * The task a PR ships: the owner of its kernel delivery, else the task that
 * opened it. Every fix attempt on the PR (a CI fix, a review fix) records the
 * same PR number on its own worker, so the worker a PR number resolves to can
 * be an attempt's; read as the subject, a cancelled CI fix reported an open,
 * red PR as complete. An attempt that opened a PR of its own keeps it.
 */
export async function prOwnerTaskId(taskId: string, prNumber: number, pr?: { workspaceId: string; prUrl: string | null }): Promise<string> {
  // The PR's own delivery first: a person's "resolve conflicts and merge" task
  // also records the PR number, and is neither the owner nor an attempt (#5580).
  const byPr = pr ? await kernelDeliveryOwnerForPr(pr.workspaceId, pr.prUrl, prNumber) : null;
  if (byPr) return byPr;
  const dv = (await getDeliveryViewsForTasks([taskId])).get(taskId);
  if (dv && dv.prNumber === prNumber) return dv.ownerTaskId;
  let id = taskId;
  for (let hop = 0; hop < 8; hop++) {
    const t = await db.query.tasks.findFirst({ where: sqlWhere(eq(tasks.id, id)), columns: { id: true, parentTaskId: true, taskClass: true } });
    if (!t?.parentTaskId || t.taskClass !== 'attempt') break;
    const parent = (await db.query.tasks.findFirst({
      where: sqlWhere(eq(tasks.id, t.parentTaskId)),
      columns: { id: true },
      with: { workers: { columns: { prNumber: true } } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    })) as any as { id: string; workers?: Array<{ prNumber: number | null }> } | undefined;
    if (!parent?.workers?.some(w => w.prNumber === prNumber)) break;
    id = parent.id;
  }
  return id;
}

/**
 * Explain a PR. The state answer is its owner task's (a PR is not a separate
 * subject with its own lifecycle — it is how a task ships; `prOwnerTaskId`),
 * and when the PR is conflicted the conflict chain is prepended so `because[]`
 * opens on the cause. A kernel-owned PR carries its delivery's reading, owner
 * included.
 */
export async function explainPr(worker: {
  id: string;
  taskId: string | null;
  workspaceId: string;
  prNumber: number | null;
  prUrl: string | null;
  branch: string | null;
  prBaseRef: string | null;
  prLifecycleStatus: string | null;
  conflictDetectedAt: Date | string | null;
  prOpenedBaseSha: string | null;
  mergedAt: Date | string | null;
  observedTouches: string[] | null;
  createdAt: Date | string | null;
}, actor: EvidenceActor, viewer: DependencyViewer = { kind: 'member' }): Promise<ExplainResult | null> {
  if (!worker.taskId || worker.prNumber == null) return null;

  const taskId = await prOwnerTaskId(worker.taskId, worker.prNumber, worker);
  const loaded = await viewForTask(taskId, viewer);
  if (!loaded) return null;
  const { view, task, lineage, answerExtras, workspaceId, deliveries, prDelivery } = loaded;
  const missionId = loaded.missionId ?? await missionForBaseRef(workspaceId ?? worker.workspaceId, worker.prBaseRef);

  const subject: ExplainAnswer['subject'] = {
    scope: 'pr',
    id: String(worker.prNumber),
    label: `PR #${worker.prNumber}: ${task.title}`,
    workspaceId: workspaceId ?? worker.workspaceId,
    missionId,
    taskId,
    prNumber: worker.prNumber,
  };

  let because = buildStateBecause(view, { taskId, missionId, workspaceId }, answerExtras);

  // `mergeable: dirty` is stored locally as prLifecycleStatus='conflict'
  // (kept live by the GitHub webhook), so naming the cause needs no API call.
  if (worker.prLifecycleStatus === 'conflict' && !worker.mergedAt) {
    const { touches, touchSource } = touchSetOf(
      { pathManifest: task.pathManifest },
      { observedTouches: worker.observedTouches },
    );
    const openedAt = worker.createdAt ? new Date(worker.createdAt) : null;
    const baseSide = worker.prBaseRef && openedAt
      ? await loadBaseSideMerges({
          workspaceId: worker.workspaceId,
          baseRef: worker.prBaseRef,
          since: openedAt,
          excludeWorkerId: worker.id,
        })
      : [];

    const conflict: ConflictSubject = {
      prNumber: worker.prNumber,
      taskId,
      branch: worker.branch,
      baseRef: worker.prBaseRef,
      lifecycleStatus: worker.prLifecycleStatus,
      conflictDetectedAt: iso(worker.conflictDetectedAt),
      openedBaseSha: worker.prOpenedBaseSha,
      openedAt: iso(openedAt),
      touches,
      touchSource,
    };

    const explanation = buildConflictBecause(conflict, baseSide);
    // Conflict cause first, then the task-state chain: the chain still reads
    // cause → effect end to end.
    because = orderChain([
      ...explanation.links.map(({ order: _order, ...rest }) => rest),
      ...because.map(({ order: _order, ...rest }) => rest),
    ]);
  }

  // A PR ships through its task, so its gate ledger (merge_base_freshness
  // rejections, review_verdict deferrals) is the task's.
  const gateHistory = await loadGateHistory(taskId);
  const evidenceObjects = await loadInlineEvidence(worker.workspaceId, taskId, { surface: 'explain', actor });
  const answer = withBackendRouting(answerFrom(view, subject, buildHistory(lineage, deliveries), because, gateHistory, evidenceObjects), task);
  return { scope: 'pr', subjects: [withDelivery(answer, prDelivery)] };
}

// ─── Workspace scope ──────────────────────────────────────────────────────────

/**
 * Every subject in the workspace that is waiting on something, ranked — never
 * a dump of everything. A workspace with nothing blocked returns an empty
 * `subjects` with `quiet` set, which is a different and equally useful answer.
 *
 * Subjects are missions plus the workspace's mission-less tasks: a task inside
 * a mission is already represented by its mission's chain, and listing both
 * would put the same blocker on screen twice.
 */
export async function explainWorkspace(workspaceId: string, actor: EvidenceActor, viewer: DependencyViewer = { kind: 'member' }): Promise<ExplainResult> {
  const activeMissions = await db.query.missions.findMany({
    where: sqlWhere(and(eq(missions.workspaceId, workspaceId), eq(missions.status, 'active'))),
    columns: { id: true },
    // Same scan cap as the orphan-tasks query below — without it, a workspace
    // with many active missions fans out one explainMission() call (several
    // queries each) per mission before the WORKSPACE_SUBJECT_LIMIT ranking cut
    // ever applies, so the bound on subjects RETURNED did nothing to bound the
    // work PERFORMED to produce them.
    limit: MISSION_SCAN_LIMIT,
  });

  const orphanTasks = await db.query.tasks.findMany({
    where: sqlWhere(and(
      eq(tasks.workspaceId, workspaceId),
      inArray(tasks.status, ['pending', 'assigned', 'in_progress', 'completed']),
    )),
    columns: { id: true, missionId: true, taskClass: true },
    limit: 200,
  });
  const missionLessIds = orphanTasks
    .filter(t => !t.missionId && t.taskClass !== 'attempt')
    .map(t => t.id);

  // One bounded fan-out across missions and mission-less tasks together, so the
  // concurrency cap holds across both rather than doubling at the boundary.
  const fanoutItems: Array<{ kind: 'mission' | 'task'; id: string }> = [
    ...activeMissions.map(m => ({ kind: 'mission' as const, id: m.id })),
    ...missionLessIds.map(id => ({ kind: 'task' as const, id })),
  ];
  const results = await mapWithConcurrency(fanoutItems, WORKSPACE_FANOUT_CONCURRENCY, item =>
    item.kind === 'mission' ? explainMission(item.id, { viewer }) : explainTask(item.id, actor, viewer),
  );
  const answers: ExplainAnswer[] = results.flatMap(r => (r?.subjects[0] ? [r.subjects[0]] : []));

  const ranked = rankGatedSubjects(answers).slice(0, WORKSPACE_SUBJECT_LIMIT);
  const gatedTotal = answers.filter(a => a.waitingOn !== null).length;
  if (gatedTotal > ranked.length || activeMissions.length === MISSION_SCAN_LIMIT) {
    // No silent caps: say what was dropped rather than implying full coverage.
    console.info(
      `[explain] workspace ${workspaceId}: ${gatedTotal} gated subjects, returning top ${ranked.length}` +
        (activeMissions.length === MISSION_SCAN_LIMIT ? ` (mission scan hit the ${MISSION_SCAN_LIMIT} cap)` : ''),
    );
  }

  return {
    scope: 'workspace',
    subjects: ranked,
    considered: answers.length,
    quiet: answers.length - gatedTotal,
  };
}
