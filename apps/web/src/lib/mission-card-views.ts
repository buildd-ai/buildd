/**
 * Server loader for mission cards (knowledge-base: buildd/design/mission-feed-mobile-continuity.md,
 * S5). The pure model is `mission-card-view.ts`; this adds the one extra read a
 * card needs that its page did not already make — the human steering marks the
 * time-axis strip in `FlightDetailSheet` draws — batched into a single query and
 * capped to the missions the surface actually shows.
 *
 * Callers select `MISSION_CARD_TASK_COLUMNS` / `MISSION_CARD_WORKER_COLUMNS` on
 * their own mission query, so the card never costs a second task fan-out.
 */
import { computeMissionFlightStrip } from '@buildd/core/mission-helpers';
import { loadHumanSteeringMarksByMission } from './mission-steering-notes';
import { adaptFlightStripInputs, MISSION_TASK_REFRESH_EXTRAS } from './missions-query';
import {
  buildMissionCardView,
  MISSION_CARD_VIEW_CAP,
  type BlockingTask,
  type MissionCardRow,
  type MissionCardSummary,
  type MissionCardView,
} from './mission-card-view';
import type { MissionOrigin } from './mission-task-href';
import type { DeliveryView } from './workflow/projections';
import { sqlOrderByFn } from '@buildd/core/db/relational-sql';
import { missions } from '@buildd/core/db/schema';
import { ne, or, sql, type SQL } from 'drizzle-orm';

// The card facts beyond its tasks, for surfaces that load cards through here
// (Home): the visual review it reads and the delivery facts it passes, the
// same ones the missions list reads (spec 8e137fdb I-1).
export { loadCardVisualReviews } from './mission-card-visual-reviews';
export { missionDeliveryFacts } from './mission-delivery-facts';

/** Task columns a card reads (pulse, feed state, situation, health, schedule timing). */
export const MISSION_CARD_TASK_COLUMNS = {
  id: true, title: true, status: true, createdAt: true, updatedAt: true, kind: true, mode: true,
  creationSource: true, category: true, parentTaskId: true, dependsOn: true, scheduleId: true,
  startAt: true, loopIteration: true, taskClass: true, roleSlug: true,
  missionPhaseIndex: true, missionPhaseLabel: true,
  // classifyMissionWait reads these to tell a self-resolving retry from a stall.
  // `context` arrives as a digest through MISSION_CARD_TASK_EXTRAS, never whole.
  loopConfig: true, loopState: true,
} as const;

export { MISSION_TASK_REFRESH_EXTRAS };

/**
 * The `tasks.context` keys a card derivation reads, and nothing else. The
 * whole column holds orchestration payloads (overlap notices, queued messages,
 * planning snapshots) that no card reads, and loading it for every task of
 * every mission made Home's mission query tens of MB per render (task 16e1cc50).
 * Readers: `classifySingleTaskWait` (budgetExhausted, infraRetryCount);
 * `deliverableRole` + `isTrunkRefreshTask` (finalVerification, surfaceFix,
 * specRepair, requireMergeCommit, refreshTrunk); the surface-audit readers
 * (surfaceAuditRound, surfaceAuditTrigger, visualQa); the PR-base resolver
 * (baseBranch, resumeBranch); `deriveCiRedChain` (prNumber,
 * failureContext.summary); `isHeartbeatTask` (heartbeat). A card that starts
 * reading another key adds it here; the parity test runs the readers over both.
 */
export const MISSION_CARD_CONTEXT_KEYS = [
  'budgetExhausted', 'infraRetryCount',
  'finalVerification', 'surfaceFix', 'specRepair', 'requireMergeCommit', 'refreshTrunk',
  'surfaceAuditRound', 'surfaceAuditTrigger', 'visualQa',
  'baseBranch', 'resumeBranch',
  'prNumber',
  'heartbeat',
] as const;
export const MISSION_CARD_CONTEXT_FAILURE_KEYS = ['summary'] as const;

type Json = Record<string, unknown>;

function pick(source: unknown, keys: readonly string[]): Json {
  const out: Json = {};
  if (!source || typeof source !== 'object' || Array.isArray(source)) return out;
  for (const k of keys) {
    const v = (source as Json)[k];
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

/** JS twin of the `context` extra: what a card receives in place of the full column. */
export function digestMissionCardContext(context: unknown): Json | null {
  if (context == null) return null;
  const out = pick(context, MISSION_CARD_CONTEXT_KEYS);
  const failure = pick((context as Json).failureContext, MISSION_CARD_CONTEXT_FAILURE_KEYS);
  if (Object.keys(failure).length > 0) out.failureContext = failure;
  return out;
}

/** `'k', col->'k'` pairs; keys are bound as text so `->` picks the text overload. */
function pairs(col: SQL, keys: readonly string[]): SQL {
  return sql.join(keys.map(k => sql`${k}::text, ${col}->${k}::text`), sql`, `);
}

function contextDigestSql(col: SQL): SQL {
  const failure = sql`(${col}->${'failureContext'}::text)`;
  const nested = sql`nullif(jsonb_strip_nulls(jsonb_build_object(${pairs(failure, MISSION_CARD_CONTEXT_FAILURE_KEYS)})), '{}'::jsonb)`;
  return sql`case when ${col} is null then null else jsonb_strip_nulls(jsonb_build_object(${pairs(col, MISSION_CARD_CONTEXT_KEYS)}, ${'failureContext'}::text, ${nested})) end`;
}

/** Task extras a card query uses: the refresh marker plus the context digest (as `context`). */
export const MISSION_CARD_TASK_EXTRAS = {
  ...MISSION_TASK_REFRESH_EXTRAS,
  context: (t: any, _ops?: unknown) => sql<Json | null>`${contextDigestSql(sql`${t.context}`)}`.as('card_context'),
};

/** Schedule extras a card query uses: the task template carries only `context.heartbeat`. */
export const MISSION_CARD_SCHEDULE_EXTRAS = {
  taskTemplate: (s: any, _ops?: unknown) => sql<{ context: { heartbeat?: unknown } } | null>`case when ${s.taskTemplate} is null then null else jsonb_build_object(${'context'}::text, jsonb_strip_nulls(jsonb_build_object(${'heartbeat'}::text, ${s.taskTemplate}->${'context'}::text->${'heartbeat'}::text))) end`.as('card_task_template'),
};

/**
 * How long a completed mission stays on Home: the longest window any Home
 * section reads a completed mission for (Landed this week). Older ones are
 * never loaded.
 */
export const HOME_COMPLETED_MISSION_WINDOW_MS = 7 * 86_400_000;

/** Home's mission bound: every unfinished mission, and completed ones inside the window. */
export function homeMissionRecencyWhere(now: number = Date.now()): SQL {
  const since = new Date(now - HOME_COMPLETED_MISSION_WINDOW_MS);
  return or(
    ne(missions.status, 'completed'),
    sql`coalesce(${missions.completedAt}, ${missions.updatedAt}) >= ${since.toISOString()}`,
  )!;
}

/** Worker columns a card reads (liveness, PR state, and the strip's spans). */
export const MISSION_CARD_WORKER_COLUMNS = {
  id: true, status: true, startedAt: true, completedAt: true, updatedAt: true, turns: true,
  prUrl: true, mergedAt: true, prNumber: true, prLifecycleStatus: true, supersededByPrNumber: true, abandonedAt: true, supersessionScan: true,
  exitCause: true,
} as const;

/**
 * The nested worker relation a card query uses: newest attempt first, so a
 * live re-claim is always inside the per-task limit.
 */
export const MISSION_CARD_WORKERS_WITH = {
  columns: MISSION_CARD_WORKER_COLUMNS,
  limit: 5,
  orderBy: sqlOrderByFn((w: any, { desc }: any) => [desc(w.startedAt), desc(w.updatedAt)]),
} as const;

/** Most cards one surface builds in a request. Home shows active + ≤ 3 scheduled. */
export { MISSION_CARD_VIEW_CAP };

export async function loadMissionCardViews(
  rows: readonly MissionCardRow[],
  opts: {
    from: MissionOrigin;
    now?: number;
    summaries?: ReadonlyMap<string, MissionCardSummary>;
    taskIndex?: ReadonlyMap<string, BlockingTask>;
    /** S35: the caller's `getDeliveryViewsForTasks(failedDeliverableTaskIds(rows))`. */
    deliveryViews?: ReadonlyMap<string, DeliveryView> | null;
  },
): Promise<Map<string, MissionCardView>> {
  const visible = rows.slice(0, MISSION_CARD_VIEW_CAP);
  const now = opts.now ?? Date.now();
  // Only an unfinished mission's strip is drawn live (completed cards are compact).
  const liveIds = visible.filter(r => !['completed', 'archived', 'cancelled'].includes(r.status)).map(r => r.id);
  const steering = liveIds.length > 0 ? await loadHumanSteeringMarksByMission(liveIds) : new Map();

  const views = new Map<string, MissionCardView>();
  for (const row of visible) {
    const live = liveIds.includes(row.id);
    const flightStrip = live
      ? (() => {
          const { tasks, workers } = adaptFlightStripInputs((row.tasks ?? []) as any[]);
          return computeMissionFlightStrip(tasks, workers, {
            missionCompletedAt: (row.completedAt as any) ?? null,
            steeringEvents: steering.get(row.id),
          });
        })()
      : null;
    views.set(row.id, buildMissionCardView(row, {
      from: opts.from, now, flightStrip, summary: opts.summaries?.get(row.id), taskIndex: opts.taskIndex,
      deliveryViews: opts.deliveryViews,
    }));
  }
  return views;
}
