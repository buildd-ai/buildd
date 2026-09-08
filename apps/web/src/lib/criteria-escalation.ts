import { db } from '@buildd/core/db';
import { missions, missionNotes, taskSchedules } from '@buildd/core/db/schema';
import { and, eq } from 'drizzle-orm';
import { postMissionFeedEvent, type FeedActor } from '@/lib/mission-feed';

/**
 * The single writer that un-escalates a mission's goal-criteria gate.
 *
 * `criteria-rearm.ts`'s division of authority survives unchanged: this module
 * never files tasks. It only reverses the three things escalation did — null
 * the flag, close the note the owner was asked to act on, and re-enable the
 * heartbeat schedule if one still exists — and records which exit was taken.
 *
 * `applyCriteriaRearm`'s 'rearm' branch is a caller, not a special case: a
 * changed verdict is itself an exit (`'verdict_changed'`), so it clears
 * through here rather than nulling the column inline.
 */
export type CriteriaEscalationExitReason =
  | 'verdict_changed'
  | 'mission_completed'
  | 'criteria_edited'
  | 'work_filed'
  | 'waived';

const EXIT_LABELS: Record<CriteriaEscalationExitReason, string> = {
  verdict_changed: 'the goal-criteria verdict changed',
  mission_completed: 'the mission was completed',
  criteria_edited: 'the goal criteria were edited',
  work_filed: 'work was filed against the blocking criteria',
  waived: 'the escalation was waived',
};

export interface CriteriaEscalationResolution {
  /** False when the mission was not escalated — a no-op, not an error. */
  cleared: boolean;
}

export async function resolveCriteriaEscalation(
  missionId: string,
  reason: CriteriaEscalationExitReason,
  actor: FeedActor,
): Promise<CriteriaEscalationResolution> {
  const mission = await db.query.missions.findFirst({
    where: eq(missions.id, missionId),
    columns: { id: true, criteriaEscalatedAt: true, scheduleId: true },
  });

  // Nothing to clear. A mission that never escalated, or was already cleared
  // by a concurrent caller, is a no-op — not an error and not a feed note.
  if (!mission || !mission.criteriaEscalatedAt) {
    return { cleared: false };
  }

  const now = new Date();

  await db.update(missions)
    .set({ criteriaEscalatedAt: null, updatedAt: now })
    .where(eq(missions.id, missionId));

  // The owner (or the platform, on their behalf) acted — 'answered', not
  // 'dismissed'. A dismissed note reads as "nobody looked at this."
  await db.update(missionNotes)
    .set({ status: 'answered' })
    .where(and(
      eq(missionNotes.missionId, missionId),
      eq(missionNotes.type, 'question'),
      eq(missionNotes.status, 'open'),
    ));

  let rearmedSchedule = false;
  if (mission.scheduleId) {
    const schedule = await db.query.taskSchedules.findFirst({
      where: eq(taskSchedules.id, mission.scheduleId),
      columns: { id: true },
    });
    // The schedule row may already be gone — e.g. a completed/archived mission
    // has its schedule deleted outright by PATCH /api/missions/[id]. Nothing to
    // re-enable in that case; the mission is closed anyway.
    if (schedule) {
      await db.update(taskSchedules)
        .set({ enabled: true, lastDeferralReason: null, updatedAt: now })
        .where(eq(taskSchedules.id, mission.scheduleId));
      rearmedSchedule = true;
    }
  }

  await postMissionFeedEvent({
    missionId,
    type: 'update',
    title: 'Goal-criteria escalation cleared',
    body: `Resolved because ${EXIT_LABELS[reason]}.${rearmedSchedule ? ' Heartbeat re-enabled.' : ''}`,
    actor,
  }).catch(e => console.error(`[criteria-escalation] feed note failed for ${missionId}:`, e));

  return { cleared: true };
}
