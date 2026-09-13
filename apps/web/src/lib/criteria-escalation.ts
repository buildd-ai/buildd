import { db } from '@buildd/core/db';
import { missions, missionNotes, taskSchedules } from '@buildd/core/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { postMissionFeedEvent, type FeedActor } from '@/lib/mission-feed';
import type { MissionNoteType } from '@buildd/shared';

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
 *
 * `escalateCriteriaFailure`, below, is the other direction and the other half
 * of the same ownership claim: it is the ONLY writer that stamps
 * `criteriaEscalatedAt` and files the owner-facing note. Before it existed,
 * the heartbeat's `criteria-rearm.ts` escalate branch and the explicit
 * mission-completion override in `PATCH /api/missions/[id]` each decided
 * "has this mission escalated" independently — the heartbeat path stamped the
 * column and filed a note, the completion override only filed a warning note
 * and never touched the column. A mission whose criteria were failing when a
 * human forced it to `completed` never went through the heartbeat's N-cycle
 * budget, so it never escalated by that path either — `criteriaEscalatedAt`
 * stayed null forever even though nobody was ever told. Collapsing both
 * writers onto one function is what makes `criteriaEscalatedAt IS NOT NULL`
 * mean what it says: this mission's owner was notified of a failing verdict.
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

export interface EscalateCriteriaFailureInput {
  missionId: string;
  /** `criteriaFingerprint(state)` (from `criteria-rearm.ts`) — the dedup key. */
  fingerprint: string;
  note: {
    type: MissionNoteType;
    title: string;
    body: string;
    /** 'open' when the owner still owes a decision; 'answered' when the
     *  event that produced this note (e.g. an explicit override) already IS
     *  the decision. */
    status: 'open' | 'answered';
  };
  /** Heartbeat schedule to stand down, if one is still live for this mission. */
  scheduleId?: string | null;
  actor?: FeedActor;
}

export interface EscalateCriteriaFailureResult {
  /** False when this exact verdict was already escalated — no duplicate note. */
  escalated: boolean;
}

/**
 * The single writer that escalates a mission's goal-criteria gate: stamps
 * `criteriaEscalatedAt`, files the owner-facing note, and (optionally) stands
 * the heartbeat down — all three from one place, so the column and the
 * notification can never drift apart the way they did before this existed
 * (see the module docstring above). `resolveCriteriaEscalation` is the
 * reverse of this.
 *
 * Dedup is atomic (one `UPDATE ... WHERE` claim, not a read-then-write) and
 * keyed on `fingerprint`, not on `criteriaEscalatedAt` alone: a mission that
 * is already escalated and whose verdict then gets WORSE (a new criterion
 * starts failing) re-notifies once for the new shape; a mission re-evaluated
 * with the identical verdict does not get a second note.
 */
export async function escalateCriteriaFailure(
  input: EscalateCriteriaFailureInput,
): Promise<EscalateCriteriaFailureResult> {
  const now = new Date();

  const [claimed] = await db
    .update(missions)
    .set({ criteriaEscalatedAt: now, criteriaRearmFingerprint: input.fingerprint, updatedAt: now })
    .where(
      and(
        eq(missions.id, input.missionId),
        sql`(${missions.criteriaEscalatedAt} IS NULL OR ${missions.criteriaRearmFingerprint} IS DISTINCT FROM ${input.fingerprint})`,
      ),
    )
    .returning({ id: missions.id });

  if (!claimed) {
    return { escalated: false };
  }

  await db.insert(missionNotes).values({
    missionId: input.missionId,
    authorType: input.actor?.kind ?? 'system',
    actorLabel: input.actor?.label ?? null,
    type: input.note.type,
    title: input.note.title,
    body: input.note.body,
    status: input.note.status,
  } as any).catch(e => console.error(`[criteria-escalation] escalation note failed for ${input.missionId}:`, e));

  if (input.scheduleId) {
    await db.update(taskSchedules)
      .set({ enabled: false, lastDeferralReason: 'criteria_escalated', updatedAt: now })
      .where(eq(taskSchedules.id, input.scheduleId));
  }

  return { escalated: true };
}
