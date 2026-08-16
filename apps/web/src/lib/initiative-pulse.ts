import { db } from '@buildd/core/db';
import { workers, tasks, missions } from '@buildd/core/db/schema';
import { eq, and, sql } from 'drizzle-orm';

/**
 * Initiative pulse — the daily-signal half of an initiative, shared by every
 * surface that shows one (spec: docs/specs/surface-ia-home-missions-initiatives.md).
 *
 * Two halves, deliberately split:
 *   - `loadInitiativeEffort` — the ONE grouped SQL aggregation over
 *     workers → tasks → missions. Before this module it existed twice: inline in
 *     the Missions page (team-scoped, bucket key `__unassigned__`) and in
 *     `GET /api/initiatives/effort` (workspace-scoped, bucket key `unassigned`).
 *     Those two disagreed; there is now one query and one key.
 *   - `derivePendingCounts` — pure derivation of the four pending-action counts
 *     from mission rows the caller has already loaded. No extra query: a caller
 *     rendering missions already holds the tasks and workers this needs.
 *
 * Progress is NOT computed here. It stays with `computeInitiativeProgress` in
 * packages/core/mission-helpers.ts, whose correctness is a property of the query
 * scope handed to it (all missions, all tasks, no workspace filter).
 */

/** Bucket key for missions with no initiative. The only legal spelling. */
export const UNASSIGNED_INITIATIVE_KEY = '__unassigned__';

export const EFFORT_WINDOW_DAYS = 14;

export interface EffortDay {
  /** ISO "YYYY-MM-DD", UTC. */
  date: string;
  /** SUM(input_tokens + output_tokens) across the day's workers. */
  tokens: number;
  /** Workers that finished with a PR url. */
  merged: number;
  /** Workers in status 'error'. */
  failed: number;
  /** Workers in neither terminal state. */
  open: number;
}

/** One raw aggregation row, before window back-fill. */
export interface EffortRow {
  initiativeId: string | null;
  day: string;
  tokens: number | string;
  merged: number | string;
  failed: number | string;
  open: number | string;
}

function emptyDay(date: string): EffortDay {
  return { date, tokens: 0, merged: 0, failed: 0, open: 0 };
}

/** UTC calendar date, `days` before `end`, as "YYYY-MM-DD". */
function isoDayOffset(end: Date, days: number): string {
  const d = new Date(end);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * Back-fill sparse aggregation rows into a dense window of exactly
 * `windowDays` entries per initiative, oldest first, **ending today**.
 *
 * Anchoring on today rather than on the latest row present is the point: a
 * sparse array whose last entry is 5 days old renders as if that activity
 * happened at the right-hand edge, which reads as "busy right now" for an
 * initiative that has been silent all week.
 *
 * Pure, and exported for tests.
 */
export function buildEffortWindow(
  rows: EffortRow[],
  opts: { windowDays?: number; today?: Date } = {},
): Map<string, EffortDay[]> {
  const windowDays = opts.windowDays ?? EFFORT_WINDOW_DAYS;
  const today = opts.today ?? new Date();

  // date → row, per initiative bucket
  const byInitiative = new Map<string, Map<string, EffortDay>>();
  for (const row of rows) {
    const key = row.initiativeId ?? UNASSIGNED_INITIATIVE_KEY;
    if (!byInitiative.has(key)) byInitiative.set(key, new Map());
    // A day appearing twice for one initiative is summed, never overwritten.
    const days = byInitiative.get(key)!;
    const date = String(row.day).slice(0, 10);
    const prev = days.get(date) ?? emptyDay(date);
    days.set(date, {
      date,
      tokens: prev.tokens + Number(row.tokens ?? 0),
      merged: prev.merged + Number(row.merged ?? 0),
      failed: prev.failed + Number(row.failed ?? 0),
      open: prev.open + Number(row.open ?? 0),
    });
  }

  const window: string[] = [];
  for (let i = windowDays - 1; i >= 0; i--) window.push(isoDayOffset(today, i));

  const out = new Map<string, EffortDay[]>();
  for (const [key, days] of byInitiative) {
    out.set(key, window.map((date) => days.get(date) ?? emptyDay(date)));
  }
  return out;
}

/** A dense all-zero window — what a caller renders for an initiative with no rows. */
export function zeroEffortWindow(opts: { windowDays?: number; today?: Date } = {}): EffortDay[] {
  const windowDays = opts.windowDays ?? EFFORT_WINDOW_DAYS;
  const today = opts.today ?? new Date();
  const out: EffortDay[] = [];
  for (let i = windowDays - 1; i >= 0; i--) out.push(emptyDay(isoDayOffset(today, i)));
  return out;
}

export interface LoadEffortOptions {
  /** Scope to a team. Mutually exclusive with `workspaceId`; one is required. */
  teamId?: string;
  /** Scope to a single workspace's missions. */
  workspaceId?: string;
  windowDays?: number;
}

/**
 * The single effort aggregation. Workers are attributed to the calendar day of
 * `completedAt`, falling back to `updatedAt` while a worker is still running.
 *
 * Returns a dense `windowDays`-entry array per initiative that has any row in
 * the window; initiatives with no activity are simply absent — callers pair the
 * result with their own initiative list and fall back to `zeroEffortWindow()`.
 */
export async function loadInitiativeEffort(opts: LoadEffortOptions): Promise<Map<string, EffortDay[]>> {
  const { teamId, workspaceId } = opts;
  if (!teamId && !workspaceId) {
    throw new Error('loadInitiativeEffort requires teamId or workspaceId');
  }
  const windowDays = opts.windowDays ?? EFFORT_WINDOW_DAYS;
  const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const attributedAt = sql`COALESCE(${workers.completedAt}, ${workers.updatedAt})`;

  const scope = workspaceId
    ? eq(missions.workspaceId, workspaceId)
    : eq(missions.teamId, teamId!);

  const rows = await db
    .select({
      initiativeId: missions.initiativeId,
      day: sql<string>`DATE(${attributedAt} AT TIME ZONE 'UTC')`,
      tokens: sql<number>`SUM(${workers.inputTokens} + ${workers.outputTokens})`,
      merged: sql<number>`COUNT(*) FILTER (WHERE ${workers.status} = 'completed' AND ${workers.prUrl} IS NOT NULL)`,
      failed: sql<number>`COUNT(*) FILTER (WHERE ${workers.status} = 'error')`,
      open: sql<number>`COUNT(*) FILTER (WHERE ${workers.status} NOT IN ('completed', 'error'))`,
    })
    .from(workers)
    .innerJoin(tasks, eq(tasks.id, workers.taskId))
    .innerJoin(missions, eq(missions.id, tasks.missionId))
    .where(and(scope, sql`${attributedAt} >= ${cutoff}`))
    .groupBy(missions.initiativeId, sql`DATE(${attributedAt} AT TIME ZONE 'UTC')`);

  return buildEffortWindow(rows as EffortRow[], { windowDays });
}

// ─── Pending-action counts ────────────────────────────────────────────────────

export interface PendingCounts {
  /** Completed tasks whose PR is open and not closed. */
  awaitingVerification: number;
  /** Pending tasks blocked on an unmerged PR. */
  blocked: number;
  /** Child missions with isHeld = true. */
  held: number;
  /** Missions shipped within the last 7 days. */
  shippedThisWeek: number;
}

/** What `derivePendingCounts` needs from one mission the caller already loaded. */
export interface PulseMission {
  initiativeId: string | null;
  isHeld?: boolean | null;
  /** Health as derived by `deriveMissionHealth`; 'shipped' feeds shippedThisWeek. */
  health?: string | null;
  lastActivityAt?: string | Date | null;
  /** Pre-computed by the caller (it already resolves dependsOn across missions). */
  blockedPRCount?: number;
  tasks?: Array<{
    status: string;
    workers?: Array<{ prUrl?: string | null; mergedAt?: unknown; prLifecycleStatus?: string | null }> | null;
  }> | null;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function zeroCounts(): PendingCounts {
  return { awaitingVerification: 0, blocked: 0, held: 0, shippedThisWeek: 0 };
}

/**
 * Derive the four pending-action counts per initiative from mission rows the
 * caller already holds. Missions with no `initiativeId` are bucketed under
 * `UNASSIGNED_INITIATIVE_KEY` so the unassigned pseudo-initiative gets the same
 * treatment as a real one.
 *
 * Pure — no DB, no clock beyond `now` (injectable for tests).
 */
export function derivePendingCounts(
  missionRows: PulseMission[],
  opts: { now?: number } = {},
): Map<string, PendingCounts> {
  const now = opts.now ?? Date.now();
  const out = new Map<string, PendingCounts>();

  const bucket = (key: string): PendingCounts => {
    let counts = out.get(key);
    if (!counts) {
      counts = zeroCounts();
      out.set(key, counts);
    }
    return counts;
  };

  for (const m of missionRows) {
    const counts = bucket(m.initiativeId ?? UNASSIGNED_INITIATIVE_KEY);

    for (const t of m.tasks ?? []) {
      if (t.status !== 'completed') continue;
      const hasOpenPR = (t.workers ?? []).some(
        (w) => w.prUrl && !w.mergedAt && w.prLifecycleStatus !== 'closed',
      );
      if (hasOpenPR) counts.awaitingVerification++;
    }

    counts.blocked += m.blockedPRCount ?? 0;
    if (m.isHeld) counts.held++;

    if (m.health === 'shipped' && m.lastActivityAt) {
      const age = now - new Date(m.lastActivityAt as any).getTime();
      if (age <= SEVEN_DAYS_MS) counts.shippedThisWeek++;
    }
  }

  return out;
}

/** Zero counts, for an initiative absent from `derivePendingCounts`. */
export function noPendingCounts(): PendingCounts {
  return zeroCounts();
}
