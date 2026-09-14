/**
 * Fleet-wide rollup of `worker_error_traces`, grouped by the scanner's pattern
 * slug: which scanned error pattern is costing us the most.
 *
 * Ranking key: `get_error_traces` returns rows per worker, and the naive
 * "which pattern has the most rows" answer is the weakest possible ordering —
 * a chatty-but-harmless pattern that fires repeatedly on output that never
 * hurt anything outranks a rare pattern that always coincides with a dead
 * worker. Instead this ranks by DISTINCT WORKERS whose session ended in a
 * failed/error status while the pattern fired at least once, falling back to
 * total distinct workers and then raw occurrences only to break ties. See
 * `FAILED_WORKER_STATUSES` in `./failure-analytics`, reused here rather than
 * redefined, for what counts as a terminal failure.
 *
 * Grouping key: the scanner's own `pattern` slug (`cd_no_such_file`,
 * `git_fatal`, …), not `normalizeErrorSignature`. The two group different
 * data — normalizeErrorSignature clusters the free-text `workers.error`
 * field, while a trace row's `excerpt` is a truncated raw output line keyed
 * to a pattern the scanner already identified. Reusing the signature grouper
 * here would silently re-derive a second, looser signature over text a
 * precise slug already exists for.
 *
 * The gating discontinuity: PRs #2152 and #2171 changed which patterns
 * require the SDK to have marked the tool result an error
 * (`apps/runner/src/error-trace-scanner.ts`). Traces captured before that
 * gating landed include the ungated false positives; traces after do not. A
 * window spanning both regimes would measure the gate change, not fleet
 * behaviour, so the caller scopes the underlying query to traces on/after the
 * gate date (see `error-pattern-cost-query.ts`) and this module surfaces
 * `windowPredatesCapture` the same way `subagent-time.ts` does, so the UI can
 * say so rather than silently narrowing the window.
 */

import type { DerivedMetric } from '@buildd/core/derived-metric';
import { derivedValue, derivedUnavailable } from '@buildd/core/derived-metric';

/** Fallback only — the real value lives in `error-pattern-cost-query.ts`, which
 *  this module cannot import (it reaches `@buildd/core/db`, and this module is
 *  read by a client component). Mirrors `ACTION_EVENTS_CAPTURED_SINCE_DEFAULT`
 *  in `usage-drilldown.ts`. */
const ERROR_TRACE_GATED_SINCE_DEFAULT = '2026-09-07';

export interface ErrorPatternTraceRow {
  pattern: string;
  workerId: string;
  /** True when the owning worker's terminal status is a failure (see FAILED_WORKER_STATUSES). */
  workerFailed: boolean;
}

export interface ErrorPatternRow {
  pattern: string;
  /** Raw trace-row count. Never the sort key — see module header. */
  occurrences: number;
  /** Distinct workers whose output matched this pattern at least once. */
  workers: number;
  /** Of those, workers whose session terminally failed. THE ranking key. */
  failedWorkers: number;
}

export interface ErrorPatternMetrics {
  patterns: ErrorPatternRow[];
  /** Workers scanned over the (possibly gate-clamped) window — the denominator. */
  scannedWorkers: number;
  /** ISO date the scanner's false-positive gating was completed (PR #2171). */
  gatedSince: string;
  /**
   * True when the requested window opens before `gatedSince`, so traces from
   * the early part of the window were excluded rather than counted as zero.
   * Set independently of whether any traces were found — the caveat is a
   * property of the window, not of the result set.
   */
  windowPredatesCapture: boolean;
  /** Row-cap hit — occurrence/worker counts above are a floor. */
  truncated: boolean;
}

export function buildErrorPatternPanel(input: {
  rows: readonly ErrorPatternTraceRow[];
  /** Workers scanned in the (gate-clamped) window — from a population query, not derived from `rows`. */
  scannedWorkers: number;
  windowStart: Date;
  rowLimit: number;
  gatedSince?: string;
}): DerivedMetric<ErrorPatternMetrics> {
  const gatedSince = input.gatedSince ?? ERROR_TRACE_GATED_SINCE_DEFAULT;
  const windowPredatesCapture = input.windowStart < new Date(`${gatedSince}T00:00:00Z`);
  const truncated = input.rows.length >= input.rowLimit;

  if (input.scannedWorkers === 0) {
    const reason = windowPredatesCapture ? 'no_baseline' : 'no_scope';
    const detail = windowPredatesCapture
      ? `No worker completed in this window on or after ${gatedSince}, when the scanner's false-positive gating (PR #2171) was completed — traces before that date mix in patterns later found to fire on successful output.`
      : 'No worker completed in this window to scan for error-trace patterns.';
    return derivedUnavailable<ErrorPatternMetrics>(reason, detail);
  }

  const byPattern = new Map<string, { occurrences: number; workers: Set<string>; failedWorkers: Set<string> }>();
  for (const r of input.rows) {
    let acc = byPattern.get(r.pattern);
    if (!acc) {
      acc = { occurrences: 0, workers: new Set(), failedWorkers: new Set() };
      byPattern.set(r.pattern, acc);
    }
    acc.occurrences += 1;
    acc.workers.add(r.workerId);
    if (r.workerFailed) acc.failedWorkers.add(r.workerId);
  }

  const patterns: ErrorPatternRow[] = [...byPattern.entries()]
    .map(([pattern, acc]) => ({
      pattern,
      occurrences: acc.occurrences,
      workers: acc.workers.size,
      failedWorkers: acc.failedWorkers.size,
    }))
    .sort((a, b) =>
      b.failedWorkers - a.failedWorkers
      || b.workers - a.workers
      || b.occurrences - a.occurrences
      || a.pattern.localeCompare(b.pattern));

  // A real zero here (no pattern fired) is a measured fact about a scanned
  // population, not a missing one — unlike the scannedWorkers===0 case above,
  // there is nothing to exclude-rather-than-zero about an empty pattern list.
  return derivedValue<ErrorPatternMetrics>({
    patterns,
    scannedWorkers: input.scannedWorkers,
    gatedSince,
    windowPredatesCapture,
    truncated,
  });
}
