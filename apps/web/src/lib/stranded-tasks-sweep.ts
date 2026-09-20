/**
 * Stranded-task detector.
 *
 * A task can sit `pending` forever behind a claim-loop gate with no signal
 * anywhere that it is stuck — the exact failure mode that stranded 9 CI-retry
 * tasks for 13 days (#1871) and made a refiled task "permanently unclaimable"
 * while siblings filed minutes later dispatched. The claim route now fires a
 * `gate_events` row on every deferral (see `apps/web/src/app/api/workers/claim/
 * route.ts`'s `deferTask`), coalesced per (taskId, reason) with a
 * `consecutiveDeferrals` counter and a `firstDeferredAt` timestamp that survives
 * every coalesced update. This sweep reads that ledger (plus `tasks.startAt`)
 * and promotes a task that has been stuck long enough into something a human —
 * or `explain` — can see without running SQL.
 *
 * Runs on the pr-reconcile cron's existing hourly cadence (see
 * `apps/web/src/app/api/cron/pr-reconcile/route.ts`) rather than a new cron:
 * this detector has nothing to do with PRs, but that route is already the one
 * hourly heartbeat in the codebase, and a 2-hour strand threshold does not need
 * finer granularity than that.
 */
import { db } from '@buildd/core/db';
import { tasks, missionNotes } from '@buildd/core/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { fireDeferralEvent, GATE_SLUGS } from './gate-ledger';
// A task pending past its own `startAt` by more than 2 hours is stranded (the
// `interval '2 hours'` literal in the query below — kept inline since it's a
// SQL interval, not a JS duration this module otherwise consumes). The
// counter-based path shares its threshold with the mission header's much
// earlier surfacing threshold, so the two cannot drift apart — see
// `claim-deferral-thresholds.ts`.
import { STRAND_CONSECUTIVE_THRESHOLD } from './claim-deferral-thresholds';

const STRANDED_NOTE_PREFIX = '[stranded]';

function strandedNoteTitle(taskId: string): string {
  return `${STRANDED_NOTE_PREFIX} task ${taskId.slice(0, 8)}`;
}

function formatDuration(ms: number): string {
  const hours = ms / (60 * 60 * 1000);
  if (hours >= 1) return `${hours.toFixed(1)}h`;
  return `${Math.max(1, Math.round(ms / 60000))}m`;
}

interface StrandedCandidateRow {
  id: string;
  title: string;
  workspaceId: string;
  missionId: string | null;
  startAt: string | null;
  reason: string | null;
  detail: Record<string, unknown> | null;
}

export interface StrandedSweepResult {
  scanned: number;
  stranded: number;
  cleared: number;
}

/**
 * Flag every pending task stuck past the strand threshold with one gate_events
 * row (outcome=stranded, coalesced) and one open mission note, then clear any
 * previously-stranded task that re-armed (claimed, cancelled, completed, or
 * failed since).
 */
export async function sweepStrandedTasks(): Promise<StrandedSweepResult> {
  const result = await db.execute(sql`
    WITH latest_deferral AS (
      SELECT DISTINCT ON (task_id) task_id, reason, detail
      FROM gate_events
      WHERE gate = ${GATE_SLUGS.CLAIM_LOOP_DEFERRAL}
        AND outcome = 'deferred'
        AND task_id IS NOT NULL
      ORDER BY task_id, occurred_at DESC
    )
    SELECT
      t.id AS "id",
      t.title AS "title",
      t.workspace_id AS "workspaceId",
      t.mission_id AS "missionId",
      t.start_at AS "startAt",
      ld.reason AS "reason",
      ld.detail AS "detail"
    FROM ${tasks} t
    LEFT JOIN latest_deferral ld ON ld.task_id = t.id
    WHERE t.status = 'pending'
      AND (
        (t.start_at IS NOT NULL AND t.start_at < now() - interval '2 hours')
        OR (
          ld.detail IS NOT NULL
          AND (ld.detail ->> 'consecutiveDeferrals')::int >= ${STRAND_CONSECUTIVE_THRESHOLD}
        )
      )
  `);

  const candidates = (result.rows ?? []) as unknown as StrandedCandidateRow[];
  let stranded = 0;

  for (const c of candidates) {
    const detail = c.detail;
    const firstDeferredAt = detail && typeof detail.firstDeferredAt === 'string' ? detail.firstDeferredAt : null;
    const strandedSinceMs = c.startAt
      ? new Date(c.startAt).getTime()
      : firstDeferredAt
        ? new Date(firstDeferredAt).getTime()
        : Date.now();
    const durationMs = Math.max(0, Date.now() - strandedSinceMs);
    const reason = c.reason ?? (c.startAt ? 'startAt_elapsed' : 'unknown');

    const title = strandedNoteTitle(c.id);
    const body =
      `Task "${c.title}" (${c.id.slice(0, 8)}) has been pending and unclaimable for ${formatDuration(durationMs)} ` +
      `— last deferral reason: ${reason}. Nothing re-arms this automatically; it needs a look.`;

    const existingNote = await db.query.missionNotes.findFirst({
      where: and(eq(missionNotes.taskId, c.id), eq(missionNotes.title, title), eq(missionNotes.status, 'open')),
      columns: { id: true, body: true },
    });

    if (!existingNote) {
      await db.insert(missionNotes).values({
        missionId: c.missionId,
        taskId: c.id,
        authorType: 'system',
        type: 'warning',
        title,
        body,
        status: 'open',
      });
      stranded += 1;
    } else if (existingNote.body !== body) {
      await db.update(missionNotes).set({ body }).where(eq(missionNotes.id, existingNote.id));
    }

    // Coalesced like a deferral: re-detecting the same stranded task on the next
    // sweep updates one row's `consecutiveDeferrals`/`occurredAt` rather than
    // inserting a fresh `stranded` row every hour it stays stuck.
    fireDeferralEvent({
      gate: GATE_SLUGS.CLAIM_LOOP_DEFERRAL,
      surface: 'sweepStrandedTasks',
      outcome: 'stranded',
      reason,
      workspaceId: c.workspaceId,
      missionId: c.missionId,
      taskId: c.id,
      callerOrigin: 'system',
      detail: { durationMs },
    });
  }

  const cleared = await clearResolvedStrandedNotes();

  return { scanned: candidates.length, stranded, cleared };
}

/**
 * Supersede any open `[stranded]` note whose task is no longer pending — it
 * claimed, was cancelled, completed, or failed since the last sweep. This is
 * the "re-armed task clears the stranded state" half of the detector; without
 * it a note posted once would sit open forever even after the task resolved.
 */
async function clearResolvedStrandedNotes(): Promise<number> {
  const resolved = await db.execute(sql`
    SELECT mn.id AS "id"
    FROM ${missionNotes} mn
    LEFT JOIN ${tasks} t ON t.id = mn.task_id
    WHERE mn.title LIKE ${STRANDED_NOTE_PREFIX + '%'}
      AND mn.status = 'open'
      AND (t.id IS NULL OR t.status <> 'pending')
  `);
  const ids = ((resolved.rows ?? []) as unknown as { id: string }[]).map(r => r.id);
  if (ids.length === 0) return 0;

  for (const id of ids) {
    await db.update(missionNotes).set({ status: 'superseded' }).where(eq(missionNotes.id, id));
  }
  return ids.length;
}
