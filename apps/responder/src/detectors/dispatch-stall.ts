/**
 * Detector A — dispatch stall.
 *
 * *Claims are being attempted, none are succeeding, and the queue is
 * non-empty, sustained over a window.* The condition that ran most of a night
 * with a correct detector watching it and no way to say so.
 *
 * ══ WHY cron_runs, AND NOT THE OTHER PERMITTED INPUTS ══════════════════════
 *
 * Four black-box inputs were available. Only one already carries all three
 * conjuncts of the condition:
 *
 *  - **The claim probe** cannot answer it. Establishing "claims are attempted
 *    and none succeed" by claiming is the one thing the probe must never do
 *    (see probes/claim-probe.ts), and a probe that is structurally unable to
 *    claim is structurally unable to observe a successful claim.
 *  - **The runner's local port** shows how many workers *that* runner holds.
 *    Zero active workers is the normal idle shape; it says nothing about
 *    whether work is queued, and nothing at all about any other runner.
 *  - **CI runs** are about the repository, not about dispatch.
 *  - **`cron_runs`** holds the output of `queue-stall?scope=fleet-idle`, whose
 *    alarm condition is *exactly* this one: a fresh heartbeat (so the runner is
 *    up and polling claims — claims ARE being attempted), with a free worker
 *    slot (so refusal is not the concurrency cap working correctly),
 *    claimable pending work past its own 45-minute threshold (the queue is
 *    non-empty), and no `workers.started_at` inside that window (nothing is
 *    succeeding). It was right on every one of the fourteen hourly runs of the
 *    incident. The defect was never the detection; it was that the branch
 *    reported its result and returned JSON with no notification path.
 *
 * So this detector's job is not to re-derive the condition from weaker
 * signals. It is to read a verdict the platform already computes correctly and
 * give it the notification path it never had — from a process that does not
 * share fate with the thing it watches.
 *
 * Re-deriving it from raw tables was the alternative and is worse: it would
 * mean a second copy of the claimability rules (deps gate, bypass flags,
 * access mode, spare capacity) drifting against the real ones, which is the
 * failure mode the fleet-idle module's own comments warn about twice.
 *
 * ── The counter's polarity ──────────────────────────────────────────────────
 * For this job `changed` is the number of alarms found, not the amount of work
 * done. That inversion is what made the incident invisible: the cron health
 * check judges a job partly on `changed`, so finding a problem every hour read
 * as maximally healthy. This detector reads the same counter with the correct
 * polarity — non-zero means *problem*.
 *
 * ── Thresholds, and where they come from ────────────────────────────────────
 * Both are read off observed cadence rather than chosen:
 *
 *  - `FEED_INTERVAL_MINUTES` = 60, because cron-manifest.json schedules
 *    `queue-stall?scope=fleet-idle` on `0 * * * *`. It is the sampling rate,
 *    so it is also the finest resolution any threshold here can honestly have
 *    — which is why the sustain threshold is counted in RUNS and not in
 *    minutes. A minutes-valued threshold invites a config finer than the data.
 *  - `SUSTAIN_RUNS` = 2. One alarming run means the condition held for at
 *    least the fleet-idle detector's own 45-minute window at the instant it
 *    ran. Two consecutive runs means it also survived a full cron interval, so
 *    it is at least ~1h45m of nothing dispatching and cannot be a single blip
 *    that happened to land under one tick. Two is the smallest sustain with
 *    that property, and against the incident — fourteen consecutive alarming
 *    runs — it fires at roughly hour two instead of hour fourteen.
 *  - `FEED_STALE_AFTER_INTERVALS` = 3. Three missed hourly ticks. Tolerates one
 *    skipped run (a deploy, a scheduler hiccup) without going blind, while
 *    still refusing to report health off an observation that is hours old.
 */

import type { CronRunRow, Detector, Snapshot, Verdict } from '../types';

export const FLEET_IDLE_JOB = 'queue-stall:fleet-idle';
export const FEED_INTERVAL_MINUTES = 60;
export const SUSTAIN_RUNS = 2;
export const FEED_STALE_AFTER_INTERVALS = 3;

const FEED_INTERVAL_MS = FEED_INTERVAL_MINUTES * 60_000;

/**
 * A run that carries a verdict at all.
 *
 * `ok: false` means the sweep threw and did not finish; `changed: null` means
 * it finished but reported nothing. Neither says anything about the fleet, so
 * neither may be read as a clear — that read is precisely the inversion this
 * app exists to undo.
 */
function evaluable(row: CronRunRow): boolean {
  return row.ok && row.changed !== null;
}

function verdict(over: Partial<Verdict> & { state: Verdict['state'] }): Verdict {
  return {
    detector: 'dispatch-stall',
    conditionKey: over.state === 'blind' ? 'dispatch-stall:blind' : 'dispatch-stall',
    summary: '',
    onsetAt: null,
    facts: {},
    ...over,
  };
}

function numberFrom(result: Record<string, unknown> | null, key: string): number | null {
  const raw = result?.[key];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

export const dispatchStall: Detector = {
  id: 'dispatch-stall',
  describes:
    'Claims are being attempted, none are succeeding, and the queue is non-empty — ' +
    `sustained across ${SUSTAIN_RUNS} consecutive hourly runs of ${FLEET_IDLE_JOB}.`,

  evaluate(snapshot: Snapshot, now: number): Verdict {
    if (snapshot.cronRuns === null) {
      return verdict({
        state: 'blind',
        summary:
          'Dispatch stall detector cannot see: the cron_runs feed is unreadable' +
          (snapshot.cronRunsError ? ` (${snapshot.cronRunsError})` : '') + '.',
        facts: { reason: 'feed_unreadable', error: snapshot.cronRunsError ?? null },
      });
    }

    // Newest first for streak walking; the feed hands rows over oldest-first.
    const rows = snapshot.cronRuns
      .filter(r => r.job === FLEET_IDLE_JOB)
      .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));

    if (rows.length === 0) {
      return verdict({
        state: 'blind',
        summary:
          `Dispatch stall detector cannot see: no runs of ${FLEET_IDLE_JOB} in the feed, ` +
          `for a job scheduled every ${FEED_INTERVAL_MINUTES} minutes.`,
        facts: { reason: 'no_runs_in_feed', job: FLEET_IDLE_JOB },
      });
    }

    const latest = rows[0]!;
    const latestAgeMs = now - Date.parse(latest.started_at);
    if (latestAgeMs > FEED_STALE_AFTER_INTERVALS * FEED_INTERVAL_MS) {
      return verdict({
        state: 'blind',
        onsetAt: latest.started_at,
        summary:
          `Dispatch stall detector cannot see: the newest ${FLEET_IDLE_JOB} run is ` +
          `${Math.round(latestAgeMs / 60_000)}m old, past ${FEED_STALE_AFTER_INTERVALS} missed ` +
          `${FEED_INTERVAL_MINUTES}-minute ticks. A stale observation is not an all-clear.`,
        facts: {
          reason: 'feed_stale',
          latestRunAt: latest.started_at,
          latestRunAgeMinutes: Math.round(latestAgeMs / 60_000),
          staleAfterIntervals: FEED_STALE_AFTER_INTERVALS,
        },
      });
    }

    // The job itself failing for as long as the staleness tolerance is the same
    // blindness as no runs at all: the platform is running the detector and the
    // detector is producing nothing.
    let leadingUnusable = 0;
    for (const row of rows) {
      if (evaluable(row)) break;
      leadingUnusable++;
    }
    if (leadingUnusable >= FEED_STALE_AFTER_INTERVALS) {
      return verdict({
        state: 'blind',
        onsetAt: rows[leadingUnusable - 1]!.started_at,
        summary:
          `Dispatch stall detector cannot see: the last ${leadingUnusable} runs of ` +
          `${FLEET_IDLE_JOB} produced no verdict (failed, or reported no counter).`,
        facts: { reason: 'detector_job_failing', unusableRuns: leadingUnusable },
      });
    }

    // Unusable rows are transparent: dropped from the sequence rather than
    // read as either state. An alarm, an unknown, then an alarm is still two
    // alarms and no clear.
    const usable = rows.filter(evaluable);

    let alarmStreak = 0;
    for (const row of usable) {
      if ((row.changed ?? 0) > 0) alarmStreak++;
      else break;
    }

    const streakRows = usable.slice(0, alarmStreak);
    const onset = streakRows.at(-1) ?? null;
    const newestAlarm = streakRows[0] ?? null;
    const claimablePending = newestAlarm ? numberFrom(newestAlarm.result, 'claimablePending') : null;

    const facts: Record<string, unknown> = {
      job: FLEET_IDLE_JOB,
      sustainRuns: SUSTAIN_RUNS,
      feedIntervalMinutes: FEED_INTERVAL_MINUTES,
      evaluatedRuns: usable.length,
      alarmStreak,
      latestRunAt: latest.started_at,
      latestAlarmCount: newestAlarm?.changed ?? 0,
      claimablePending,
      // Read for the record, not for the verdict: NULL on these rows is
      // correct and consistent — alerted_at records job-health paging, and
      // nothing on this branch could ever have paged for a finding.
      latestAlertedAt: latest.alerted_at,
    };

    if (alarmStreak < SUSTAIN_RUNS) {
      return verdict({
        state: 'clear',
        summary:
          `Dispatch is transacting: ${alarmStreak} consecutive alarming run(s) of ` +
          `${FLEET_IDLE_JOB}, under the ${SUSTAIN_RUNS}-run sustain threshold.`,
        facts,
      });
    }

    const onsetAt = onset!.started_at;
    const forMinutes = Math.round((now - Date.parse(onsetAt)) / 60_000);
    return verdict({
      state: 'firing',
      onsetAt,
      summary:
        `Dispatch stall: ${FLEET_IDLE_JOB} has found a live-but-not-claiming fleet on ` +
        `${alarmStreak} consecutive hourly runs since ${onsetAt} (${forMinutes}m)` +
        (claimablePending === null ? '' : `, with ${claimablePending} claimable task(s) queued`) +
        '. Runners are heartbeating with spare capacity and nothing is starting.',
      facts,
    });
  },
};
