/**
 * Failure Pattern Sentinel — the scheduler/collector layer.
 *
 * `failure-pattern-sentinel.ts` is the pure rule engine, `failure-incident-store.ts`
 * persists candidates, `failure-incident-actions.ts` triages/pages/files fix tasks.
 * This module is the fourth piece none of those own: turning "it is time to look"
 * into bounded, structured `SentinelFacts` and running the other three in order,
 * from two different callers — a deferred post-transition trigger
 * (`failure-pattern-sentinel-trigger.ts`) and the 30-minute cron backstop
 * (`/api/cron/failure-pattern-sentinel`). Both call the exact same
 * `runFailurePatternSweep`, so "duplicate trigger + cron evaluation must be
 * idempotent" reduces to the incident store's own upsert idempotency — there is
 * only one code path to keep idempotent, not two.
 *
 * `SweepDeps` is a port, same seam as `IncidentStorePort` / `FixTaskPort`: the
 * orchestration below (window math, counters, per-workspace isolation,
 * self-health) is tested against a fake with no database at all;
 * `productionSweepDeps` is the only thing that touches Postgres.
 *
 * Watermark: one ISO timestamp per workspace in `system_cache`
 * (`failure-sentinel-watermark:<workspaceId>`), advanced monotonically (a
 * compare-and-swap-free `WHERE stored < new` on write, so a cron run and a
 * triggered run racing on the same workspace can never move it backwards).
 * Each fact kind reads from `min(watermark, now - its own rolling-window
 * lookback)` — never just the watermark — because a rule like "N tasks failed
 * with the same signature in the last hour" needs the WHOLE trailing hour on
 * every run, not only rows newer than the last checkpoint, or a failure from
 * 50 minutes ago would silently stop counting toward the current window the
 * moment the checkpoint passes it. The watermark still does its job: it is the
 * floor for everything OLDER than each rule's own lookback, so a sweep that
 * runs every few minutes never re-reads a full day of history for no reason.
 */
import type {
  FailureIncidentRule,
  FailureIncidentSeverity,
} from '@buildd/shared';
import {
  detectFailurePatterns,
  FAILURE_PATTERN_DETECTOR_VERSION,
  type IncidentCandidate,
  type SentinelFacts,
} from './failure-pattern-sentinel';
import {
  recordIncidentCandidates,
  type IncidentStorePort,
  type UpsertIncidentResult,
} from './failure-incident-store';
import {
  actOnIncidentResults,
  type FixTaskPort,
  type IncidentActionResult,
  type IncidentAlertSender,
  type IncidentDecider,
} from './failure-incident-actions';

// ── Window math (pure) ──────────────────────────────────────────────────────

/**
 * How far back each fact kind needs to look, in minutes, to give its rule(s)
 * a complete rolling window every run — see `failure-pattern-sentinel.ts`'s
 * `DEFAULT_SENTINEL_THRESHOLDS`. `workerFailures` covers both
 * `repeatedFailureWindowMinutes` (60) and `outputUnmetWindowMinutes` (360);
 * `gateEvents` / `pathOverlap` have no explicit window in the engine (their
 * rules count everything handed to them), so the collector's own lookback IS
 * the effective window — chosen to match the 24h cadence the rest of the
 * platform already uses for "has this stopped moving" judgments (queue-stall's
 * `RENOTIFY_HOURS`, mission-invariants' thresholds). `retryLineage` is wider
 * because a fix-attempt chain can legitimately span days between CI runs.
 */
export const SWEEP_LOOKBACK_MINUTES = {
  workerFailures: 360,
  gateEvents: 1440,
  pathOverlap: 1440,
  retryLineage: 10_080,
  failureRateRecent: 60,
  failureRateBaseline: 1440,
} as const;

export interface SweepFloors {
  workerFailuresSince: string;
  gateEventsSince: string;
  pathOverlapSince: string;
  retrySince: string;
  failureRateRecentSince: string;
  failureRateBaselineSince: string;
}

export function minutesBeforeIso(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) - minutes * 60_000).toISOString();
}

/** The earlier of the watermark and the rolling-window floor — never later than either. */
export function effectiveFloor(watermark: string | null, now: string, lookbackMinutes: number): string {
  const rolling = minutesBeforeIso(now, lookbackMinutes);
  if (!watermark) return rolling;
  return watermark < rolling ? watermark : rolling;
}

export function computeSweepFloors(watermark: string | null, now: string): SweepFloors {
  return {
    workerFailuresSince: effectiveFloor(watermark, now, SWEEP_LOOKBACK_MINUTES.workerFailures),
    gateEventsSince: effectiveFloor(watermark, now, SWEEP_LOOKBACK_MINUTES.gateEvents),
    pathOverlapSince: effectiveFloor(watermark, now, SWEEP_LOOKBACK_MINUTES.pathOverlap),
    retrySince: effectiveFloor(watermark, now, SWEEP_LOOKBACK_MINUTES.retryLineage),
    // Deliberately NOT watermark-adjusted: this is a point-in-time rate
    // snapshot (recent vs. baseline), always recomputed over its own fixed
    // trailing windows, never "since last checkpoint".
    failureRateRecentSince: minutesBeforeIso(now, SWEEP_LOOKBACK_MINUTES.failureRateRecent),
    failureRateBaselineSince: minutesBeforeIso(
      now,
      SWEEP_LOOKBACK_MINUTES.failureRateRecent + SWEEP_LOOKBACK_MINUTES.failureRateBaseline,
    ),
  };
}

// ── Ports ────────────────────────────────────────────────────────────────────

export interface SweepDeps {
  listWorkspaceIds(): Promise<string[]>;
  getWatermark(workspaceId: string): Promise<string | null>;
  setWatermark(workspaceId: string, at: string): Promise<void>;
  collectFacts(workspaceId: string, floors: SweepFloors, now: string): Promise<SentinelFacts>;
  /** Defaults (DB-backed) apply when omitted — see `recordIncidentCandidates` / `actOnIncidentResults`. */
  incidentPort?: IncidentStorePort;
  decide?: IncidentDecider | null;
  send?: IncidentAlertSender;
  fixTasks?: FixTaskPort | null;
  /** The existing ops-error reporting path (`reportOps`), never a new incident. */
  reportOpsError(message: string, detail: string, severity: 'warning' | 'error' | 'critical'): Promise<void>;
  /**
   * Durable consecutive-degraded-run counter. `ok: false` increments, `ok: true`
   * resets to 0. Never throws; a storage failure here must not crash the sweep.
   */
  recordSelfHealth(ok: boolean, now: string): Promise<{ consecutiveFailures: number }>;
}

// ── Counters ─────────────────────────────────────────────────────────────────

export interface SweepRunCounters {
  workspacesEvaluated: number;
  windowsEvaluated: number;
  candidates: number;
  incidentsOpened: number;
  incidentsUpdated: number;
  duplicatesSuppressed: number;
  alertsSent: number;
  fixTasksFiled: number;
  runFailures: number;
  elapsedMs: number;
  costUsd: number;
}

function emptyCounters(): SweepRunCounters {
  return {
    workspacesEvaluated: 0,
    windowsEvaluated: 0,
    candidates: 0,
    incidentsOpened: 0,
    incidentsUpdated: 0,
    duplicatesSuppressed: 0,
    alertsSent: 0,
    fixTasksFiled: 0,
    runFailures: 0,
    elapsedMs: 0,
    costUsd: 0,
  };
}

function tallyUpsertResults(results: ReadonlyArray<UpsertIncidentResult>, counters: SweepRunCounters): void {
  for (const r of results) {
    if (r.outcome === 'unchanged') counters.duplicatesSuppressed++;
    else if (r.outcome === 'opened') counters.incidentsOpened++;
    else counters.incidentsUpdated++; // 'updated' | 'reopened'
  }
}

function tallyActionResults(results: ReadonlyArray<IncidentActionResult>, counters: SweepRunCounters): void {
  for (const r of results) {
    if (r.alert?.sent) counters.alertsSent++;
    if (r.fixTask?.action === 'created') counters.fixTasksFiled++;
  }
}

// ── Self-health escalation ───────────────────────────────────────────────────

/**
 * Consecutive runs where at least half of evaluated workspaces errored before
 * the self-health floor opens an incident about the SENTINEL rather than the
 * workspaces it watches. Deliberately coarse: an occasional flaky workspace
 * must never trip this (that is exactly the per-workspace isolation this
 * module exists to guarantee); only the sentinel itself being systemically
 * broken — a bad deploy, a schema drift, Postgres down — does.
 */
export const SELF_HEALTH_CONSECUTIVE_THRESHOLD = 3;
/** Share of evaluated workspaces that must fail for a run to count as degraded. */
const SELF_HEALTH_DEGRADED_RATIO = 0.5;

/** Reserved signature — never producible by the rule engine, which always keys on real facts. */
export const SELF_HEALTH_SIGNATURE = 'repeated_failure|ws=none|sentinel_self_health_degraded';
export const SELF_HEALTH_REASON_CODE = 'sentinel.self_health_degraded';
const SELF_HEALTH_RULE: FailureIncidentRule = 'repeated_failure';
const SELF_HEALTH_SEVERITY: FailureIncidentSeverity = 'critical';

function selfHealthCandidate(now: string, consecutiveFailures: number): IncidentCandidate {
  const occurrence = { kind: 'worker' as const, id: `self-health:${now}`, at: now };
  return {
    rule: SELF_HEALTH_RULE,
    reasonCode: SELF_HEALTH_REASON_CODE,
    signature: SELF_HEALTH_SIGNATURE,
    detectorVersion: FAILURE_PATTERN_DETECTOR_VERSION,
    workspaceId: null,
    severity: SELF_HEALTH_SEVERITY,
    title: `Failure Pattern Sentinel degraded on most workspaces for ${consecutiveFailures} runs in a row`,
    occurrences: [occurrence],
    evidence: [occurrence],
    affected: { taskIds: [], workerIds: [], prNumbers: [] },
    impact: { consecutiveDegradedRuns: consecutiveFailures },
    firstObservedAt: now,
    lastObservedAt: now,
  };
}

/**
 * Open or update the one incident that represents the sentinel's own health.
 * Critical severity is a floor by rule (see `triageIncident`), so this always
 * pages regardless of the decision policy — `decide: null` skips asking a
 * model entirely. No fix task: a human investigating the platform is the
 * right response, not an auto-filed bug about itself.
 */
async function escalateSelfHealth(deps: SweepDeps, now: string, consecutiveFailures: number): Promise<void> {
  const results = await recordIncidentCandidates(
    [selfHealthCandidate(now, consecutiveFailures)],
    { port: deps.incidentPort },
  );
  await actOnIncidentResults(results, {
    port: deps.incidentPort,
    decide: null,
    send: deps.send,
    fixTasks: null,
    now: () => now,
  });
}

// ── One workspace ────────────────────────────────────────────────────────────

async function sweepOneWorkspace(
  deps: SweepDeps,
  workspaceId: string,
  now: string,
  counters: SweepRunCounters,
): Promise<void> {
  const watermark = await deps.getWatermark(workspaceId);
  const floors = computeSweepFloors(watermark, now);
  const facts = await deps.collectFacts(workspaceId, floors, now);

  const candidates = detectFailurePatterns(facts);
  counters.candidates += candidates.length;

  if (candidates.length > 0) {
    const results = await recordIncidentCandidates(candidates, {
      port: deps.incidentPort,
      onError: (err, candidate) => {
        counters.runFailures++;
        void deps.reportOpsError(
          `Failure Pattern Sentinel: incident upsert failed for workspace ${workspaceId}`,
          `${candidate?.signature ?? '(store unavailable)'}: ${err instanceof Error ? err.message : String(err)}`,
          'error',
        );
      },
    });
    tallyUpsertResults(results, counters);

    const changed = results.filter(r => r.outcome !== 'unchanged');
    if (changed.length > 0) {
      const actions = await actOnIncidentResults(results, {
        port: deps.incidentPort,
        decide: deps.decide,
        send: deps.send,
        fixTasks: deps.fixTasks,
        now: () => now,
        onError: (err, incidentId, step) => {
          counters.runFailures++;
          void deps.reportOpsError(
            `Failure Pattern Sentinel: ${step} failed for an incident in workspace ${workspaceId}`,
            `incident ${incidentId}: ${err instanceof Error ? err.message : String(err)}`,
            'error',
          );
        },
      });
      tallyActionResults(actions, counters);
    }
  }

  // Advance the watermark even on a quiet sweep (no candidates): "nothing new"
  // is still progress, and the next run's floor should start from here.
  await deps.setWatermark(workspaceId, now);
  counters.workspacesEvaluated++;
  counters.windowsEvaluated++;
}

// ── The sweep ────────────────────────────────────────────────────────────────

export interface SweepOpts {
  /** Explicit scope (the triggered, single-workspace path). Omit to sweep every workspace (the cron backstop). */
  workspaceIds?: string[];
  now?: () => string;
}

/**
 * Run the sentinel over one or every workspace. Never throws: every failure
 * mode — listing workspaces, collecting facts for one of them, the store, the
 * action layer — is caught, reported via `deps.reportOpsError` (the existing
 * ops-error path), and counted in `runFailures`. One workspace's failure never
 * stops the rest (`for` + inner `try/catch`, not `Promise.all` that could
 * short-circuit).
 *
 * Self-health: tracked once per sweep invocation (not per workspace) — a run
 * is "degraded" when at least half the workspaces it tried to evaluate
 * errored, or it could not even list them. `SELF_HEALTH_CONSECUTIVE_THRESHOLD`
 * consecutive degraded runs escalate to one incident about the sentinel
 * itself; anything short of that is an ops error only, never a sentinel
 * incident about a workspace that did nothing wrong.
 */
export async function runFailurePatternSweep(deps: SweepDeps, opts: SweepOpts = {}): Promise<SweepRunCounters> {
  const start = Date.now();
  const now = (opts.now ?? (() => new Date().toISOString()))();
  const counters = emptyCounters();

  let workspaceIds: string[];
  try {
    workspaceIds = opts.workspaceIds ?? await deps.listWorkspaceIds();
  } catch (err) {
    console.error('[failure-pattern-sweep] could not list workspaces:', err);
    await deps.reportOpsError(
      'Failure Pattern Sentinel: could not list workspaces to sweep',
      err instanceof Error ? err.message : String(err),
      'error',
    ).catch(() => {});
    counters.runFailures++;
    await finishDegradedRun(deps, now, counters);
    counters.elapsedMs = Date.now() - start;
    return counters;
  }

  for (const workspaceId of workspaceIds) {
    try {
      await sweepOneWorkspace(deps, workspaceId, now, counters);
    } catch (err) {
      counters.runFailures++;
      console.error(`[failure-pattern-sweep] workspace ${workspaceId} failed:`, err);
      await deps.reportOpsError(
        `Failure Pattern Sentinel: sweep failed for workspace ${workspaceId}`,
        err instanceof Error ? err.message : String(err),
        'error',
      ).catch(() => {});
    }
  }

  const degraded = workspaceIds.length === 0
    ? counters.runFailures > 0
    : counters.runFailures / workspaceIds.length >= SELF_HEALTH_DEGRADED_RATIO;
  if (degraded) {
    await finishDegradedRun(deps, now, counters);
  } else {
    await deps.recordSelfHealth(true, now).catch(() => {});
  }

  counters.elapsedMs = Date.now() - start;
  return counters;
}

async function finishDegradedRun(deps: SweepDeps, now: string, counters: SweepRunCounters): Promise<void> {
  let consecutiveFailures = 0;
  try {
    ({ consecutiveFailures } = await deps.recordSelfHealth(false, now));
  } catch (err) {
    console.error('[failure-pattern-sweep] self-health tracking failed:', err);
    return;
  }
  if (consecutiveFailures >= SELF_HEALTH_CONSECUTIVE_THRESHOLD) {
    try {
      await escalateSelfHealth(deps, now, consecutiveFailures);
    } catch (err) {
      console.error('[failure-pattern-sweep] self-health escalation failed:', err);
    }
  }
}

// ── Production deps (DB-backed) ─────────────────────────────────────────────

const SWEEP_MAX_ROWS = 2000;
const SELF_HEALTH_KEY = 'failure-sentinel:self-health';
const watermarkKey = (workspaceId: string) => `failure-sentinel-watermark:${workspaceId}`;

async function dbCollectFacts(workspaceId: string, floors: SweepFloors, now: string): Promise<SentinelFacts> {
  const { db } = await import('@buildd/core/db');
  const { workers, tasks, gateEvents } = await import('@buildd/core/db/schema');
  const { and, eq, gte, lt, inArray, isNotNull, or, desc } = await import('drizzle-orm');
  const { GATE_SLUGS } = await import('@buildd/core/gate-slugs');
  const { normalizeErrorSignature } = await import('./error-signature');
  const { FAILED_WORKER_STATUSES } = await import('@buildd/shared');
  const { IN_FLIGHT_WORKER_STATUSES } = await import('./failure-analytics');

  // ── worker failures ────────────────────────────────────────────────────
  const failedWorkerRows = await db
    .select({
      id: workers.id,
      taskId: workers.taskId,
      error: workers.error,
      exitCause: workers.exitCause,
      createdAt: workers.createdAt,
      completedAt: workers.completedAt,
    })
    .from(workers)
    .where(and(
      eq(workers.workspaceId, workspaceId),
      inArray(workers.status, [...FAILED_WORKER_STATUSES]),
      gte(workers.createdAt, new Date(floors.workerFailuresSince)),
    ))
    .limit(SWEEP_MAX_ROWS);

  const failedTaskIds = [...new Set(failedWorkerRows.map(r => r.taskId).filter((id): id is string => !!id))];
  const rootByTask = new Map<string, string>();
  if (failedTaskIds.length > 0) {
    const taskRows = await db.select({ id: tasks.id, context: tasks.context }).from(tasks).where(inArray(tasks.id, failedTaskIds));
    for (const t of taskRows) {
      const ctx = (t.context ?? {}) as Record<string, unknown>;
      rootByTask.set(t.id, typeof ctx.rootTaskId === 'string' && ctx.rootTaskId ? ctx.rootTaskId : t.id);
    }
  }

  const outputUnmetWorkerIds = failedWorkerRows.filter(r => r.exitCause === 'output_unmet').map(r => r.id);
  const boundaryByWorker = new Map<string, string>();
  if (outputUnmetWorkerIds.length > 0) {
    const boundaryRows = await db
      .select({ workerId: gateEvents.workerId, reason: gateEvents.reason })
      .from(gateEvents)
      .where(and(eq(gateEvents.gate, GATE_SLUGS.OUTPUT_REQUIREMENT), inArray(gateEvents.workerId, outputUnmetWorkerIds)))
      .orderBy(desc(gateEvents.occurredAt));
    for (const b of boundaryRows) {
      if (b.workerId && !boundaryByWorker.has(b.workerId)) boundaryByWorker.set(b.workerId, b.reason);
    }
  }

  const workerFailures: SentinelFacts['workerFailures'] = failedWorkerRows.map(r => ({
    workerId: r.id,
    taskId: r.taskId,
    rootTaskId: r.taskId ? (rootByTask.get(r.taskId) ?? r.taskId) : null,
    signature: normalizeErrorSignature(r.error),
    exitCause: r.exitCause,
    lifecycleBoundary: r.exitCause === 'output_unmet' ? (boundaryByWorker.get(r.id) ?? null) : null,
    occurredAt: (r.completedAt ?? r.createdAt).toISOString(),
  }));

  // ── stranded gate events ───────────────────────────────────────────────
  const strandedRows = await db
    .select({ id: gateEvents.id, gate: gateEvents.gate, outcome: gateEvents.outcome, reason: gateEvents.reason, taskId: gateEvents.taskId, occurredAt: gateEvents.occurredAt })
    .from(gateEvents)
    .where(and(eq(gateEvents.workspaceId, workspaceId), eq(gateEvents.outcome, 'stranded'), gte(gateEvents.occurredAt, new Date(floors.gateEventsSince))))
    .limit(SWEEP_MAX_ROWS);
  const gateEventFacts: SentinelFacts['gateEvents'] = strandedRows.map(r => ({
    id: r.id, gate: r.gate, outcome: r.outcome, reason: r.reason, taskId: r.taskId, occurredAt: r.occurredAt.toISOString(),
  }));

  // ── path-overlap deferrals, collapsed one entry per task ──────────────
  const deferralRows = await db
    .select({ taskId: gateEvents.taskId, detail: gateEvents.detail, occurredAt: gateEvents.occurredAt })
    .from(gateEvents)
    .where(and(
      eq(gateEvents.workspaceId, workspaceId),
      eq(gateEvents.gate, GATE_SLUGS.CLAIM_LOOP_DEFERRAL),
      eq(gateEvents.outcome, 'deferred'),
      eq(gateEvents.reason, 'path_overlap'),
      gte(gateEvents.occurredAt, new Date(floors.pathOverlapSince)),
    ))
    .orderBy(desc(gateEvents.occurredAt))
    .limit(SWEEP_MAX_ROWS);

  const byTask = new Map<string, { firstDeferredAt: string; lastDeferredAt: string; blockingPrNumber: number | null }>();
  for (const r of deferralRows) {
    if (!r.taskId) continue;
    const detail = (r.detail ?? {}) as Record<string, unknown>;
    const occurredIso = r.occurredAt.toISOString();
    const detailFirst = typeof detail.firstDeferredAt === 'string' ? detail.firstDeferredAt : occurredIso;
    const blockingPrNumber = typeof detail.prNumber === 'number' ? detail.prNumber : null;
    const prior = byTask.get(r.taskId);
    if (!prior) {
      byTask.set(r.taskId, { firstDeferredAt: detailFirst, lastDeferredAt: occurredIso, blockingPrNumber });
    } else if (detailFirst < prior.firstDeferredAt) {
      prior.firstDeferredAt = detailFirst;
    }
  }
  const pathOverlapDeferrals: SentinelFacts['pathOverlapDeferrals'] = [];
  if (byTask.size > 0) {
    const taskIds = [...byTask.keys()];
    const workerRows = await db.select({ taskId: workers.taskId, createdAt: workers.createdAt }).from(workers).where(inArray(workers.taskId, taskIds));
    const latestWorkerByTask = new Map<string, string>();
    for (const w of workerRows) {
      if (!w.taskId) continue;
      const iso = w.createdAt.toISOString();
      const prev = latestWorkerByTask.get(w.taskId);
      if (!prev || iso > prev) latestWorkerByTask.set(w.taskId, iso);
    }
    for (const [taskId, d] of byTask) {
      const workerAt = latestWorkerByTask.get(taskId) ?? null;
      pathOverlapDeferrals.push({
        taskId,
        blockingPrNumber: d.blockingPrNumber,
        firstDeferredAt: d.firstDeferredAt,
        lastDeferredAt: d.lastDeferredAt,
        lastProgressAt: workerAt && workerAt > d.firstDeferredAt ? workerAt : null,
      });
    }
  }

  // ── retry children + lineages ──────────────────────────────────────────
  const retryRows = await db
    .select({
      id: tasks.id,
      parentTaskId: tasks.parentTaskId,
      ciRetryPrNumber: tasks.ciRetryPrNumber,
      ciRetryHeadSha: tasks.ciRetryHeadSha,
      conflictRetryPrNumber: tasks.conflictRetryPrNumber,
      conflictRetryHeadSha: tasks.conflictRetryHeadSha,
      reviewerRetryPrNumber: tasks.reviewerRetryPrNumber,
      reviewerRetryHeadSha: tasks.reviewerRetryHeadSha,
      context: tasks.context,
      createdAt: tasks.createdAt,
    })
    .from(tasks)
    .where(and(
      eq(tasks.workspaceId, workspaceId),
      gte(tasks.createdAt, new Date(floors.retrySince)),
      or(isNotNull(tasks.ciRetryPrNumber), isNotNull(tasks.conflictRetryPrNumber), isNotNull(tasks.reviewerRetryPrNumber)),
    ))
    .limit(SWEEP_MAX_ROWS);

  const retryChildren: SentinelFacts['retryChildren'] = [];
  const lineages: SentinelFacts['lineages'] = [];
  if (retryRows.length > 0) {
    const retryTaskIds = retryRows.map(r => r.id);
    const retryWorkerRows = await db
      .select({ taskId: workers.taskId, prNumber: workers.prNumber, mergedAt: workers.mergedAt, prLifecycleStatus: workers.prLifecycleStatus, createdAt: workers.createdAt })
      .from(workers)
      .where(inArray(workers.taskId, retryTaskIds));
    const workerByTask = new Map<string, (typeof retryWorkerRows)[number]>();
    for (const w of retryWorkerRows) {
      if (!w.taskId) continue;
      const existing = workerByTask.get(w.taskId);
      // Prefer the row that actually carries a PR number.
      if (!existing || (!existing.prNumber && w.prNumber)) workerByTask.set(w.taskId, w);
    }

    for (const r of retryRows) {
      const ctx = (r.context ?? {}) as Record<string, unknown>;
      const iteration = typeof ctx.iteration === 'number'
        ? ctx.iteration
        : typeof ctx.conflictIteration === 'number' ? ctx.conflictIteration : null;
      const own = workerByTask.get(r.id);
      const createdAtIso = r.createdAt.toISOString();
      const push = (kind: 'ci' | 'reviewer' | 'conflict', subjectPrNumber: number, stage: string | null) => {
        retryChildren.push({
          taskId: r.id,
          parentTaskId: r.parentTaskId,
          subjectPrNumber,
          kind,
          stage,
          iteration,
          createdAt: createdAtIso,
          openedPrNumber: own?.prNumber && own.prNumber !== subjectPrNumber ? own.prNumber : null,
        });
      };
      if (r.ciRetryPrNumber != null) push('ci', r.ciRetryPrNumber, r.ciRetryHeadSha);
      if (r.conflictRetryPrNumber != null) push('conflict', r.conflictRetryPrNumber, r.conflictRetryHeadSha);
      if (r.reviewerRetryPrNumber != null) push('reviewer', r.reviewerRetryPrNumber, r.reviewerRetryHeadSha);
    }

    const byRoot = new Map<string, { taskIds: Set<string>; prs: Map<number, { number: number; state: 'open' | 'merged' | 'closed'; at: string }> }>();
    for (const r of retryRows) {
      const ctx = (r.context ?? {}) as Record<string, unknown>;
      const rootTaskId = typeof ctx.rootTaskId === 'string' && ctx.rootTaskId ? ctx.rootTaskId : (r.parentTaskId ?? r.id);
      let g = byRoot.get(rootTaskId);
      if (!g) { g = { taskIds: new Set(), prs: new Map() }; byRoot.set(rootTaskId, g); }
      g.taskIds.add(r.id);
      const w = workerByTask.get(r.id);
      const prNumber = w?.prNumber ?? r.ciRetryPrNumber ?? r.conflictRetryPrNumber ?? r.reviewerRetryPrNumber ?? null;
      if (prNumber) {
        const state: 'open' | 'merged' | 'closed' = w?.mergedAt ? 'merged' : w?.prLifecycleStatus === 'closed' ? 'closed' : 'open';
        const at = (w?.createdAt ?? r.createdAt).toISOString();
        const prev = g.prs.get(prNumber);
        if (!prev || at > prev.at) g.prs.set(prNumber, { number: prNumber, state, at });
      }
    }
    for (const [rootTaskId, g] of byRoot) {
      lineages.push({ rootTaskId, taskIds: [...g.taskIds], prs: [...g.prs.values()] });
    }
  }

  // ── failure rate: recent vs. baseline ──────────────────────────────────
  const loadTerminalCounts = async (sinceIso: string, untilIso: string) => {
    const rows = await db
      .select({ id: workers.id, status: workers.status, createdAt: workers.createdAt })
      .from(workers)
      .where(and(eq(workers.workspaceId, workspaceId), gte(workers.createdAt, new Date(sinceIso)), lt(workers.createdAt, new Date(untilIso))))
      .limit(SWEEP_MAX_ROWS);
    let total = 0;
    let failed = 0;
    const failures: Array<{ workerId: string; at: string }> = [];
    for (const r of rows) {
      if ((IN_FLIGHT_WORKER_STATUSES as readonly string[]).includes(r.status)) continue;
      total++;
      if ((FAILED_WORKER_STATUSES as readonly string[]).includes(r.status)) {
        failed++;
        failures.push({ workerId: r.id, at: r.createdAt.toISOString() });
      }
    }
    return { counts: { failed, total }, failures };
  };
  const recent = await loadTerminalCounts(floors.failureRateRecentSince, now);
  const baseline = await loadTerminalCounts(floors.failureRateBaselineSince, floors.failureRateRecentSince);

  return {
    workspaceId,
    now,
    workerFailures,
    gateEvents: gateEventFacts,
    pathOverlapDeferrals,
    retryChildren,
    lineages,
    // No structured "ran on X, charged to Y" telemetry exists yet (see the
    // gotcha filed alongside this module) — the rule stays wired and dark
    // until a real source lands, rather than inventing one from logs.
    providerAttributions: [],
    failureRate: { recent: recent.counts, baseline: baseline.counts, recentFailures: recent.failures },
  };
}

/** Lazily built, DB-backed `SweepDeps`. The only export here that touches Postgres. */
export function productionSweepDeps(): SweepDeps {
  return {
    async listWorkspaceIds() {
      const { db } = await import('@buildd/core/db');
      const { workspaces } = await import('@buildd/core/db/schema');
      const { isNotNull } = await import('drizzle-orm');
      const rows = await db.select({ id: workspaces.id }).from(workspaces).where(isNotNull(workspaces.repo));
      return rows.map(r => r.id);
    },
    async getWatermark(workspaceId) {
      const { db } = await import('@buildd/core/db');
      const { systemCache } = await import('@buildd/core/db/schema');
      const { eq } = await import('drizzle-orm');
      const [row] = await db.select({ value: systemCache.value }).from(systemCache).where(eq(systemCache.key, watermarkKey(workspaceId))).limit(1);
      const v = row?.value as { at?: unknown } | undefined;
      return typeof v?.at === 'string' ? v.at : null;
    },
    async setWatermark(workspaceId, at) {
      const { db } = await import('@buildd/core/db');
      const { systemCache } = await import('@buildd/core/db/schema');
      const { sql } = await import('drizzle-orm');
      await db
        .insert(systemCache)
        .values({ key: watermarkKey(workspaceId), value: { at }, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: systemCache.key,
          set: { value: { at }, updatedAt: new Date() },
          // Monotonic: a slower-finishing run from an earlier tick must never
          // move the watermark backwards past a faster, later one.
          setWhere: sql`(${systemCache.value}->>'at') < ${at}`,
        });
    },
    collectFacts: dbCollectFacts,
    async reportOpsError(message, detail, severity) {
      const { reportOps } = await import('@buildd/core/report-ops');
      await reportOps({ source: 'failure-pattern-sentinel', severity, message, detail });
    },
    async recordSelfHealth(ok, _now) {
      const { db } = await import('@buildd/core/db');
      const { systemCache } = await import('@buildd/core/db/schema');
      const { eq } = await import('drizzle-orm');
      const [row] = await db.select({ value: systemCache.value }).from(systemCache).where(eq(systemCache.key, SELF_HEALTH_KEY)).limit(1);
      const consecutive = (row?.value as { consecutive?: unknown } | undefined)?.consecutive;
      const prev = typeof consecutive === 'number' ? consecutive : 0;
      const next = ok ? 0 : prev + 1;
      await db
        .insert(systemCache)
        .values({ key: SELF_HEALTH_KEY, value: { consecutive: next }, updatedAt: new Date() })
        .onConflictDoUpdate({ target: systemCache.key, set: { value: { consecutive: next }, updatedAt: new Date() } });
      return { consecutiveFailures: next };
    },
  };
}
