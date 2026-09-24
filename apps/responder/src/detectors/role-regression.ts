/**
 * Detector C — role regression after a change.
 *
 * *One role's tasks go from succeeding to failing, on one error, right after
 * something was deployed.* After a runner release, one role went from
 * all-succeeding to all-failing with a single identical error signature, and
 * nobody was paged for most of a working day. Each failure landed under the
 * generic exit cause, and a steady trickle of one role's failures is
 * indistinguishable from background noise in any fleet-wide failure view —
 * which is the only kind of view that existed.
 *
 * ══ WHERE THE DATA COMES FROM ══════════════════════════════════════════════
 *
 * `cron_runs`, like dispatch-stall, and for the same reason: it is the only
 * production table this process may read. The `role-outcomes` cron
 * (`apps/web/src/app/api/cron/role-outcomes/route.ts`) aggregates terminal
 * worker outcomes per role, excluding the failure classes that say nothing
 * about the role's work (budget/usage, auth, never-started, server refusals,
 * bookkeeping), and records the counts hourly. Contract:
 * `packages/core/role-outcomes-feed.ts`.
 *
 * The platform supplies counts; this detector supplies every threshold. The
 * split is deliberate: when the platform's own judgement is what regressed,
 * the watcher's judgement must not have regressed with it.
 *
 * ══ THE CONDITION, AND WHAT EACH CONJUNCT RULES OUT ═════════════════════════
 *
 * For one role, in the newest feed row, all of:
 *
 *  - recent chargeable outcomes  >= `minRecent`         — small n is not a rate.
 *  - recent success rate         <= `recentFloorPct`    — it is actually failing.
 *  - one signature's share of
 *    recent failures             >= `dominantSharePct`  — one cause, not a bad
 *                                                          batch of unrelated tasks.
 *  - baseline success rate       >= `baselineBarPct`    — it USED to work. This is
 *                                                          what keeps a role that is
 *                                                          always noisy silent.
 *  - baseline outcomes           >= `baselineMin`       — otherwise `warming`: the
 *                                                          shape is suspicious but
 *                                                          there is no "before" to
 *                                                          regress from.
 *
 * ── Defaults, and where they come from ──────────────────────────────────────
 *  - `minRecent` = 4. The feed's recent window is one hour. Four failures of
 *    one role in one hour, on one signature, is not a coincidence for any role
 *    that normally succeeds; three is still within reach of one flaky retry
 *    chain (a task and its retries share a signature by construction).
 *  - `recentFloorPct` = 20. At n=4 that is "at most none succeeded"; at n=10,
 *    "at most two". A regression that still lets most work through is a
 *    different, slower problem for a different detector.
 *  - `baselineBarPct` = 70 over `baselineMin` = 10. A healthy role's day sits
 *    well above 70%; a role that lives below it is noisy by nature, and paging
 *    on it would be paging on its normal state. Ten outcomes over 24h is the
 *    least that makes a rate out of a day.
 *  - `dominantSharePct` = 60. "Most" failures, with room for one or two
 *    unrelated failures landing in the same hour.
 * All five are overridable (`BUILDD_RESPONDER_ROLE_*`, see config.ts).
 *
 * ── "Started N min after deploy X" ──────────────────────────────────────────
 * The line an operator needs is when it began relative to the last change.
 * Each feed row records the runner builds on live heartbeats and the web
 * deploy sha that ran it, so walking the feed's own history shows the most
 * recent change and brackets it between two hourly rows. That bracket is the
 * honest resolution: the page says "between T0 and T1", not a false minute.
 * If the failures began BEFORE the change appeared, the page says so — a
 * deploy that postdates the onset is not the cause.
 */

import {
  NO_ROLE_BUCKET,
  ROLE_OUTCOMES_JOB,
  ROLE_OUTCOMES_SCHEMA_VERSION,
  type RoleOutcomeBucket,
  type RoleOutcomesResult,
} from '../../../../packages/core/role-outcomes-feed';
import type { CronRunRow, Detector, Snapshot, Verdict } from '../types';

export interface RoleRegressionThresholds {
  minRecent: number;
  recentFloorPct: number;
  baselineBarPct: number;
  baselineMin: number;
  dominantSharePct: number;
}

export const DEFAULT_ROLE_REGRESSION: Readonly<RoleRegressionThresholds> = Object.freeze({
  minRecent: 4,
  recentFloorPct: 20,
  baselineBarPct: 70,
  baselineMin: 10,
  dominantSharePct: 60,
});

/** cron-manifest.json schedules the feed on `0 * * * *`. */
export const FEED_INTERVAL_MINUTES = 60;
/** Same tolerance as dispatch-stall: one skipped tick is not blindness, three is. */
export const FEED_STALE_AFTER_INTERVALS = 3;

const FEED_INTERVAL_MS = FEED_INTERVAL_MINUTES * 60_000;
const ID = 'role-regression';
const MAX_SIGNATURE_IN_SUMMARY = 160;

type Parsed =
  | { kind: 'ok'; row: CronRunRow; result: RoleOutcomesResult }
  | { kind: 'mismatch'; row: CronRunRow; schemaVersion: unknown }
  | { kind: 'unusable'; row: CronRunRow };

function parse(row: CronRunRow): Parsed {
  const r = row.result;
  if (!row.ok || !r || r.scope !== 'role-outcomes') return { kind: 'unusable', row };
  if (r.schemaVersion !== ROLE_OUTCOMES_SCHEMA_VERSION) {
    return { kind: 'mismatch', row, schemaVersion: r.schemaVersion };
  }
  if (!Array.isArray(r.roles) || !Array.isArray(r.runnerVersions)) return { kind: 'unusable', row };
  return { kind: 'ok', row, result: r as unknown as RoleOutcomesResult };
}

export type RoleJudgement =
  | { state: 'clear'; reason: 'small_n' | 'above_floor' | 'no_dominant_signature' | 'baseline_low' }
  | { state: 'warming'; reason: 'baseline_thin' }
  | { state: 'firing' };

function pct(n: number, d: number): number {
  return d > 0 ? Math.round((n / d) * 100) : 0;
}

/** Pure per-role judgement. Order matters: cheap disqualifiers first, `warming` only for a real suspect. */
export function judgeRole(b: RoleOutcomeBucket, t: RoleRegressionThresholds): RoleJudgement {
  const recentN = b.recent.succeeded + b.recent.failed;
  if (recentN < t.minRecent) return { state: 'clear', reason: 'small_n' };
  if ((b.recent.succeeded / recentN) * 100 > t.recentFloorPct) return { state: 'clear', reason: 'above_floor' };
  const top = b.recent.signatures[0];
  if (!top || b.recent.failed === 0 || (top.count / b.recent.failed) * 100 < t.dominantSharePct) {
    return { state: 'clear', reason: 'no_dominant_signature' };
  }
  const baselineN = b.baseline.succeeded + b.baseline.failed;
  if (baselineN < t.baselineMin) return { state: 'warming', reason: 'baseline_thin' };
  if ((b.baseline.succeeded / baselineN) * 100 < t.baselineBarPct) return { state: 'clear', reason: 'baseline_low' };
  return { state: 'firing' };
}

// ── Change detection over the feed's own history ────────────────────────────

export interface ChangePoint {
  kind: 'runner' | 'app';
  /** What is running now. */
  to: string;
  /** What ran before. */
  from: string;
  /** Last feed row that still showed `from`. */
  notBefore: string;
  /** First feed row that showed `to`. */
  seenAt: string;
}

function runnerKey(r: RoleOutcomesResult): string | null {
  const parts = r.runnerVersions
    .map(v => `${v.version ?? '?'}${v.commit ? ` (${v.commit.slice(0, 7)})` : ''}`)
    .sort();
  // No live runner is an absence, not a build. Skipped so an hour with every
  // runner offline cannot masquerade as two deploys.
  return parts.length ? [...new Set(parts)].join(', ') : null;
}

function appKey(r: RoleOutcomesResult): string | null {
  return r.appCommit ? r.appCommit.slice(0, 7) : null;
}

/** Most recent change of `key` across oldest-first parsed rows, or null if none is visible. */
function lastChange(
  rows: Array<{ row: CronRunRow; result: RoleOutcomesResult }>,
  kind: ChangePoint['kind'],
  key: (r: RoleOutcomesResult) => string | null,
): ChangePoint | null {
  let prev: { at: string; key: string } | null = null;
  let change: ChangePoint | null = null;
  for (const { row, result } of rows) {
    const k = key(result);
    if (k === null) continue;
    if (prev && prev.key !== k) {
      change = { kind, from: prev.key, to: k, notBefore: prev.at, seenAt: row.started_at };
    }
    prev = { at: row.started_at, key: k };
  }
  return change;
}

function minutesBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 60_000);
}

/** The key line of the page. */
export function describeChange(change: ChangePoint | null, onsetAt: string, feedHours: number): string {
  if (!change) {
    return `No runner or web deploy change is visible in the last ${feedHours}h of the feed.`;
  }
  const what = change.kind === 'runner' ? `runner build ${change.to}` : `web deploy ${change.to}`;
  const bracket = `(changed from ${change.from} between ${change.notBefore} and ${change.seenAt})`;
  const afterEarliest = minutesBetween(change.notBefore, onsetAt);
  if (afterEarliest < 0) {
    return `Began ${-afterEarliest}m BEFORE ${what} could have landed ${bracket} — that change is not the cause.`;
  }
  const afterLatest = Math.max(0, minutesBetween(change.seenAt, onsetAt));
  const range = afterLatest === afterEarliest ? `${afterEarliest}` : `${afterLatest}–${afterEarliest}`;
  return `Started ${range} min after ${what} ${bracket}.`;
}

// ── Verdict ─────────────────────────────────────────────────────────────────

function verdict(over: Partial<Verdict> & { state: Verdict['state'] }): Verdict {
  return {
    detector: ID,
    conditionKey: over.state === 'blind' ? `${ID}:blind` : ID,
    summary: '',
    onsetAt: null,
    facts: {},
    ...over,
  };
}

function label(role: string): string {
  return role === NO_ROLE_BUCKET ? 'tasks with no role' : `role "${role}"`;
}

function clip(s: string): string {
  return s.length > MAX_SIGNATURE_IN_SUMMARY ? `${s.slice(0, MAX_SIGNATURE_IN_SUMMARY - 1)}…` : s;
}

function roleFacts(b: RoleOutcomeBucket) {
  const recentN = b.recent.succeeded + b.recent.failed;
  const baselineN = b.baseline.succeeded + b.baseline.failed;
  const top = b.recent.signatures[0] ?? null;
  return {
    role: b.role,
    recent: { n: recentN, succeeded: b.recent.succeeded, failed: b.recent.failed, excluded: b.recent.excluded, successPct: pct(b.recent.succeeded, recentN) },
    baseline: { n: baselineN, succeeded: b.baseline.succeeded, failed: b.baseline.failed, successPct: pct(b.baseline.succeeded, baselineN) },
    dominantSignature: top ? { ...top, sharePct: pct(top.count, b.recent.failed) } : null,
    excludedBy: b.recent.excludedBy,
  };
}

export function createRoleRegression(
  thresholds: RoleRegressionThresholds = DEFAULT_ROLE_REGRESSION,
): Detector {
  const t = { ...thresholds };
  return {
    id: ID,
    describes:
      `One role's success rate falls to <=${t.recentFloorPct}% over the last hour (n>=${t.minRecent}) ` +
      `on one dominant error signature, against >=${t.baselineBarPct}% over its prior 24h — ` +
      `read from the ${ROLE_OUTCOMES_JOB} cron feed, with the most recent deploy change.`,

    evaluate(snapshot: Snapshot, now: number): Verdict {
      if (snapshot.cronRuns === null) {
        return verdict({
          state: 'blind',
          summary:
            'Role regression detector cannot see: the cron_runs feed is unreadable' +
            (snapshot.cronRunsError ? ` (${snapshot.cronRunsError})` : '') + '.',
          facts: { reason: 'feed_unreadable', error: snapshot.cronRunsError ?? null },
        });
      }

      const rows = snapshot.cronRuns
        .filter(r => r.job === ROLE_OUTCOMES_JOB)
        .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));

      if (rows.length === 0) {
        return verdict({
          state: 'blind',
          summary:
            `Role regression detector cannot see: no runs of ${ROLE_OUTCOMES_JOB} in the feed, ` +
            `for a job scheduled every ${FEED_INTERVAL_MINUTES} minutes. Is it in the external scheduler?`,
          facts: { reason: 'no_runs_in_feed', job: ROLE_OUTCOMES_JOB },
        });
      }

      const latest = rows[0]!;
      const latestAgeMs = now - Date.parse(latest.started_at);
      if (latestAgeMs > FEED_STALE_AFTER_INTERVALS * FEED_INTERVAL_MS) {
        return verdict({
          state: 'blind',
          onsetAt: latest.started_at,
          summary:
            `Role regression detector cannot see: the newest ${ROLE_OUTCOMES_JOB} run is ` +
            `${Math.round(latestAgeMs / 60_000)}m old, past ${FEED_STALE_AFTER_INTERVALS} missed ` +
            `${FEED_INTERVAL_MINUTES}-minute ticks. A stale observation is not an all-clear.`,
          facts: { reason: 'feed_stale', latestRunAt: latest.started_at },
        });
      }

      const parsed = rows.map(parse);
      const newestJudged = parsed.find(p => p.kind !== 'unusable');
      if (newestJudged?.kind === 'mismatch') {
        return verdict({
          state: 'blind',
          onsetAt: newestJudged.row.started_at,
          summary:
            `Role regression detector cannot see: ${ROLE_OUTCOMES_JOB} is recording schema version ` +
            `${JSON.stringify(newestJudged.schemaVersion)}, this responder reads ` +
            `${ROLE_OUTCOMES_SCHEMA_VERSION}. Deploy the matching responder.`,
          facts: { reason: 'schema_mismatch', recorded: newestJudged.schemaVersion ?? null },
        });
      }

      let leadingUnusable = 0;
      for (const p of parsed) {
        if (p.kind === 'ok') break;
        leadingUnusable++;
      }
      if (leadingUnusable >= FEED_STALE_AFTER_INTERVALS || !newestJudged) {
        return verdict({
          state: 'blind',
          onsetAt: parsed[Math.max(0, leadingUnusable - 1)]!.row.started_at,
          summary:
            `Role regression detector cannot see: the last ${leadingUnusable} runs of ` +
            `${ROLE_OUTCOMES_JOB} produced no usable aggregate (failed, or recorded no result).`,
          facts: { reason: 'feed_job_failing', unusableRuns: leadingUnusable },
        });
      }

      // Newest-first, usable only. Unusable rows are transparent, as in dispatch-stall.
      const usable = parsed.filter((p): p is Extract<Parsed, { kind: 'ok' }> => p.kind === 'ok');
      const newest = usable[0]!;
      const judged = newest.result.roles.map(b => ({ bucket: b, judgement: judgeRole(b, t) }));
      const firing = judged.filter(j => j.judgement.state === 'firing');
      const warming = judged.filter(j => j.judgement.state === 'warming');

      const baseFacts = {
        job: ROLE_OUTCOMES_JOB,
        thresholds: t,
        latestRunAt: newest.row.started_at,
        recentMinutes: newest.result.recentMinutes,
        baselineHours: newest.result.baselineHours,
        rolesEvaluated: judged.length,
        truncated: newest.result.truncated,
      };

      if (firing.length === 0) {
        if (warming.length > 0) {
          return verdict({
            state: 'warming',
            summary:
              `Role regression: ${warming.map(w => label(w.bucket.role)).join(', ')} failing on one ` +
              `signature, but under ${t.baselineMin} baseline outcomes — no "before" to regress from yet.`,
            facts: { ...baseFacts, warming: warming.map(w => roleFacts(w.bucket)) },
          });
        }
        return verdict({
          state: 'clear',
          summary:
            `No role regression across ${judged.length} role(s) active in the last ` +
            `${newest.result.recentMinutes}m of ${ROLE_OUTCOMES_JOB}.`,
          facts: baseFacts,
        });
      }

      // Onset: walk back through older rows while the lead role stays firing,
      // then take its dominant signature's first sighting in the oldest one.
      const lead = firing[0]!.bucket;
      let onsetRow = newest;
      for (const p of usable.slice(1)) {
        const b = p.result.roles.find(r => r.role === lead.role);
        if (!b || judgeRole(b, t).state !== 'firing') break;
        onsetRow = p;
      }
      const onsetBucket = onsetRow.result.roles.find(r => r.role === lead.role) ?? lead;
      const onsetAt = onsetBucket.recent.signatures[0]?.firstSeen ?? onsetRow.row.started_at;

      const oldestFirst = [...usable].reverse();
      const runnerChange = lastChange(oldestFirst, 'runner', runnerKey);
      const appChange = lastChange(oldestFirst, 'app', appKey);
      const change =
        [runnerChange, appChange]
          .filter((c): c is ChangePoint => c !== null)
          .sort((a, b) => Date.parse(b.seenAt) - Date.parse(a.seenAt))[0] ?? null;
      const feedHours = Math.max(
        1,
        Math.round((Date.parse(newest.row.started_at) - Date.parse(oldestFirst[0]!.row.started_at)) / 3_600_000),
      );

      const lines = firing.map(({ bucket: b }) => {
        const f = roleFacts(b);
        const top = f.dominantSignature!;
        return (
          `${label(b.role)} ${f.recent.succeeded}/${f.recent.n} succeeded (${f.recent.successPct}%) in the last ` +
          `${newest.result.recentMinutes}m vs ${f.baseline.successPct}% over the prior ` +
          `${newest.result.baselineHours}h (n=${f.baseline.n}); ${top.count}/${f.recent.failed} failures share ` +
          `"${clip(top.signature)}"`
        );
      });

      return verdict({
        state: 'firing',
        onsetAt,
        summary:
          `Role regression: ${lines.join('. Also ')}. Failing since ${onsetAt}. ` +
          describeChange(change, onsetAt, feedHours),
        facts: {
          ...baseFacts,
          firing: firing.map(f => roleFacts(f.bucket)),
          onsetAt,
          change,
          runnerChange,
          appChange,
          runnerVersionsNow: newest.result.runnerVersions,
        },
      });
    },
  };
}

export const roleRegression: Detector = createRoleRegression();
