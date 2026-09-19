/**
 * Mission PHASE — the named stretch of a plan a task belongs to.
 *
 * Deliberately a module of its own rather than part of `approve-plan.ts`: the
 * attempt-inheritance read below is called from the reviewer, CI-retry and
 * conflict-retry paths, none of which should drag the whole plan-approval
 * dependency graph (branch-name prediction, coordination-intent classification,
 * spec-doc-fix) into a webhook handler to copy two integers.
 *
 * See docs/specs/mission-legibility.md §1. Nothing here reads a title, a
 * description, a `dependsOn` layer, or the wall clock.
 */

import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';

/** The two phase columns a task carries, or both-null when it has no phase. */
export interface MissionPhase {
  missionPhaseIndex: number | null;
  missionPhaseLabel: string | null;
}

const NO_PHASE: MissionPhase = { missionPhaseIndex: null, missionPhaseLabel: null };

/**
 * Assign a mission phase to every step of a plan, in plan-array order.
 * Pure — see docs/specs/mission-legibility.md Rules P1-4 and P1-9.
 *
 * `phase` behaves like a heading, not a tag: the first labelled step opens
 * phase 1, a step whose label differs from the open one opens the next index,
 * and an unlabelled step INHERITS whatever heading is currently open. A step
 * that appears before any label belongs to no phase.
 *
 * When no step in the plan carries a label at all, the plan has no phases of
 * its own and every step falls back to `inherited` — the phase of the planning
 * task itself, when it had one. That is what keeps a re-plan raised inside a
 * phase inside that phase, and it is the ONLY inheritance: nothing here reads a
 * title, a `dependsOn` layer, or the wall clock.
 */
export function computePlanPhases(
  plan: Array<{ phase?: string }>,
  inherited?: MissionPhase | null,
): MissionPhase[] {
  const anyLabelled = plan.some((step) => (step.phase ?? '').trim().length > 0);
  if (!anyLabelled) {
    const fallback = inherited?.missionPhaseIndex != null && inherited.missionPhaseLabel != null
      ? { missionPhaseIndex: inherited.missionPhaseIndex, missionPhaseLabel: inherited.missionPhaseLabel }
      : NO_PHASE;
    return plan.map(() => fallback);
  }

  const out: MissionPhase[] = [];
  let openIndex = 0;
  let openLabel: string | null = null;

  for (const step of plan) {
    const label = (step.phase ?? '').trim();
    if (label) {
      if (label !== openLabel) {
        openIndex += 1;
        openLabel = label;
      }
    }
    out.push(openLabel === null ? NO_PHASE : { missionPhaseIndex: openIndex, missionPhaseLabel: openLabel });
  }

  return out;
}

/**
 * The phase an ATTEMPT inherits from the task it is an attempt at (Rule P1-7).
 *
 * Read here rather than threaded through every caller: a reviewer task, a CI
 * retry and a conflict retry are created by three different modules from three
 * different column selections, and a copy that one of them forgets is a row the
 * rail cannot place under the parent it collapses beneath.
 *
 * Returns both-null for anything it cannot read, so a caller can always spread
 * the result into an insert.
 */
export async function inheritPhaseFromParent(parentTaskId: string | null | undefined): Promise<MissionPhase> {
  if (!parentTaskId) return NO_PHASE;
  const parent = await db.query.tasks.findFirst({
    where: eq(tasks.id, parentTaskId),
    columns: { missionPhaseIndex: true, missionPhaseLabel: true },
  });
  if (parent?.missionPhaseIndex == null || parent.missionPhaseLabel == null) return NO_PHASE;
  return { missionPhaseIndex: parent.missionPhaseIndex, missionPhaseLabel: parent.missionPhaseLabel };
}

