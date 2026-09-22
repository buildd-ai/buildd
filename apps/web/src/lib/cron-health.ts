/**
 * Reads a scheduled sweep's own verdict on its own work.
 *
 * Every cron in this codebase already computes exactly what is needed to know
 * whether it is working — rows looked at, rows changed, calls failed — and
 * every one of them discarded it at the route boundary. Three PR sweeps ran
 * hourly for months returning "every row errored, nothing changed" (PR #2125).
 * That is a complete description of an outage, emitted on schedule, that
 * nothing was in a position to read.
 *
 * Unit tests could not have caught it: the failure was environmental, a data
 * shape that exists only in production. A trend over a sweep's own results can.
 *
 * Deliberately pure — takes rows, returns a verdict. The database access lives
 * in cron-run.ts, so the rules that decide whether to wake someone up are
 * testable without mocking a query builder.
 */

import type { CronChangedPolarity } from '@buildd/core/signal-registry';

/**
 * Runs needed before a trend is a trend. One bad run is a blip.
 *
 * Also reused, unchanged, as the sustain length for the `findings`-polarity
 * alarm below: one shared definition of "how many runs make a trend" rather
 * than a second magic number to independently justify. Both queue-stall
 * scopes — the only `findings` jobs registered today — run hourly, so this is
 * ~3 hours of continuous findings before paging: well inside "most of a
 * night" and short enough to page the same working day it starts.
 */
export const MIN_RUNS_FOR_ALARM = 3;

/** How long one alert buys silence, so a dead sweep does not page hourly. */
export const ALERT_SUPPRESS_MS = 6 * 60 * 60 * 1000;

/** How far back to look when judging a job. */
export const HEALTH_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface CronRunSummary {
  /** Did the handler return without throwing. */
  ok: boolean;
  /** Failures inside the sweep. Null when the route reported no verdict. */
  errors: number | null;
  /** Items the sweep actually changed. Null when the route reported nothing. */
  changed: number | null;
  alertedAt: Date | null;
  startedAt: Date;
}

export interface CronHealthVerdict {
  alarm: boolean;
  /** Human-readable trend, used verbatim as the alert body. Null when healthy. */
  reason: string | null;
}

/** A run that reported nothing proves nothing — it can only be a heartbeat. */
function reportedAVerdict(r: CronRunSummary): boolean {
  return r.errors !== null || r.changed !== null;
}

/** Did this run fail: it threw, or it reported failures of its own. */
function failed(r: CronRunSummary): boolean {
  return !r.ok || (r.errors ?? 0) > 0;
}

/**
 * Judge a job from its recent runs (any order).
 *
 * `polarity` names what this job's `changed` count means (see
 * `packages/core/signal-registry.ts#CronChangedPolarity`) and defaults to
 * `'work'` — the meaning every job had before this parameter existed, so an
 * unlabelled job's behaviour is unchanged.
 *
 * `'work'` (unchanged): alarms only on "consistently failing AND
 * accomplishing nothing". Both halves matter. A sweep with nothing to do
 * reports the same processed=0/changed=0 as a sweep that cannot do anything,
 * so `errors` is what separates healthy idle from total failure — and a
 * sweep still landing real changes is degraded, not dead, which is not worth
 * waking someone for.
 *
 * `'findings'`: `changed` counts problems FOUND, not work performed, so
 * nonzero `changed` can no longer read as the all-clear — a detector finding
 * a real, ongoing outage every run would otherwise report the same "healthy"
 * verdict a maximally productive worker sweep does, and read healthier the
 * worse the outage gets. The alarm inverts: the job's most recent
 * `MIN_RUNS_FOR_ALARM` judged runs all completing successfully AND all
 * finding something IS the alarm — a condition this detector keeps tripping
 * on and nothing has cleared. This runs alongside, not instead of, the
 * `'work'` crash/no-op check above: a `findings` job that is actually
 * throwing on every run is still broken and still pages for that.
 */
export function evaluateCronHealth(
  runs: CronRunSummary[],
  now: Date,
  polarity: CronChangedPolarity = 'work',
): CronHealthVerdict {
  const quiet: CronHealthVerdict = { alarm: false, reason: null };

  // A route that reports nothing gets a heartbeat row and no opinion. Judging
  // on those would either invent failures or mask them.
  const judged = runs.filter(r => reportedAVerdict(r) || !r.ok);
  if (judged.length < MIN_RUNS_FOR_ALARM) return quiet;

  // Any recent alert buys silence for the whole window.
  const suppressed = runs.some(
    r => r.alertedAt && now.getTime() - r.alertedAt.getTime() < ALERT_SUPPRESS_MS,
  );
  if (suppressed) return quiet;

  // ── Crash / total-no-op alarm — applies regardless of polarity ────────────
  if (judged.every(failed)) {
    const totalChanged = judged.reduce((sum, r) => sum + (r.changed ?? 0), 0);
    if (totalChanged === 0) {
      const totalErrors = judged.reduce((sum, r) => sum + (r.errors ?? 0), 0);
      const allThrew = judged.every(r => !r.ok);
      const reason = allThrew
        ? `${judged.length} runs did not finish (handler threw every time), 0 changed`
        : `${judged.length} runs, ${totalErrors} errors, 0 changed`;
      return { alarm: true, reason };
    }
  }

  // ── Sustained-findings alarm — only for polarity: 'findings' ──────────────
  if (polarity === 'findings') {
    const recent = [...judged]
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
      .slice(0, MIN_RUNS_FOR_ALARM);
    const sustained =
      recent.length >= MIN_RUNS_FOR_ALARM && recent.every(r => r.ok && (r.changed ?? 0) > 0);
    if (sustained) {
      const totalChanged = recent.reduce((sum, r) => sum + (r.changed ?? 0), 0);
      return {
        alarm: true,
        reason:
          `${recent.length} consecutive runs all reported findings (total ${totalChanged}) — ` +
          `this condition is not clearing on its own`,
      };
    }
  }

  return quiet;
}
