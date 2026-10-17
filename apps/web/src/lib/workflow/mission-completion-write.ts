/**
 * The one statement that completes a mission on an automated path
 * (docs/specs/workflow-kernel-library.md §1 "mission completion", §6, S4b).
 *
 * `completeMissionIfVerified` decides; this writes. For a mission with delivery records
 * (`workflow_mission_epochs`) completion is delivery state, so the write is compare-and-set on
 * the epochs the decision read: their fingerprint (each epoch's id, version and state) must be
 * the same when the row flips. A merge, settlement or retirement recorded between the read and
 * the write leaves the mission active, and the next trigger decides again on the new state.
 * Every caller (task-terminal subscribers, pr-reconcile, the schedules cron, evaluate, the
 * mission loop, the epoch reconcile itself) is therefore a request into the same writer, never
 * a second one, and none of them can complete a mission over epoch state it did not see.
 *
 * The fingerprint is read in the statement's snapshot, so an epoch write still in flight when it
 * starts is invisible to it. Every epoch transition therefore touches its mission row in its own
 * statement (delivery-epochs.ts `applyEpochOpsSql`, `m_touch`; scope amendments write the row
 * already), and this UPDATE also requires the row version it read (`xmin`) to be the one it
 * updates: if an epoch writer holds the row, the UPDATE waits, Postgres re-checks the condition
 * against the row that writer committed, its xmin differs, and nothing is written. No lock is
 * taken beyond the row lock the UPDATE takes anyway. (Chosen over a separate version column: no
 * migration, one extra row write per epoch transition, which are rare.)
 *
 * A mission with no delivery records has no fingerprint (NULL), and the statement is the
 * active-to-completed CAS it always was, with one addition: if epochs were adopted after the
 * read, the NULL no longer matches and nothing is written.
 */
import { sql, type SQL } from 'drizzle-orm';
import { db } from '@buildd/core/db';

/** The epochs' fingerprint for mission `m` (a SQL expression for its id): NULL when it has none. */
export function missionEpochFingerprintSql(m: SQL): SQL {
  return sql`(SELECT string_agg(e.id::text || ':' || e.version::text || ':' || e.state, ',' ORDER BY e.epoch, e.id)
    FROM workflow_mission_epochs e WHERE e.mission_id = ${m})`;
}

/** Read the fingerprint now: take it before deciding, and hand it to the write. */
export async function readMissionEpochFingerprint(missionId: string): Promise<string | null> {
  const r = await db.execute(sql`SELECT ${missionEpochFingerprintSql(sql`${missionId}::uuid`)} AS fp`);
  const row = ((r as unknown as { rows?: Array<{ fp: string | null }> }).rows ?? [])[0];
  return row?.fp ?? null;
}

export function completeMissionSql(missionId: string, epochFingerprint: string | null, completedAt: Date): SQL {
  const at = completedAt.toISOString();
  // A reopen followed by a re-completion with no task finished since moves nothing: the mission
  // delivered nothing new, so "delivered" (GET /api/missions/recent) keeps its earlier date.
  return sql`UPDATE missions m SET status = 'completed',
  completed_at = CASE WHEN m.completed_at IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM tasks t WHERE t.mission_id = m.id AND t.status = 'completed' AND t.updated_at > m.completed_at
  ) THEN m.completed_at ELSE ${at}::timestamptz END,
  updated_at = ${at}::timestamptz
WHERE m.id = ${missionId}::uuid AND m.status = 'active'
  AND ${missionEpochFingerprintSql(sql`m.id`)} IS NOT DISTINCT FROM ${epochFingerprint}::text
  AND m.xmin::text = (SELECT xmin::text FROM missions WHERE id = ${missionId}::uuid)
RETURNING m.id, m.schedule_id`;
}

/** The claim: exactly one caller wins active → completed, on the epoch state it read. */
export async function claimMissionCompletion(
  missionId: string,
  epochFingerprint: string | null,
  completedAt: Date,
): Promise<{ id: string; scheduleId: string | null } | null> {
  const r = await db.execute(completeMissionSql(missionId, epochFingerprint, completedAt));
  const row = ((r as unknown as { rows?: Array<{ id: string; schedule_id: string | null }> }).rows ?? [])[0];
  return row ? { id: row.id, scheduleId: row.schedule_id } : null;
}
