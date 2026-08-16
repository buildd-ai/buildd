import { db } from '@buildd/core/db';
import { workers, tasks, missions, initiatives } from '@buildd/core/db/schema';
import { eq, and, sql, gte } from 'drizzle-orm';
import { deriveTaskType } from '@buildd/core/mission-helpers';

/**
 * Initiative pulse — the daily-signal half of an initiative, shared by every
 * surface that shows one (spec: docs/specs/surface-ia-home-missions-initiatives.md).
 *
 * Three parts, deliberately split — the effort window, the pending counts, and
 * the winning verdict (§6.5):
 *   - `loadInitiativeEffort` — the ONE grouped SQL aggregation over
 *     workers → tasks → missions. Before this module it existed twice: inline in
 *     the Missions page (team-scoped, bucket key `__unassigned__`) and in
 *     `GET /api/initiatives/effort` (workspace-scoped, bucket key `unassigned`).
 *     Those two disagreed; there is now one query and one key.
 *   - `derivePendingCounts` — pure derivation of the four pending-action counts
 *     from mission rows the caller has already loaded. No extra query: a caller
 *     rendering missions already holds the tasks and workers this needs.
 *   - `loadInitiativeVerdictInputs` + `deriveVerdict` — the motion evidence and
 *     the ladder that turns it into one word. The SQL is separate from the
 *     ladder because the ladder must be total and cheap to test.
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

// ─── The winning verdict (spec §6.5) ─────────────────────────────────────────

/**
 * "Are we winning?" — the initiative-level health dimension the three-dimension
 * model in lib/initiative-presentation.ts names but never implemented.
 *
 * Progress percentage is deliberately NOT an input. Task count is the one
 * quantity an autonomous fleet inflates by working: more tasks closed, same
 * outcome. A verdict derived from it would congratulate a fleet for churning.
 */

export type Verdict =
  | 'losing'
  | 'grinding'
  | 'stuck'
  | 'won_unclaimed'
  | 'winning'
  | 'dormant'
  | 'empty';

/** Whether an oracle actually checked the outcome, or nobody did. */
export type Confidence = 'verified' | 'unverified';

/** Rework may outrun ships by this factor before the arc reads as losing. */
export const THRASH_RATIO = 3;

/** The verdict looks at the last 7 days; `effortDays` holds 14 (§6.1). */
export const VERDICT_WINDOW_DAYS = 7;

/** Display copy. The spec fixes these strings; surfaces MUST NOT re-word them. */
export const VERDICT_LABEL: Record<Verdict, string> = {
  losing: 'Losing',
  grinding: 'Grinding',
  stuck: 'Stuck',
  won_unclaimed: 'Ready to close',
  winning: 'Winning',
  dormant: 'Dormant',
  empty: 'Empty',
};

export interface VerdictInputs {
  /** Initiative lifecycle status from the DB. */
  status: string;
  totalMissions: number;
  /** Every child mission in a terminal status ('completed' | 'archived'). */
  allTerminal: boolean;
  /** Child missions whose criteria failed, plus the initiative's own failing KPIs. */
  criteriaFail: number;
  merges7d: number;
  attempts7d: number;
  tokens7d: number;
  held: number;
  blocked: number;
  awaitingVerification: number;
}

/**
 * The §6.5 ladder: evaluated top to bottom, first match wins, total — every
 * initiative gets exactly one verdict, so no surface needs a fallback branch.
 *
 * Pure. Order is the specification; do not reorder without changing the spec.
 */
export function deriveVerdict(i: VerdictInputs): Verdict {
  // Nothing to judge. Evaluated first so no later rule sees a zero-mission arc.
  if (i.totalMissions === 0) return 'empty';

  // A verified failure outranks every motion signal: shipping fast in the wrong
  // direction is the failure mode motion alone cannot see.
  if (i.criteriaFail > 0) return 'losing';

  // Rework outrunning ships. max(merges,1) so an arc burning tokens on nothing
  // but retries is judged against a floor of one rather than dividing by zero.
  if (i.tokens7d > 0 && i.attempts7d > THRASH_RATIO * Math.max(i.merges7d, 1)) return 'losing';

  // Work finished, nobody closed the arc. The honest reading of the old
  // `AWAITING` chip — and the one state here that is a prompt, not a problem.
  if (i.allTerminal && i.status === 'active') return 'won_unclaimed';

  // Tokens burning, tasks closing, nothing merged. The state a percentage
  // cannot express, which is the whole reason this ladder exists.
  if (i.tokens7d > 0 && i.merges7d === 0) return 'grinding';

  if (i.tokens7d > 0) return 'winning';

  // No burn, but something is waiting on a human.
  if (i.held + i.blocked + i.awaitingVerification > 0) return 'stuck';

  return 'dormant';
}

export interface ConfidenceInputs {
  totalMissions: number;
  /** Child missions that have criteria AND an `overall` of 'pass' or 'fail'. */
  verifiedMissions: number;
  /**
   * The initiative's own `kpiState.overall`, or null when it has no KPIs.
   * 'UNVERIFIED' and 'NOT_EVALUATED' both count as no evidence — the first
   * means checked-but-ambiguous, the second never-checked, and neither
   * establishes an outcome.
   */
  kpiOverall: string | null;
}

/**
 * Confidence is independent of the verdict and MUST NOT change it. It says
 * whether anything actually checked the outcome, which is why a verdict renders
 * as `Winning · unverified` rather than silently claiming more than it knows.
 *
 * A zero-mission initiative is `unverified` unless its own KPIs say otherwise:
 * "every child mission is verified" is vacuously true of no missions, and
 * reporting an empty arc as verified would be the exact overclaim this guards.
 */
export function deriveConfidence(i: ConfidenceInputs): Confidence {
  if (i.kpiOverall === 'pass' || i.kpiOverall === 'fail') return 'verified';
  if (i.totalMissions === 0) return 'unverified';
  return i.verifiedMissions === i.totalMissions ? 'verified' : 'unverified';
}

/**
 * `tokens7d` — the sum of the last `windowDays` entries of an effort window.
 *
 * The window MUST be the team-scoped one. A workspace-narrowed window would let
 * the sidebar filter change an initiative's verdict, the same hazard §6.3 rules
 * out for progress.
 */
export function sumRecentTokens(days: EffortDay[], windowDays = VERDICT_WINDOW_DAYS): number {
  return days.slice(-windowDays).reduce((n, d) => n + d.tokens, 0);
}

/** What the DB can tell us about an initiative's motion, per initiative id. */
export interface VerdictRollup {
  status: string;
  totalMissions: number;
  allTerminal: boolean;
  criteriaFail: number;
  verifiedMissions: number;
  kpiOverall: string | null;
  merges7d: number;
  attempts7d: number;
}

export function emptyVerdictRollup(status = 'active'): VerdictRollup {
  return {
    status,
    totalMissions: 0,
    allTerminal: false,
    criteriaFail: 0,
    verifiedMissions: 0,
    kpiOverall: null,
    merges7d: 0,
    attempts7d: 0,
  };
}

/**
 * Load every DB-derived verdict input for a team's initiatives.
 *
 * Team-scoped only, on purpose: unlike `loadInitiativeEffort` — which the HTTP
 * route needs workspace-scoped — a verdict narrowed by the active workspace
 * filter would flip as the user changed a dropdown. Callers hold mission rows
 * already, but those are capped (the Missions page loads 50 missions with 5
 * workers each) and workspace-filtered, so counting from them would silently
 * under-report. These counts come from their own uncapped queries.
 *
 * `tokens7d` is not here: it comes from the effort window the caller already
 * loaded, via `sumRecentTokens`.
 */
export async function loadInitiativeVerdictInputs(opts: {
  teamId: string;
  windowDays?: number;
}): Promise<Map<string, VerdictRollup>> {
  const { teamId } = opts;
  if (!teamId) throw new Error('loadInitiativeVerdictInputs requires teamId');
  const windowDays = opts.windowDays ?? VERDICT_WINDOW_DAYS;
  const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  const criteriaOverall = sql`${missions.goalCriteriaState}->>'overall'`;

  const [missionRollups, initiativeRows, mergeRows, attemptRows] = await Promise.all([
    // Child-mission rollup. Uncapped and unfiltered by workspace. The terminal
    // set ('completed', 'archived') is the one `computeInitiativeProgress` uses
    // to reach its 'completed' rollup — the two MUST NOT diverge.
    db
      .select({
        initiativeId: missions.initiativeId,
        totalMissions: sql<number>`COUNT(*)`,
        openMissions: sql<number>`COUNT(*) FILTER (WHERE ${missions.status} NOT IN ('completed', 'archived'))`,
        criteriaFail: sql<number>`COUNT(*) FILTER (WHERE ${criteriaOverall} = 'fail')`,
        verifiedMissions: sql<number>`COUNT(*) FILTER (WHERE ${criteriaOverall} IN ('pass', 'fail'))`,
      })
      .from(missions)
      .where(eq(missions.teamId, teamId))
      .groupBy(missions.initiativeId),

    // The initiative's own lifecycle status and KPI verdict.
    db
      .select({
        id: initiatives.id,
        status: initiatives.status,
        kpiOverall: sql<string | null>`${initiatives.kpiState}->>'overall'`,
      })
      .from(initiatives)
      .where(eq(initiatives.teamId, teamId)),

    // Ships: workers whose PR merged inside the window.
    db
      .select({
        initiativeId: missions.initiativeId,
        merges: sql<number>`COUNT(*)`,
      })
      .from(workers)
      .innerJoin(tasks, eq(tasks.id, workers.taskId))
      .innerJoin(missions, eq(missions.id, tasks.missionId))
      .where(and(eq(missions.teamId, teamId), gte(workers.mergedAt, cutoff)))
      .groupBy(missions.initiativeId),

    // Rework: tasks created in the window, classified in TS rather than SQL so
    // `deriveTaskType`'s rules stay the single source of truth. `mode` is part
    // of that classification — a spawned builder task (parentTaskId set,
    // mode 'execution', no prefix) is a deliverable, not an attempt — so
    // omitting it would read approve_plan children as thrash.
    db
      .select({
        initiativeId: missions.initiativeId,
        title: tasks.title,
        parentTaskId: tasks.parentTaskId,
        mode: tasks.mode,
      })
      .from(tasks)
      .innerJoin(missions, eq(missions.id, tasks.missionId))
      .where(and(eq(missions.teamId, teamId), gte(tasks.createdAt, cutoff))),
  ]);

  return assembleVerdictRollups({
    missionRollups: missionRollups as MissionRollupRow[],
    initiativeRows: initiativeRows as InitiativeStatusRow[],
    mergeRows: mergeRows as MergeRow[],
    attemptRows: attemptRows as AttemptRow[],
  });
}

export interface MissionRollupRow {
  initiativeId: string | null;
  totalMissions: number | string;
  openMissions: number | string;
  criteriaFail: number | string;
  verifiedMissions: number | string;
}
export interface InitiativeStatusRow {
  id: string;
  status: string;
  kpiOverall: string | null;
}
export interface MergeRow {
  initiativeId: string | null;
  merges: number | string;
}
export interface AttemptRow {
  initiativeId: string | null;
  title: string;
  parentTaskId: string | null;
  /** 'execution' | 'planning'. Required: it decides attempt vs. deliverable. */
  mode: string | null;
}

/**
 * Fold the four row sets into one rollup per initiative. Pure, and exported for
 * tests so the assembly is checkable without a database.
 *
 * Every initiative the team owns gets an entry even with no missions and no
 * motion — an arc that exists but has nothing under it must still reach the
 * ladder, where it resolves to 'empty' rather than being absent from the map.
 * `TERMINAL_MISSION_STATUSES` is applied in SQL; `allTerminal` here is just
 * "no open missions, and at least one mission".
 */
export function assembleVerdictRollups(input: {
  missionRollups: MissionRollupRow[];
  initiativeRows: InitiativeStatusRow[];
  mergeRows: MergeRow[];
  attemptRows: AttemptRow[];
}): Map<string, VerdictRollup> {
  const out = new Map<string, VerdictRollup>();

  for (const row of input.initiativeRows) {
    out.set(row.id, { ...emptyVerdictRollup(row.status), kpiOverall: row.kpiOverall ?? null });
  }

  const bucket = (key: string): VerdictRollup => {
    let rollup = out.get(key);
    if (!rollup) {
      rollup = emptyVerdictRollup();
      out.set(key, rollup);
    }
    return rollup;
  };

  for (const row of input.missionRollups) {
    const rollup = bucket(row.initiativeId ?? UNASSIGNED_INITIATIVE_KEY);
    const total = Number(row.totalMissions ?? 0);
    const open = Number(row.openMissions ?? 0);
    rollup.totalMissions = total;
    rollup.allTerminal = total > 0 && open === 0;
    rollup.criteriaFail = Number(row.criteriaFail ?? 0);
    rollup.verifiedMissions = Number(row.verifiedMissions ?? 0);
  }

  for (const row of input.mergeRows) {
    bucket(row.initiativeId ?? UNASSIGNED_INITIATIVE_KEY).merges7d += Number(row.merges ?? 0);
  }

  for (const row of input.attemptRows) {
    const type = deriveTaskType({ title: row.title, parentTaskId: row.parentTaskId, mode: row.mode });
    if (type === null) continue;
    bucket(row.initiativeId ?? UNASSIGNED_INITIATIVE_KEY).attempts7d++;
  }

  return out;
}

/**
 * Compose a rollup, its effort window and its pending counts into the verdict
 * pair every surface renders. The one place the three parts of this module meet.
 *
 * A failing KPI on the initiative itself counts toward `criteriaFail` alongside
 * its missions' failing criteria (§6.5) — an arc whose own KPI failed is losing
 * no matter how healthy the missions beneath it look.
 */
export function deriveInitiativeVerdict(input: {
  rollup: VerdictRollup;
  effortDays: EffortDay[];
  counts: PendingCounts;
}): { verdict: Verdict; confidence: Confidence; tokens7d: number } {
  const { rollup, effortDays, counts } = input;
  const tokens7d = sumRecentTokens(effortDays);
  const criteriaFail = rollup.criteriaFail + (rollup.kpiOverall === 'fail' ? 1 : 0);

  return {
    verdict: deriveVerdict({
      status: rollup.status,
      totalMissions: rollup.totalMissions,
      allTerminal: rollup.allTerminal,
      criteriaFail,
      merges7d: rollup.merges7d,
      attempts7d: rollup.attempts7d,
      tokens7d,
      held: counts.held,
      blocked: counts.blocked,
      awaitingVerification: counts.awaitingVerification,
    }),
    confidence: deriveConfidence({
      totalMissions: rollup.totalMissions,
      verifiedMissions: rollup.verifiedMissions,
      kpiOverall: rollup.kpiOverall,
    }),
    tokens7d,
  };
}
