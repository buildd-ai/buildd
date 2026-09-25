/**
 * Per-role terminal outcomes, recent window vs baseline — the aggregate behind
 * the `role-outcomes` cron feed (contract: `packages/core/role-outcomes-feed.ts`).
 *
 * ── The incident ────────────────────────────────────────────────────────────
 * After a runner release, one role's tasks went from all-succeeding to
 * all-failing with one identical error signature. Nobody was paged for most of
 * a working day, because each failure landed under the generic exit cause and
 * a trickle of failures from one role looks like background noise in every
 * fleet-wide view. The shape that WAS visible — this role, this hour, this
 * signature, against this role's own yesterday — was never computed anywhere.
 *
 * This module computes it. It judges nothing: the thresholds belong to the
 * responder's `role-regression` detector, which reads this aggregate from
 * `cron_runs`.
 *
 * Pure. The DB reads live in `role-outcomes-scan.ts`.
 *
 * ── What counts ─────────────────────────────────────────────────────────────
 * `completed` and failed workers only, with the failed-status definition taken
 * from `failure-analytics.ts` so this and `get_failure_analytics` cannot
 * disagree about what a failure is. Signatures go through the same
 * `normalizeErrorSignature`, so the signature on a page is the one an
 * operator can paste into `get_failure_analytics error=…`.
 *
 * Failures that say nothing about the role's work are EXCLUDED from both
 * numerator and denominator (and counted, so the exclusion is visible):
 * budget/usage exhaustion, auth failures, never-started rows, server refusals
 * and bookkeeping exits. Those have their own detectors and their own pages;
 * a credential expiring overnight must not read as "every role regressed".
 */

import { normalizeErrorSignature } from '@buildd/core/error-signature';
import { classifyAuthErrorSeverity } from '@buildd/core/auth-error-classifier';
import {
  NO_ROLE_BUCKET,
  ROLE_OUTCOMES_SCHEMA_VERSION,
  type RoleOutcomeBucket,
  type RoleOutcomeExclusion,
  type RoleOutcomesResult,
  type RoleOutcomeSignature,
  type RunnerVersionCount,
} from '@buildd/core/role-outcomes-feed';
import { classifyFailure } from './failure-classifier';
import { FAILED_WORKER_STATUSES } from './failure-analytics';

/** Recent window. Matches the hourly cadence of the feed, so windows tile with no gap. */
export const RECENT_MINUTES = 60;
/** Baseline: the day before the recent window — long enough to span a daily rhythm. */
export const BASELINE_HOURS = 24;
/** Roles recorded per run. A bound on the row size, far above any real fleet. */
export const MAX_ROLES = 50;
/** Signatures kept per role. Only the dominant one decides anything. */
export const MAX_SIGNATURES_PER_ROLE = 3;
/** Heartbeats fresher than this count as a live runner (same bound as fleet-idle). */
export const HEARTBEAT_FRESH_MINUTES = 10;

export interface RoleOutcomeRow {
  status: string;
  exitCause: string | null;
  error: string | null;
  roleSlug: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

export interface HeartbeatVersionRow {
  runnerVersion: string | null;
  runnerCommit: string | null;
  lastHeartbeatAt: Date;
}

const BOOKKEEPING_EXITS = new Set(['needs_input', 'condition_unmet', 'reassigned', 'task_cancelled']);

function isFailed(status: string): boolean {
  return (FAILED_WORKER_STATUSES as readonly string[]).includes(status);
}

/**
 * A success is `completed` and nothing else. `failure-analytics` counts every
 * non-failed terminal status as a success because it only needs a failure
 * rate; a SUCCESS rate that counted cancellations would let a role whose every
 * task is being cancelled read as healthy.
 */
function isSucceeded(status: string): boolean {
  return status === 'completed';
}

/**
 * Why a failure should not count against its role, or null when it should.
 * Exit cause first (the classified truth), error text second (for the
 * families that still land under the generic cause).
 */
export function exclusionFor(row: Pick<RoleOutcomeRow, 'exitCause' | 'error'>): RoleOutcomeExclusion | null {
  switch (row.exitCause) {
    case 'budget_limited':
      return 'budget_or_usage';
    case 'never_started':
      return 'never_started';
    case 'server_refused':
      return 'server_refused';
  }
  if (row.exitCause && BOOKKEEPING_EXITS.has(row.exitCause)) return 'bookkeeping';
  const text = row.error ?? '';
  if (text && classifyFailure(text) === 'budget_limited') return 'budget_or_usage';
  if (text && classifyAuthErrorSeverity(text) !== 'none') return 'auth';
  return null;
}

function outcomeAt(row: RoleOutcomeRow): number {
  return (row.completedAt ?? row.createdAt).getTime();
}

interface Acc {
  role: string;
  recent: { succeeded: number; failed: number; excluded: number; excludedBy: Partial<Record<RoleOutcomeExclusion, number>> };
  baseline: { succeeded: number; failed: number; excluded: number };
  sigs: Map<string, { count: number; first: number; last: number }>;
}

function blank(role: string): Acc {
  return {
    role,
    recent: { succeeded: 0, failed: 0, excluded: 0, excludedBy: {} },
    baseline: { succeeded: 0, failed: 0, excluded: 0 },
    sigs: new Map(),
  };
}

export function summarizeRunnerVersions(rows: HeartbeatVersionRow[], now: Date): RunnerVersionCount[] {
  const cutoff = now.getTime() - HEARTBEAT_FRESH_MINUTES * 60_000;
  const byKey = new Map<string, RunnerVersionCount>();
  for (const r of rows) {
    if (r.lastHeartbeatAt.getTime() < cutoff) continue;
    const key = `${r.runnerVersion ?? ''}\u0000${r.runnerCommit ?? ''}`;
    const hit = byKey.get(key);
    if (hit) hit.runners++;
    else byKey.set(key, { version: r.runnerVersion, commit: r.runnerCommit, runners: 1 });
  }
  return [...byKey.values()].sort(
    (a, b) => b.runners - a.runners || `${a.version}${a.commit}`.localeCompare(`${b.version}${b.commit}`),
  );
}

export function computeRoleOutcomes(input: {
  now: Date;
  workers: RoleOutcomeRow[];
  heartbeats: HeartbeatVersionRow[];
  truncated: boolean;
  appCommit: string | null;
}): RoleOutcomesResult {
  const end = input.now.getTime();
  const recentStart = end - RECENT_MINUTES * 60_000;
  const baselineStart = recentStart - BASELINE_HOURS * 3_600_000;

  const byRole = new Map<string, Acc>();
  for (const row of input.workers) {
    if (!isSucceeded(row.status) && !isFailed(row.status)) continue;
    const at = outcomeAt(row);
    if (at < baselineStart || at >= end) continue;
    const inRecent = at >= recentStart;

    const role = row.roleSlug ?? NO_ROLE_BUCKET;
    let acc = byRole.get(role);
    if (!acc) byRole.set(role, (acc = blank(role)));
    const win = inRecent ? acc.recent : acc.baseline;

    if (isSucceeded(row.status)) {
      win.succeeded++;
      continue;
    }
    const exclusion = exclusionFor(row);
    if (exclusion) {
      win.excluded++;
      if (inRecent) acc.recent.excludedBy[exclusion] = (acc.recent.excludedBy[exclusion] ?? 0) + 1;
      continue;
    }
    win.failed++;
    if (inRecent) {
      const sig = normalizeErrorSignature(row.error);
      const s = acc.sigs.get(sig);
      if (s) {
        s.count++;
        s.first = Math.min(s.first, at);
        s.last = Math.max(s.last, at);
      } else {
        acc.sigs.set(sig, { count: 1, first: at, last: at });
      }
    }
  }

  const roles: RoleOutcomeBucket[] = [...byRole.values()]
    .filter(a => a.recent.succeeded + a.recent.failed + a.recent.excluded > 0)
    .sort((a, b) => {
      const n = (x: Acc) => x.recent.succeeded + x.recent.failed;
      return n(b) - n(a) || a.role.localeCompare(b.role);
    })
    .slice(0, MAX_ROLES)
    .map(a => {
      const signatures: RoleOutcomeSignature[] = [...a.sigs.entries()]
        .sort(([sa, x], [sb, y]) => y.count - x.count || y.last - x.last || sa.localeCompare(sb))
        .slice(0, MAX_SIGNATURES_PER_ROLE)
        .map(([signature, s]) => ({
          signature,
          count: s.count,
          firstSeen: new Date(s.first).toISOString(),
          lastSeen: new Date(s.last).toISOString(),
        }));
      return { role: a.role, recent: { ...a.recent, signatures }, baseline: a.baseline };
    });

  return {
    scope: 'role-outcomes',
    schemaVersion: ROLE_OUTCOMES_SCHEMA_VERSION,
    windowEnd: input.now.toISOString(),
    recentMinutes: RECENT_MINUTES,
    baselineHours: BASELINE_HOURS,
    rowsScanned: input.workers.length,
    truncated: input.truncated,
    roles,
    runnerVersions: summarizeRunnerVersions(input.heartbeats, input.now),
    appCommit: input.appCommit,
  };
}

/** Earliest worker `createdAt` the scan must read to cover both windows (plus run-time slack). */
export function scanStart(now: Date): Date {
  const SLACK_HOURS = 2; // a worker created before the window can finish inside it
  return new Date(now.getTime() - (RECENT_MINUTES * 60_000 + (BASELINE_HOURS + SLACK_HOURS) * 3_600_000));
}
