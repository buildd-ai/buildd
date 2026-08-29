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
import type {
  FailureAnalytics,
  FailureExitCauseBucket,
  FailureExitCauseRow,
  FailureRepeatTaskRow,
  FailureRoleRow,
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
  FailureSignatureRow,
  FailureTotals,
  FailureWindow,
  FailureWorkspaceRow,
};

// ── Constants ─────────────────────────────────────────────────────────────────

export const FAILURE_WINDOWS = ['24h', '7d', '30d'] as const;

const WINDOW_MS: Record<FailureWindow, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

/** Worker statuses that count as a failure. `error` is the legacy spelling. */
export const FAILED_WORKER_STATUSES = ['failed', 'error'] as const;

/** A failure at or under this many turns, at zero cost, never did any work. */
export const DIED_EARLY_MAX_TURNS = 2;

/** Placeholder signature for failures that carry no error text at all. */
export const EMPTY_SIGNATURE = '(no error message)';

const UNCLASSIFIED: FailureExitCauseBucket = 'unclassified';
const NO_ROLE = '(no role)';
const UNKNOWN_WORKSPACE = '(unknown)';

/** Signatures are bounded so a runaway stack trace can't become a table row. */
const MAX_SIGNATURE_LENGTH = 200;
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

// ── Signature normalization ───────────────────────────────────────────────────

const RE_UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const RE_URL = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;
const RE_ISO_TS = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g;
const RE_DATE = /\b\d{4}-\d{2}-\d{2}\b/g;
const RE_CLOCK = /\b\d{1,2}:\d{2}(?::\d{2})?\s?(?:am|pm)?/gi;
const RE_PATH = /(?:\/[\w.@+-]+){2,}\/?/g;
const RE_HEX = /\b[0-9a-f]{7,}\b/gi;
const RE_NUMBER = /\d+(?:\.\d+)?/g;

/**
 * Collapse a raw worker error into a stable cluster key.
 *
 * Volatile detail (ids, hosts, paths, timestamps, counts) is replaced by
 * placeholders so recurring platform failures collapse into one row:
 *
 *   "Deferred: another Codex worker (d7e6…) is already active in this workspace"
 *     → "Deferred: another Codex worker (<id>) is already active in this workspace"
 *   "Stale worker expired (no update for 15+ minutes)"
 *     → "Stale worker expired (no update for <n>+ minutes)"
 *
 * Replacement order matters: URLs before paths (URLs contain slashes), and
 * timestamps/clock times before the generic number pass.
 */
export function normalizeErrorSignature(error: string | null | undefined): string {
  if (!error) return EMPTY_SIGNATURE;

  // Multi-line errors: the first non-empty line is the failure; the rest is trace.
  const firstLine = error.split('\n').map(l => l.trim()).find(l => l.length > 0);
  if (!firstLine) return EMPTY_SIGNATURE;

  let s = firstLine.replace(/\s+/g, ' ').trim();

  s = s.replace(RE_URL, '<url>');
  s = s.replace(RE_UUID, '<id>');
  s = s.replace(RE_ISO_TS, '<ts>');
  s = s.replace(RE_DATE, '<ts>');
  s = s.replace(RE_CLOCK, '<time>');
  s = s.replace(RE_PATH, '<path>');
  s = s.replace(RE_HEX, '<hash>');
  s = s.replace(RE_NUMBER, '<n>');
  // Runs of placeholders (e.g. "<n> <n> <n>") add no signal.
  s = s.replace(/(?:<n> ){2,}<n>/g, '<n>').replace(/\s+/g, ' ').trim();

  if (s.length > MAX_SIGNATURE_LENGTH) {
    s = `${s.slice(0, MAX_SIGNATURE_LENGTH - 1)}…`;
  }
  return s.length > 0 ? s : EMPTY_SIGNATURE;
}

// ── Pure aggregation ──────────────────────────────────────────────────────────

function isFailure(status: string): boolean {
  return (FAILED_WORKER_STATUSES as readonly string[]).includes(status);
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

  const totals: FailureTotals = {
    started: rows.length,
    completed: rows.filter(r => r.status === 'completed').length,
    failed: failures.length,
    failureRatePct: pct(failures.length, rows.length),
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
  const roleTallies = new Map<string, { started: number; failed: number }>();
  const wsTallies = new Map<string, { started: number; failed: number }>();
  for (const r of rows) {
    const roleKey = r.roleSlug ?? NO_ROLE;
    const role = roleTallies.get(roleKey) ?? { started: 0, failed: 0 };
    role.started += 1;
    if (isFailure(r.status)) role.failed += 1;
    roleTallies.set(roleKey, role);

    const ws = wsTallies.get(r.workspaceId) ?? { started: 0, failed: 0 };
    ws.started += 1;
    if (isFailure(r.status)) ws.failed += 1;
    wsTallies.set(r.workspaceId, ws);
  }

  const byRole: FailureRoleRow[] = [...roleTallies.entries()]
    .map(([roleSlug, t]) => ({
      roleSlug,
      started: t.started,
      failed: t.failed,
      failureRatePct: pct(t.failed, t.started),
    }))
    .sort((a, b) => b.failed - a.failed || b.failureRatePct - a.failureRatePct || a.roleSlug.localeCompare(b.roleSlug));

  const byWorkspace: FailureWorkspaceRow[] = [...wsTallies.entries()]
    .map(([workspaceId, t]) => ({
      workspaceId,
      workspaceName: workspaceNames[workspaceId] ?? UNKNOWN_WORKSPACE,
      started: t.started,
      failed: t.failed,
      failureRatePct: pct(t.failed, t.started),
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

  const windowStart = windowStartFor(window, now);

  try {
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

    return computeFailureAnalytics({ window, now, workers: workerRows, workspaceNames, taskTitles });
  } catch (err) {
    console.error('[failure-analytics] query failed:', err);
    return empty();
  }
}
