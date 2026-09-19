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
