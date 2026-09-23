/**
 * Token-free circuit breaker for heartbeat cycles.
 *
 * Mission a1bd36bc ran 23 consecutive hourly organizer cycles that each died
 * within ~70s of a provider weekly-limit wall, 2026-09-17 08:00Z → 09-18
 * 01:01Z. The organizer is itself a Claude worker, so once the provider goes
 * away the mission has no supervisor — and every signal needed to notice was
 * already local (identical error, identical short lifetime, same mission,
 * back to back) with no LLM call required to read it. This module is that
 * read: it never calls a model and never depends on getting error
 * attribution right (see the companion budget-deferral fix) — it only counts.
 *
 * The window for "last N heartbeat tasks" is bounded to tasks created after
 * `missions.heartbeatBreakerTrippedAt`, not simply "the last N ever". Without
 * that bound, re-arming a tripped mission (status -> active) would have the
 * very next cron tick see the SAME N dead tasks — since none were created
 * while paused — and trip again before the mission ever got to try. Trip time
 * becomes the new window floor, so re-arming always buys a fresh run of N
 * attempts, and the breaker only re-trips on genuinely new failures.
 */
import { db } from '@buildd/core/db';
import { missions, missionNotes, taskSchedules, tasks } from '@buildd/core/db/schema';
import { and, desc, eq, gt } from 'drizzle-orm';
import { isDiedEarly, normalizeErrorSignature } from './failure-analytics';
import { notify } from './pushover';

/** Consecutive died-early heartbeat failures before the breaker trips. */
export const HEARTBEAT_BREAKER_THRESHOLD = 3;

export interface HeartbeatBreakerCheckInput {
  missionId: string;
  scheduleId: string;
  /** `missions.heartbeatBreakerTrippedAt` — bounds the evaluation window. */
  heartbeatBreakerTrippedAt: Date | null;
}

export interface HeartbeatBreakerSignal {
  tripped: boolean;
  /** Number of consecutive died-early failures found (0 unless tripped). */
  count: number;
  /** The shared error signature, for the feed note. Empty when not tripped. */
  errorSignature: string;
}

/**
 * Read-only: look at this heartbeat's last N bookkeeping tasks (scoped to
 * this schedule, so a mission is never judged by another mission's history)
 * and decide whether every one of them is terminal-failed and died early
 * (`isDiedEarly` — turns <= 2, $0 cost: a worker that burned a slot and did
 * nothing). Fewer than N tasks in the window is "not enough evidence yet",
 * never a trip. Any task that is not cleanly classifiable (no worker row, or
 * not failed) also means no trip — this must never suppress a heartbeat on
 * uncertainty, only on a clean, repeated, empty failure.
 */
export async function evaluateHeartbeatCircuitBreaker(
  input: HeartbeatBreakerCheckInput,
): Promise<HeartbeatBreakerSignal> {
  const recent = await db.query.tasks.findMany({
    where: and(
      eq(tasks.missionId, input.missionId),
      eq(tasks.scheduleId, input.scheduleId),
      ...(input.heartbeatBreakerTrippedAt ? [gt(tasks.createdAt, input.heartbeatBreakerTrippedAt)] : []),
    ),
    columns: { id: true, status: true },
    orderBy: [desc(tasks.createdAt)],
    limit: HEARTBEAT_BREAKER_THRESHOLD,
    with: {
      workers: {
        columns: { status: true, turns: true, costUsd: true, error: true },
        orderBy: (w, { desc: d }) => [d(w.startedAt)],
        limit: 1,
      },
    },
  });

  const none: HeartbeatBreakerSignal = { tripped: false, count: 0, errorSignature: '' };
  if (recent.length < HEARTBEAT_BREAKER_THRESHOLD) return none;

  const errors: string[] = [];
  for (const t of recent) {
    if (t.status !== 'failed') return none;
    const w = t.workers?.[0];
    if (!w) return none;
    const diedEarly = isDiedEarly({
      id: t.id,
      taskId: t.id,
      workspaceId: '',
      roleSlug: null,
      status: w.status,
      error: w.error,
      exitCause: null,
      turns: w.turns ?? 0,
      costUsd: Number(w.costUsd ?? 0),
      createdAt: new Date(),
      completedAt: null,
    });
    if (!diedEarly) return none;
    errors.push(normalizeErrorSignature(w.error ?? ''));
  }

  // All N died early. Report the most recent signature — the one that would
  // repeat on the next attempt too, if nothing changes.
  return { tripped: true, count: recent.length, errorSignature: errors[0] || '(no error captured)' };
}

/**
 * Apply a trip: atomically pause the mission (idempotent — only fires once,
 * guarded on `status = 'active'`), disable its heartbeat schedule the same
 * way an explicit `status: 'paused'` PATCH does, post one mission-feed
 * warning naming the repeated signature and count, and push the owner
 * notification.
 *
 * `manage_missions action=arm` or a `status: 'active'` PATCH re-enables the
 * schedule (existing behaviour in `PATCH /api/missions/[id]`) — that is the
 * re-arm; this module does not need its own clear step, see the module note.
 */
export async function tripHeartbeatCircuitBreaker(input: {
  missionId: string;
  missionTitle: string;
  scheduleId: string;
  count: number;
  errorSignature: string;
}): Promise<{ tripped: boolean }> {
  const now = new Date();

  const [claimed] = await db
    .update(missions)
    .set({ status: 'paused', heartbeatBreakerTrippedAt: now, updatedAt: now })
    .where(and(eq(missions.id, input.missionId), eq(missions.status, 'active')))
    .returning({ id: missions.id });

  if (!claimed) return { tripped: false };

  await db.update(taskSchedules)
    .set({ enabled: false, lastDeferralReason: 'heartbeat_circuit_breaker', lastDeferredAt: now, updatedAt: now })
    .where(eq(taskSchedules.id, input.scheduleId));

  const body =
    `${input.count} consecutive heartbeat cycles failed within moments of starting, all with the same ` +
    `signature: ${input.errorSignature}. Paused to stop burning cycles into the same wall instead of ` +
    `retrying blind. Re-arm once the cause is resolved (manage_missions action=arm, or set status: active) — ` +
    `that gives the mission a fresh run before the breaker can trip again.`;

  await db.insert(missionNotes).values({
    missionId: input.missionId,
    authorType: 'system',
    type: 'warning',
    title: 'Heartbeat paused: repeated early failures',
    body,
    status: 'open',
  }).catch(e => console.error(`[heartbeat-circuit-breaker] note failed for ${input.missionId}:`, e));

  notify({
    app: 'tasks',
    title: `Heartbeat paused: ${input.missionTitle}`,
    message: body,
    priority: 0,
  });

  return { tripped: true };
}

// ─── Planning-failure backoff ────────────────────────────────────────────────
//
// The breaker above only reads "died early" cycles (<=2 turns, $0): a wall the
// organizer never got past. It is blind to the other loop shape: an organizer
// that runs a dozen turns, cannot produce a plan or a completion (a goal
// criterion it cannot move, say), and fails the cycle with no confirmed
// outcome. Each of those costs real turns, and the cron dispatched the next
// one on the very next tick, indefinitely.
//
// This is a backoff, not a pause: after K consecutive failed cycles on the
// same schedule the next dispatch waits BASE * 2^(streak-K) past the most
// recent failure, capped at MAX. Any non-failed cycle ends the streak, and the
// wait is derived from task rows alone (no new state), so it clears itself the
// moment a cycle succeeds.

/** Consecutive failed heartbeat cycles before dispatch starts backing off. */
export const HEARTBEAT_PLANNING_BACKOFF_THRESHOLD = 3;
/** Wait after the K-th consecutive failure; doubles for each further one. */
export const HEARTBEAT_PLANNING_BACKOFF_BASE_MS = 60 * 60 * 1000;
/** Ceiling on the wait, so a stuck mission is still retried daily. */
export const HEARTBEAT_PLANNING_BACKOFF_MAX_MS = 24 * 60 * 60 * 1000;
/** How many recent cycles to read when measuring the streak. */
const PLANNING_BACKOFF_LOOKBACK = 12;

export interface HeartbeatPlanningBackoff {
  /** True when the next cycle must not be dispatched yet. */
  active: boolean;
  /** Consecutive failed cycles, newest first (capped by the lookback). */
  streak: number;
  /** Earliest time the next cycle may dispatch; null below the threshold. */
  resumeAt: Date | null;
}

/** One durable note per backoff episode, updated in place on each later step. */
const PLANNING_BACKOFF_NOTE_TITLE = 'Heartbeat backing off: repeated planning failures';

/**
 * Pure: given this schedule's recent cycles (newest first), decide whether to
 * hold the next dispatch. Only `status === 'failed'` extends the streak; the
 * first row that is anything else ends it.
 *
 * The wait is anchored on when the newest cycle failed (`failedAt`, the latest
 * worker's `completedAt`), falling back to the task's `createdAt`. Never on
 * `tasks.updatedAt`: any later write to the row (a reconcile or cleanup sweep)
 * would silently push the hold out.
 */
export function computeHeartbeatPlanningBackoff(
  recent: Array<{ status: string; failedAt?: Date | string | null; createdAt?: Date | string | null }>,
  now: Date,
): HeartbeatPlanningBackoff {
  let streak = 0;
  for (const t of recent) {
    if (t.status !== 'failed') break;
    streak++;
  }
  if (streak < HEARTBEAT_PLANNING_BACKOFF_THRESHOLD) return { active: false, streak, resumeAt: null };

  const anchorRaw = recent[0].failedAt ?? recent[0].createdAt ?? null;
  const anchor = anchorRaw ? new Date(anchorRaw).getTime() : now.getTime();
  // 2^(streak-K) passes the cap within a few steps; clamp the exponent anyway.
  const exponent = Math.min(streak - HEARTBEAT_PLANNING_BACKOFF_THRESHOLD, 16);
  const waitMs = Math.min(HEARTBEAT_PLANNING_BACKOFF_BASE_MS * 2 ** exponent, HEARTBEAT_PLANNING_BACKOFF_MAX_MS);
  const resumeAt = new Date(anchor + waitMs);
  return { active: now.getTime() < resumeAt.getTime(), streak, resumeAt };
}

/**
 * Read this schedule's recent cycles (same window floor as the breaker, so a
 * re-armed mission starts fresh) and compute the backoff.
 */
export async function evaluateHeartbeatPlanningBackoff(
  input: HeartbeatBreakerCheckInput,
  now: Date = new Date(),
): Promise<HeartbeatPlanningBackoff> {
  const recent = await db.query.tasks.findMany({
    where: and(
      eq(tasks.missionId, input.missionId),
      eq(tasks.scheduleId, input.scheduleId),
      ...(input.heartbeatBreakerTrippedAt ? [gt(tasks.createdAt, input.heartbeatBreakerTrippedAt)] : []),
    ),
    columns: { id: true, status: true, createdAt: true },
    orderBy: [desc(tasks.createdAt)],
    limit: PLANNING_BACKOFF_LOOKBACK,
    with: {
      workers: {
        columns: { completedAt: true },
        orderBy: (w, { desc: d }) => [d(w.startedAt)],
        limit: 1,
      },
    },
  });
  return computeHeartbeatPlanningBackoff(
    recent.map(t => ({ status: t.status, createdAt: t.createdAt, failedAt: t.workers?.[0]?.completedAt ?? null })),
    now,
  );
}

function planningBackoffNoteBody(backoff: HeartbeatPlanningBackoff): string {
  return (
    `${backoff.streak} consecutive heartbeat cycles failed. The next cycle is held until ` +
    `${backoff.resumeAt?.toISOString()}, and the wait doubles with each further failure. ` +
    `Check the latest cycle's error: a goal criterion the organizer cannot move, or a plan it ` +
    `cannot return, repeats on every cycle until the cause changes.`
  );
}

/**
 * Hold the schedule until `resumeAt`, and keep one open mission-feed warning
 * for the whole episode: posted on the first held step, updated in place on
 * each later step (the dedupe is the open note, not schedule state, which the
 * dispatch between steps overwrites). `resolveHeartbeatPlanningBackoffNote`
 * closes it once a cycle stops failing.
 */
export async function applyHeartbeatPlanningBackoff(input: {
  missionId: string;
  scheduleId: string;
  backoff: HeartbeatPlanningBackoff;
}): Promise<void> {
  const now = new Date();
  await db.update(taskSchedules)
    .set({
      nextRunAt: input.backoff.resumeAt,
      lastDeferralReason: 'heartbeat_planning_backoff',
      lastDeferredAt: now,
      updatedAt: now,
    })
    .where(eq(taskSchedules.id, input.scheduleId));

  const body = planningBackoffNoteBody(input.backoff);
  try {
    const existing = await db.query.missionNotes.findFirst({
      where: and(
        eq(missionNotes.missionId, input.missionId),
        eq(missionNotes.title, PLANNING_BACKOFF_NOTE_TITLE),
        eq(missionNotes.status, 'open'),
      ),
      columns: { id: true, body: true },
    });
    if (existing) {
      if (existing.body !== body) {
        await db.update(missionNotes).set({ body }).where(eq(missionNotes.id, existing.id));
      }
      return;
    }
    await db.insert(missionNotes).values({
      missionId: input.missionId,
      authorType: 'system',
      type: 'warning',
      title: PLANNING_BACKOFF_NOTE_TITLE,
      body,
      status: 'open',
    });
  } catch (e) {
    console.error(`[heartbeat-planning-backoff] note failed for ${input.missionId}:`, e);
  }
}

/** Close the open backoff note once the streak has ended (a cycle did not fail). */
export async function resolveHeartbeatPlanningBackoffNote(missionId: string): Promise<void> {
  await db
    .update(missionNotes)
    .set({ status: 'superseded' })
    .where(and(
      eq(missionNotes.missionId, missionId),
      eq(missionNotes.title, PLANNING_BACKOFF_NOTE_TITLE),
      eq(missionNotes.status, 'open'),
    ));
}
