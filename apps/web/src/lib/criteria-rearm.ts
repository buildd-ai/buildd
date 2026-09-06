import { db } from '@buildd/core/db';
import { missions, tasks, missionNotes, taskSchedules } from '@buildd/core/db/schema';
import { and, eq, gt, sql } from 'drizzle-orm';
import type { GoalCriteriaState } from '@buildd/shared';

/**
 * The consumer of a non-pass goal-criteria verdict.
 *
 * A verdict that blocks completion and is read by nothing is a deadlock: the
 * mission cannot close, and it cannot file the work that would let it close.
 * Mission 04449d1d ran ~40 heartbeat cycles in that state on 2026-08-29/30 and
 * had to be finished by hand. Three more (M1/M2/mission-detail) were sitting in
 * it on 2026-08-31, each re-evaluating the same failing verdict every 30 minutes
 * with no organizer cycle in between.
 *
 * Division of authority, deliberately:
 * - the EVALUATOR produces verdicts and never files work. Prose criteria are
 *   LLM-graded and the least reliable signal in the system; giving the grader
 *   write access to the backlog turns a hallucinated verdict into hallucinated
 *   scope.
 * - this module decides only WHETHER to wake the organizer, from verdict shape
 *   and cycle history. It reads no criterion text and files no tasks.
 * - the ORGANIZER decides whether a named gap deserves a task, and files it.
 *
 * The loop guard is the other half. Re-arming on every unchanged verdict is the
 * same infinite loop with an LLM call added, so an unchanged verdict that the
 * organizer could not act on escalates to the mission owner. A criteria failure
 * nobody can move is a decision, not a retry.
 */

/** Consecutive unchanged-verdict cycles allowed before the owner is asked. */
export const MAX_REARM_CYCLES = 3;

export type CriteriaRearmAction = 'rearm' | 'escalate' | 'wait';

export interface CriteriaRearmDecision {
  action: CriteriaRearmAction;
  /** One line, safe to show a human. */
  reason: string;
  /** Value to persist as `criteriaRearmCycles`. */
  nextCycles: number;
}

/**
 * Verdict shape, independent of when it was produced or how it was worded.
 *
 * Keyed on each criterion's own fingerprint where one exists — array index alone
 * is not identity, since deleting a criterion renumbers the rest. Evidence text
 * is excluded on purpose: an LLM re-grading the same failure phrases it
 * differently every run, and treating rewording as new information would defeat
 * the loop guard entirely.
 */
export function criteriaFingerprint(state: GoalCriteriaState | null | undefined): string {
  if (!state) return 'none';
  const parts = (state.criteria ?? [])
    .map(c => `${c.fingerprint ?? `i${c.index}`}=${c.verdict}`)
    .sort();
  return `${state.overall}|${parts.join(',')}`;
}

/** The non-passing criteria, rendered for injection into an organizer prompt. */
export function formatVerdictLines(state: GoalCriteriaState | null | undefined): string {
  if (!state) return '';
  return (state.criteria ?? [])
    .filter(c => c.verdict !== 'pass')
    .map(c => `- [${c.verdict}] ${c.label ?? c.type}${c.evidence ? ` — ${c.evidence}` : ''}`)
    .join('\n');
}

/** Which remedy an identical-fingerprint failure supports. */
export type CriteriaFailureReading = 'criterion_unmeasurable' | 'work_unowned' | 'mixed';

/**
 * Names which of the escalation's two remedies the failure pattern actually
 * supports, from the *type* of the non-passing criteria alone.
 *
 * A `description` (prose) criterion is graded by an LLM: an identical
 * fingerprint across the full retry budget means re-grading never resolved
 * it, which is exactly what "unmeasurable as written" looks like. A mechanical
 * criterion (`command`, `no_open_tasks`, `artifact_exists`, `all_prs_merged`)
 * has no such ambiguity — its verdict is a fact about the repo or the task
 * table, so a fingerprint-stable mechanical failure means the underlying
 * condition genuinely never changed, i.e. the work has no owner. A mix of
 * both gets no steer — the owner has to look either way.
 */
export function inferCriteriaFailureReading(
  state: GoalCriteriaState | null | undefined,
): CriteriaFailureReading | null {
  const nonPassing = (state?.criteria ?? []).filter(c => c.verdict !== 'pass');
  if (nonPassing.length === 0) return null;
  if (nonPassing.every(c => c.type === 'description')) return 'criterion_unmeasurable';
  if (nonPassing.every(c => c.type !== 'description')) return 'work_unowned';
  return 'mixed';
}

/**
 * Pure re-arm decision. No DB, no clock — the caller supplies the history.
 *
 * `tasksCreatedSinceRearm` is what separates "the organizer looked and did
 * nothing" from "the organizer filed work that has not landed yet". Only the
 * former is a deadlock; the latter just needs time, and re-arming into it would
 * duplicate the work already in flight.
 */
export function decideCriteriaRearm(input: {
  fingerprint: string;
  previousFingerprint: string | null;
  cycles: number;
  tasksCreatedSinceRearm: number;
  alreadyEscalated: boolean;
}): CriteriaRearmDecision {
  const changed = input.previousFingerprint !== input.fingerprint;

  // New verdict shape — genuinely new information, whatever happened before.
  // This is also the only way out of an escalation: the owner changes a
  // criterion, or a merge flips one, and the mission resumes on its own.
  if (changed) {
    return {
      action: 'rearm',
      reason: input.previousFingerprint
        ? 'Goal-criteria verdict changed since the last organizer cycle'
        : 'Goal-criteria verdict is non-passing and no organizer cycle has consumed it',
      nextCycles: 1,
    };
  }

  // Unchanged and already handed to a human: say nothing further. The owner owes
  // a decision, and re-noting it every cadence is how a feed stops being read.
  if (input.alreadyEscalated) {
    return { action: 'wait', reason: 'Awaiting owner decision on an unchanged failing verdict', nextCycles: input.cycles };
  }

  if (input.cycles >= MAX_REARM_CYCLES) {
    return {
      action: 'escalate',
      reason: `Goal criteria unchanged across ${input.cycles} organizer cycle(s) — the mission cannot move itself`,
      nextCycles: input.cycles,
    };
  }

  // Work is in flight against this verdict. Let it land; the verdict will be
  // re-evaluated once those tasks go terminal.
  if (input.tasksCreatedSinceRearm > 0) {
    return {
      action: 'wait',
      reason: `${input.tasksCreatedSinceRearm} task(s) filed against this verdict are still open`,
      nextCycles: input.cycles + 1,
    };
  }

  return {
    action: 'escalate',
    reason: 'The organizer already saw this exact verdict and filed no work against it',
    nextCycles: input.cycles,
  };
}

export interface CriteriaRearmOutcome extends CriteriaRearmDecision {
  /** Non-passing criteria, ready to inject into the organizer's description. */
  verdictLines: string;
  fingerprint: string;
}

/**
 * Apply the re-arm decision for one mission: read its history, decide, persist,
 * and on `escalate` post the owner decision and stand the heartbeat down.
 *
 * Returns the decision so the caller can dispatch the organizer cycle itself —
 * this module deliberately does not create tasks, so that the cycle goes through
 * the one path that already builds full mission context.
 */
export async function applyCriteriaRearm(input: {
  missionId: string;
  scheduleId: string | null;
  /** Why completion was refused, for the escalation note. */
  blockReason: string;
}): Promise<CriteriaRearmOutcome> {
  // The verdict is read HERE, not passed in: the caller's mission row was loaded
  // before the completion check ran, and that check is what produces a fresh
  // verdict. Re-arming on the pre-check snapshot would fingerprint the previous
  // round and hand the organizer stale criterion text.
  const mission = await db.query.missions.findFirst({
    where: eq(missions.id, input.missionId),
    columns: {
      id: true,
      title: true,
      goalCriteriaState: true,
      criteriaRearmFingerprint: true,
      criteriaRearmCycles: true,
      criteriaRearmedAt: true,
      criteriaEscalatedAt: true,
    },
  });

  if (!mission) {
    return { action: 'wait', reason: 'Mission not found', nextCycles: 0, verdictLines: '', fingerprint: 'none' };
  }

  const state = (mission.goalCriteriaState ?? null) as GoalCriteriaState | null;
  const fingerprint = criteriaFingerprint(state);
  const verdictLines = formatVerdictLines(state);

  // Count only work filed AFTER the last re-arm — tasks the organizer created in
  // response to this verdict, not the mission's whole history.
  let tasksCreatedSinceRearm = 0;
  if (mission.criteriaRearmedAt) {
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(tasks)
      .where(and(
        eq(tasks.missionId, input.missionId),
        gt(tasks.createdAt, mission.criteriaRearmedAt),
        eq(tasks.taskClass, 'work'),
      ));
    tasksCreatedSinceRearm = row?.count ?? 0;
  }

  const decision = decideCriteriaRearm({
    fingerprint,
    previousFingerprint: mission.criteriaRearmFingerprint,
    cycles: mission.criteriaRearmCycles,
    tasksCreatedSinceRearm,
    alreadyEscalated: mission.criteriaEscalatedAt != null,
  });

  const now = new Date();

  if (decision.action === 'rearm') {
    await db.update(missions).set({
      criteriaRearmFingerprint: fingerprint,
      criteriaRearmCycles: decision.nextCycles,
      criteriaRearmedAt: now,
      // A changed verdict clears a prior escalation: the thing the owner was
      // asked about has moved, so the mission may drive itself again.
      criteriaEscalatedAt: null,
      updatedAt: now,
    }).where(eq(missions.id, input.missionId));
  } else if (decision.action === 'escalate') {
    await db.update(missions).set({
      criteriaRearmFingerprint: fingerprint,
      criteriaRearmCycles: decision.nextCycles,
      criteriaEscalatedAt: now,
      updatedAt: now,
    }).where(eq(missions.id, input.missionId));

    const reading = inferCriteriaFailureReading(state);
    const readingLine = reading === 'criterion_unmeasurable'
      ? 'Every blocking criterion is prose-graded and has failed identically across the retry budget — most likely the criterion is unmeasurable as written.\n\n'
      : reading === 'work_unowned'
        ? 'Every blocking criterion is machine-checked and has failed identically across the retry budget — most likely the underlying work has no owner.\n\n'
        : '';

    await db.insert(missionNotes).values({
      missionId: input.missionId,
      authorType: 'system',
      type: 'question',
      title: 'Goal criteria blocked — owner decision needed',
      body:
        `${decision.reason}.\n\n` +
        `Completion refusal: ${input.blockReason}\n\n` +
        `Blocking criteria:\n${verdictLines || '- (no per-criterion detail recorded)'}\n\n` +
        readingLine +
        `The heartbeat has been stood down so this stops re-evaluating on a cadence. ` +
        `Either the criterion is wrong or unmeasurable as written (fix it via ` +
        `\`manage_missions action=update goalCriteria=...\`), or the work it names has no owner ` +
        `(file it as a task). Changing any verdict re-arms the organizer automatically.`,
      status: 'open',
    } as any).catch(e => console.error(`[criteria-rearm] escalation note failed for ${input.missionId}:`, e));

    if (input.scheduleId) {
      await db.update(taskSchedules)
        .set({ enabled: false, lastDeferralReason: 'criteria_escalated', updatedAt: now })
        .where(eq(taskSchedules.id, input.scheduleId));
    }
  } else if (decision.nextCycles !== mission.criteriaRearmCycles) {
    await db.update(missions)
      .set({ criteriaRearmCycles: decision.nextCycles, updatedAt: now })
      .where(eq(missions.id, input.missionId));
  }

  console.log(
    `[criteria-rearm] ${input.missionId}: ${decision.action} — ${decision.reason}` +
    ` (cycles=${mission.criteriaRearmCycles}→${decision.nextCycles}, filedSinceRearm=${tasksCreatedSinceRearm})`
  );

  return { ...decision, verdictLines, fingerprint };
}
