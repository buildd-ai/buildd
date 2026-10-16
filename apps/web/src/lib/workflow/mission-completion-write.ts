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
  return sql`UPDATE missions m SET status = 'completed', completed_at = ${at}::timestamptz, updated_at = ${at}::timestamptz
WHERE m.id = ${missionId}::uuid AND m.status = 'active'
  AND ${missionEpochFingerprintSql(sql`m.id`)} IS NOT DISTINCT FROM ${epochFingerprint}::text
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
