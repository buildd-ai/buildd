/**
 * The `role-outcomes` cron feed contract — shared by the producer
 * (`apps/web/src/app/api/cron/role-outcomes/route.ts`) and its only consumer
 * (`apps/responder/src/detectors/role-regression.ts`).
 *
 * Pure types and constants, no imports: the responder must not share a module
 * graph with the web app (it cannot load `@buildd/core/db`, which is
 * `server-only`), so this file is the whole of what the two sides share.
 *
 * ── Why a cron-recorded feed, not a query from the responder ────────────────
 * The responder's production access is one read-only role with `SELECT` on
 * `cron_runs` and nothing else. Answering "is one role suddenly failing" needs
 * `workers` joined to `tasks`, plus the exit-cause taxonomy and the error
 * normalizer that live in this repo. Granting the responder those tables would
 * widen its credential and duplicate the taxonomy on the far side of a process
 * boundary, where it would drift. So the platform aggregates, records the
 * aggregate through `withCronRun`, and the responder applies thresholds to it.
 *
 * The aggregate is COUNTS, not a verdict. Thresholds live with the detector,
 * which has to be able to page when the platform's own judgement is the thing
 * that is wrong.
 */

/** `cron_runs.job` for the feed. */
export const ROLE_OUTCOMES_JOB = 'role-outcomes';

/** Bumped on any breaking change to `RoleOutcomesResult`; the consumer goes blind on a mismatch. */
export const ROLE_OUTCOMES_SCHEMA_VERSION = 1;

/** Display/bucket key for tasks with no `role_slug`. NULL is its own bucket, not "all roles". */
export const NO_ROLE_BUCKET = '(no role)';

/**
 * Why a failure was left out of both numerator and denominator. These are
 * failures that say nothing about whether the role's work is healthy:
 * a spent budget, a refused credential, a row no runner ever started, a
 * mutation the platform itself refused, a question nobody answered, a
 * deliberate deferral.
 */
export type RoleOutcomeExclusion =
  | 'budget_or_usage'
  | 'auth'
  | 'never_started'
  | 'server_refused'
  | 'bookkeeping';

export interface RoleOutcomeSignature {
  /** `normalizeErrorSignature` output — the same key `get_failure_analytics` clusters on. */
  signature: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
}

export interface RoleOutcomeWindow {
  succeeded: number;
  failed: number;
  excluded: number;
}

export interface RoleOutcomeBucket {
  /** `tasks.role_slug`, or NO_ROLE_BUCKET. */
  role: string;
  recent: RoleOutcomeWindow & {
    excludedBy: Partial<Record<RoleOutcomeExclusion, number>>;
    /** Top signatures among the recent chargeable failures, most frequent first. */
    signatures: RoleOutcomeSignature[];
  };
  baseline: RoleOutcomeWindow;
}

/** One distinct runner build among fresh heartbeats. No account or host identity. */
export interface RunnerVersionCount {
  version: string | null;
  commit: string | null;
  runners: number;
}

export interface RoleOutcomesResult {
  scope: 'role-outcomes';
  schemaVersion: number;
  /** ISO. Recent window is [windowEnd - recentMinutes, windowEnd). */
  windowEnd: string;
  recentMinutes: number;
  /** Baseline is the `baselineHours` immediately before the recent window. */
  baselineHours: number;
  /** Worker rows read. */
  rowsScanned: number;
  /** True when the row cap was hit; counts are then a floor. */
  truncated: boolean;
  /** Roles with at least one recent terminal outcome, busiest first, capped. */
  roles: RoleOutcomeBucket[];
  /** Runner builds seen on heartbeats fresh at `windowEnd`. */
  runnerVersions: RunnerVersionCount[];
  /** The web deploy that produced this row (build-time env), or null outside Vercel. */
  appCommit: string | null;
}
