/**
 * Worker failure analytics.
 *
 * Aggregates terminal worker outcomes into failure rates, exit-cause breakdowns,
 * clustered error signatures, and a "died early" cohort (turns <= 2 at $0 cost —
 * workers that consumed a slot and produced nothing).
 *
 * Everything below the "Pure aggregation" heading is DB-free and unit tested;
 * `getFailureAnalytics` is the only function that touches Postgres. Read-only:
 * this module never mutates worker or task state.
 */
import { db } from '@buildd/core/db';
import { workers, tasks, workspaces } from '@buildd/core/db/schema';
import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import { toFrictionSignature } from '@buildd/core/failure-friction-signature';
import { normalizeErrorSignature, EMPTY_SIGNATURE } from './error-signature';
import type {
  FailureAnalytics,
  FailureExitCauseBucket,
  FailureExitCauseRow,
  FailureRepeatTaskRow,
  FailureRoleRow,
  FailureSignatureFamily,
  FailureSignatureRow,
  FailureTotals,
  FailureWindow,
  FailureWorkspaceRow,
  WorkerExitCause,
} from '@buildd/shared';

export type {
  FailureAnalytics,
  FailureExitCauseBucket,
  FailureExitCauseRow,
  FailureRepeatTaskRow,
  FailureRoleRow,
  FailureSignatureFamily,
  FailureSignatureRow,
  FailureTotals,
  FailureWindow,
  FailureWorkspaceRow,
};

/** Re-exported for existing server-side callers; the canonical home is `error-signature.ts`. */
export { normalizeErrorSignature, EMPTY_SIGNATURE };

// ── Constants ─────────────────────────────────────────────────────────────────

export const FAILURE_WINDOWS = ['24h', '7d', '30d'] as const;

const WINDOW_MS: Record<FailureWindow, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

/** Worker statuses that count as a failure. `error` is the legacy spelling. */
export const FAILED_WORKER_STATUSES = ['failed', 'error'] as const;

/**
 * Worker statuses that are still in flight.
 *
 * The failure rate divides by TERMINAL workers, and terminal is defined as the
 * complement of this list rather than as an allow-list of finished statuses: an
 * unrecognised status is far more likely to be a new terminal outcome than a new
 * in-flight one, and treating it as in-flight would silently deflate the rate.
 *
 * `superseded` (POST /api/workers/[id]/respond) is not literally in flight —
 * the session is over — but it belongs here for the same reason `waiting_input`
 * does: the worker never reached a real success/failure verdict, it was
 * replaced by a continuation task once a human answered its question. Counting
 * it as a terminal "success" (the default for any status outside
 * FAILED_WORKER_STATUSES) would inflate the success rate on every answered
 * question; counting it as a failure would misrepresent an answered question as
 * broken work. Excluding it from the terminal population is the only outcome
 * that doesn't lie in one direction or the other.
 */
export const IN_FLIGHT_WORKER_STATUSES = [
  'idle',
  'starting',
  'running',
  'waiting_input',
  'paused',
  'superseded',
] as const;

/** A failure at or under this many turns, at zero cost, never did any work. */
export const DIED_EARLY_MAX_TURNS = 2;

const UNCLASSIFIED: FailureExitCauseBucket = 'unclassified';
const NO_ROLE = '(no role)';
const UNKNOWN_WORKSPACE = '(unknown)';

const DEFAULT_MAX_SIGNATURES = 25;
const MAX_EXAMPLE_WORKER_IDS = 3;
/** Guard against pathological windows — 30d on a busy team is still bounded. */
const MAX_WORKER_ROWS = 5000;

// ── Input shape ───────────────────────────────────────────────────────────────

/** One worker row, already joined with its task's role slug. */
export interface FailureWorkerRow {
  id: string;
  taskId: string | null;
  workspaceId: string;
  roleSlug: string | null;
  status: string;
  error: string | null;
  exitCause: WorkerExitCause | null;
  turns: number;
  costUsd: number;
  createdAt: Date;
  completedAt: Date | null;
}

export interface FailureAnalyticsInput {
  window: FailureWindow;
  now: Date;
  workers: FailureWorkerRow[];
  /** workspaceId → display name. Missing ids render as '(unknown)'. */
  workspaceNames?: Record<string, string>;
  /** taskId → title. Missing ids render as null. */
  taskTitles?: Record<string, string>;
  maxSignatures?: number;
}

// ── Window helpers ────────────────────────────────────────────────────────────

/** Coerce an untrusted query param into a supported window (default 7d). */
export function parseFailureWindow(raw: string | null | undefined): FailureWindow {
  return (FAILURE_WINDOWS as readonly string[]).includes(raw ?? '')
    ? (raw as FailureWindow)
    : '7d';
}

export function windowStartFor(window: FailureWindow, now: Date): Date {
  return new Date(now.getTime() - WINDOW_MS[window]);
}

// ── Pure aggregation ──────────────────────────────────────────────────────────

function isFailure(status: string): boolean {
  return (FAILED_WORKER_STATUSES as readonly string[]).includes(status);
}

/** Has this worker had the chance to fail yet? See IN_FLIGHT_WORKER_STATUSES. */
export function isTerminalWorkerStatus(status: string): boolean {
  return !(IN_FLIGHT_WORKER_STATUSES as readonly string[]).includes(status);
}

/** A failure that burned a slot without doing any billable work. */
export function isDiedEarly(row: FailureWorkerRow): boolean {
  return isFailure(row.status) && row.turns <= DIED_EARLY_MAX_TURNS && row.costUsd === 0;
}

function failedAt(row: FailureWorkerRow): Date {
  return row.completedAt ?? row.createdAt;
}

function pct(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 100);
}

interface SignatureAccumulator {
  signature: string;
  count: number;
  firstSeen: number;
  lastSeen: number;
  exampleWorkerIds: string[];
  exampleError: string | null;
  exampleTaskId: string | null;
  diedEarlyCount: number;
  exitCauses: Set<FailureExitCauseBucket>;
}

function buildSignatures(rows: FailureWorkerRow[], limit: number): FailureSignatureRow[] {
  const byKey = new Map<string, SignatureAccumulator>();

  for (const row of rows) {
    const signature = normalizeErrorSignature(row.error);
    const ts = failedAt(row).getTime();
    let acc = byKey.get(signature);
    if (!acc) {
      acc = {
        signature,
        count: 0,
        firstSeen: ts,
        lastSeen: ts,
        exampleWorkerIds: [],
        exampleError: row.error ?? null,
        exampleTaskId: row.taskId ?? null,
        diedEarlyCount: 0,
        exitCauses: new Set<FailureExitCauseBucket>(),
      };
      byKey.set(signature, acc);
    }
    acc.count += 1;
    if (ts < acc.firstSeen) acc.firstSeen = ts;
    if (ts > acc.lastSeen) acc.lastSeen = ts;
    if (acc.exampleWorkerIds.length < MAX_EXAMPLE_WORKER_IDS) acc.exampleWorkerIds.push(row.id);
    if (!acc.exampleTaskId && row.taskId) acc.exampleTaskId = row.taskId;
    if (!acc.exampleError && row.error) acc.exampleError = row.error;
    if (isDiedEarly(row)) acc.diedEarlyCount += 1;
    acc.exitCauses.add(row.exitCause ?? UNCLASSIFIED);
  }

  return [...byKey.values()]
    .sort((a, b) => b.count - a.count || b.lastSeen - a.lastSeen || a.signature.localeCompare(b.signature))
    .slice(0, limit)
    .map(acc => ({
      signature: acc.signature,
      count: acc.count,
      firstSeen: new Date(acc.firstSeen).toISOString(),
      lastSeen: new Date(acc.lastSeen).toISOString(),
      exampleWorkerIds: acc.exampleWorkerIds,
      exampleError: acc.exampleError,
      exampleTaskId: acc.exampleTaskId,
      diedEarlyCount: acc.diedEarlyCount,
      exitCauses: [...acc.exitCauses].sort(),
    }));
}

const FAMILY_TOP_SIGNATURES = 5;

/**
 * Aggregate every failure signature sharing a literal prefix into one rollup.
 *
 * `buildSignatures` above already discards this once it slices to the top-N
 * ranking: a family of errors that differ only in embedded free text (e.g.
 * `needs_input: <question>`) becomes dozens of singleton signatures, each
 * individually too small to rank, with no way to answer "how big is this
 * family as a whole?" This operates on the full row set instead of the
 * capped ranking, which is the entire point.
 *
 * The match is a literal, case-sensitive prefix test against each row's
 * *normalized* signature — the prefix itself is not run through the
 * normalizer, so the caller is expected to pass the same literal text the
 * signatures already start with (e.g. "needs_input:").
 */
export function buildSignatureFamily(rows: FailureWorkerRow[], prefix: string): FailureSignatureFamily {
  const bySignature = new Map<string, number>();
  let count = 0;
  let firstSeen: number | null = null;
  let lastSeen: number | null = null;
  let diedEarlyCount = 0;
  let exampleTaskId: string | null = null;
  const exitCauses = new Set<FailureExitCauseBucket>();

  for (const row of rows) {
    if (!isFailure(row.status)) continue;
    const sig = normalizeErrorSignature(row.error);
    if (!sig.startsWith(prefix)) continue;

    count += 1;
    const ts = failedAt(row).getTime();
    if (firstSeen === null || ts < firstSeen) firstSeen = ts;
    if (lastSeen === null || ts > lastSeen) lastSeen = ts;
    if (isDiedEarly(row)) diedEarlyCount += 1;
    if (!exampleTaskId && row.taskId) exampleTaskId = row.taskId;
    exitCauses.add(row.exitCause ?? UNCLASSIFIED);
    bySignature.set(sig, (bySignature.get(sig) ?? 0) + 1);
  }

  const topSignatures = [...bySignature.entries()]
    .map(([signature, sigCount]) => ({ signature, count: sigCount }))
    .sort((a, b) => b.count - a.count || a.signature.localeCompare(b.signature))
    .slice(0, FAMILY_TOP_SIGNATURES);

  return {
    prefix,
    known: count > 0,
    count,
    distinctSignatures: bySignature.size,
    firstSeen: firstSeen !== null ? new Date(firstSeen).toISOString() : null,
    lastSeen: lastSeen !== null ? new Date(lastSeen).toISOString() : null,
    diedEarlyCount,
    exitCauses: [...exitCauses].sort(),
    exampleTaskId,
    frictionSignature: toFrictionSignature(prefix),
    topSignatures,
  };
}

/**
 * Aggregate a window of worker rows into a failure report.
 * Pure — no DB access, no clock reads (pass `now`).
 */
export function computeFailureAnalytics(input: FailureAnalyticsInput): FailureAnalytics {
  const { window, now, workers: rows } = input;
  const workspaceNames = input.workspaceNames ?? {};
  const taskTitles = input.taskTitles ?? {};
  const maxSignatures = input.maxSignatures ?? DEFAULT_MAX_SIGNATURES;

  const failures = rows.filter(r => isFailure(r.status));
  const diedEarlyRows = failures.filter(isDiedEarly);
  const terminal = rows.filter(r => isTerminalWorkerStatus(r.status)).length;

  const totals: FailureTotals = {
    started: rows.length,
    terminal,
    stillRunning: rows.length - terminal,
    completed: rows.filter(r => r.status === 'completed').length,
    failed: failures.length,
    // Terminal, not started: an in-flight worker cannot have failed yet, so
    // including it drags the rate down and makes the published number drift
    // downward purely because work is still running.
    failureRatePct: pct(failures.length, terminal),
    diedEarly: diedEarlyRows.length,
    diedEarlySharePct: pct(diedEarlyRows.length, failures.length),
  };

  // ── Exit-cause breakdown (nulls surface as 'unclassified') ──────────────────
  const causeCounts = new Map<FailureExitCauseBucket, number>();
  for (const r of failures) {
    const bucket = r.exitCause ?? UNCLASSIFIED;
    causeCounts.set(bucket, (causeCounts.get(bucket) ?? 0) + 1);
  }
  const byExitCause: FailureExitCauseRow[] = [...causeCounts.entries()]
    .map(([exitCause, count]) => ({ exitCause, count, sharePct: pct(count, failures.length) }))
    .sort((a, b) => b.count - a.count || a.exitCause.localeCompare(b.exitCause));

  // ── Per-role and per-workspace rates ───────────────────────────────────────
  const roleTallies = new Map<string, { started: number; terminal: number; failed: number }>();
  const wsTallies = new Map<string, { started: number; terminal: number; failed: number }>();
  for (const r of rows) {
    const isTerminal = isTerminalWorkerStatus(r.status);
    const roleKey = r.roleSlug ?? NO_ROLE;
    const role = roleTallies.get(roleKey) ?? { started: 0, terminal: 0, failed: 0 };
    role.started += 1;
    if (isTerminal) role.terminal += 1;
    if (isFailure(r.status)) role.failed += 1;
    roleTallies.set(roleKey, role);

    const ws = wsTallies.get(r.workspaceId) ?? { started: 0, terminal: 0, failed: 0 };
    ws.started += 1;
    if (isTerminal) ws.terminal += 1;
    if (isFailure(r.status)) ws.failed += 1;
    wsTallies.set(r.workspaceId, ws);
  }

  // Same denominator as the headline: a per-role rate computed over a different
  // population than the number above it is a new inconsistency, not a fix.
  const byRole: FailureRoleRow[] = [...roleTallies.entries()]
    .map(([roleSlug, t]) => ({
      roleSlug,
      started: t.started,
      terminal: t.terminal,
      failed: t.failed,
      failureRatePct: pct(t.failed, t.terminal),
    }))
    .sort((a, b) => b.failed - a.failed || b.failureRatePct - a.failureRatePct || a.roleSlug.localeCompare(b.roleSlug));

  const byWorkspace: FailureWorkspaceRow[] = [...wsTallies.entries()]
    .map(([workspaceId, t]) => ({
      workspaceId,
      workspaceName: workspaceNames[workspaceId] ?? UNKNOWN_WORKSPACE,
      started: t.started,
      terminal: t.terminal,
      failed: t.failed,
      failureRatePct: pct(t.failed, t.terminal),
    }))
    .sort((a, b) => b.failed - a.failed || b.failureRatePct - a.failureRatePct || a.workspaceName.localeCompare(b.workspaceName));

  // ── Repeat-failure tasks (>1 failed worker on the same task) ────────────────
  const taskTallies = new Map<string, { workspaceId: string; failedWorkers: number; lastFailureAt: number }>();
  for (const r of failures) {
    if (!r.taskId) continue;
    const ts = failedAt(r).getTime();
    const t = taskTallies.get(r.taskId) ?? { workspaceId: r.workspaceId, failedWorkers: 0, lastFailureAt: ts };
    t.failedWorkers += 1;
    if (ts > t.lastFailureAt) t.lastFailureAt = ts;
    taskTallies.set(r.taskId, t);
  }
  const repeatFailureTasks: FailureRepeatTaskRow[] = [...taskTallies.entries()]
    .filter(([, t]) => t.failedWorkers > 1)
    .map(([taskId, t]) => ({
      taskId,
      taskTitle: taskTitles[taskId] ?? null,
      workspaceId: t.workspaceId,
      failedWorkers: t.failedWorkers,
      lastFailureAt: new Date(t.lastFailureAt).toISOString(),
    }))
    .sort((a, b) => b.failedWorkers - a.failedWorkers || b.lastFailureAt.localeCompare(a.lastFailureAt));

  return {
    window,
    generatedAt: now.toISOString(),
    windowStart: windowStartFor(window, now).toISOString(),
    totals,
    byExitCause,
    signatures: buildSignatures(failures, maxSignatures),
    diedEarlySignatures: buildSignatures(diedEarlyRows, maxSignatures),
    byRole,
    byWorkspace,
    repeatFailureTasks,
  };
}

// ── Server-side data fetcher ──────────────────────────────────────────────────

interface FetchedFailureRows {
  workerRows: FailureWorkerRow[];
  workspaceNames: Record<string, string>;
  taskTitles: Record<string, string>;
}

/** Shared by `getFailureAnalytics` and `getFailureSignatureFamily` — one query shape, two aggregations. */
async function fetchFailureWorkerRows(
  scopedWsIds: string[],
  window: FailureWindow,
  now: Date,
): Promise<FetchedFailureRows> {
  const windowStart = windowStartFor(window, now);

  const rows = await db
    .select({
      id: workers.id,
      taskId: workers.taskId,
      workspaceId: workers.workspaceId,
      status: workers.status,
      error: workers.error,
      exitCause: workers.exitCause,
      turns: workers.turns,
      costUsd: workers.costUsd,
      createdAt: workers.createdAt,
      completedAt: workers.completedAt,
      roleSlug: tasks.roleSlug,
      taskTitle: tasks.title,
    })
    .from(workers)
    .leftJoin(tasks, eq(tasks.id, workers.taskId))
    .where(and(
      inArray(workers.workspaceId, scopedWsIds),
      gte(workers.createdAt, windowStart),
    ))
    // Newest first, so if the cap truncates a very busy 30d window we keep the
    // most recent slice rather than an arbitrary one.
    .orderBy(desc(workers.createdAt))
    .limit(MAX_WORKER_ROWS);

  const wsRows = await db
    .select({ id: workspaces.id, name: workspaces.name })
    .from(workspaces)
    .where(inArray(workspaces.id, scopedWsIds))
    .catch(() => [] as { id: string; name: string }[]);

  const workspaceNames: Record<string, string> = {};
  for (const w of wsRows as { id: string; name: string }[]) workspaceNames[w.id] = w.name;

  const taskTitles: Record<string, string> = {};
  const workerRows: FailureWorkerRow[] = (rows as any[]).map((r: any) => {
    if (r.taskId && r.taskTitle) taskTitles[r.taskId as string] = r.taskTitle as string;
    return {
      id: r.id as string,
      taskId: (r.taskId as string | null) ?? null,
      workspaceId: r.workspaceId as string,
      roleSlug: (r.roleSlug as string | null) ?? null,
      status: r.status as string,
      error: (r.error as string | null) ?? null,
      exitCause: (r.exitCause as WorkerExitCause | null) ?? null,
      turns: Number(r.turns ?? 0),
      costUsd: Number(r.costUsd ?? 0),
      createdAt: r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt),
      completedAt: r.completedAt ? (r.completedAt instanceof Date ? r.completedAt : new Date(r.completedAt)) : null,
    };
  });

  return { workerRows, workspaceNames, taskTitles };
}

/**
 * Load and aggregate worker failures for the given workspaces.
 * Read-only. Never throws — returns an empty report if the query fails.
 */
export async function getFailureAnalytics(
  scopedWsIds: string[],
  window: FailureWindow = '7d',
  now: Date = new Date(),
): Promise<FailureAnalytics> {
  const empty = () => computeFailureAnalytics({ window, now, workers: [] });
  if (scopedWsIds.length === 0) return empty();

  try {
    const { workerRows, workspaceNames, taskTitles } = await fetchFailureWorkerRows(scopedWsIds, window, now);
    return computeFailureAnalytics({ window, now, workers: workerRows, workspaceNames, taskTitles });
  } catch (err) {
    console.error('[failure-analytics] query failed:', err);
    return empty();
  }
}

/**
 * Same underlying data as `getFailureAnalytics`, aggregated by literal
 * signature prefix instead of ranked top-N. See `buildSignatureFamily`.
 * Read-only. Never throws — returns an unknown-family report if the query fails.
 */
export async function getFailureSignatureFamily(
  scopedWsIds: string[],
  window: FailureWindow,
  prefix: string,
  now: Date = new Date(),
): Promise<FailureSignatureFamily> {
  if (scopedWsIds.length === 0) return buildSignatureFamily([], prefix);

  try {
    const { workerRows } = await fetchFailureWorkerRows(scopedWsIds, window, now);
    return buildSignatureFamily(workerRows, prefix);
  } catch (err) {
    console.error('[failure-analytics] family query failed:', err);
    return buildSignatureFamily([], prefix);
  }
}
