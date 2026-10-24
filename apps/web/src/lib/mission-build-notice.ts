// @ui-copy: strings here render in the app; copy:check and the em-dash test scan them.
/**
 * What the Build stage's notice may still say (Navigation d25d923d R-14,
 * R-16 to R-20). A failure a person must fix is its own row at the head of
 * the task list, a goal-criteria escalation is a decision card, and
 * verification and the visual audit belong to Verify. So the Build stage
 * draws no situation block for those, and the quiet list under any other
 * situation loses the same facts. Pure.
 */
import type { MissionSituation, WaitingOnDescriptor } from './mission-state-view';

/** True for a fact that is a row, a decision card or a Verify matter, never a Build banner. */
function isElsewhere(f: WaitingOnDescriptor): boolean {
  switch (f.kind) {
    case 'task_failed':
    case 'criterion_failing':
    case 'criterion_unverified':
      return true;
    case 'human_decision':
      // A worker's question is its own decision card; the rest (the goal
      // escalation, the missing visual audit) are the criteria card and Verify.
      return !f.question && !f.visualReview;
    default:
      return false;
  }
}

/** The situation as the Build stage may draw it, or null when nothing of it belongs there. */
export function buildStageSituation(situation: MissionSituation): MissionSituation | null {
  if (situation.focus && isElsewhere(situation.focus)) return null;
  const also = situation.alsoOutstanding.filter(f => !isElsewhere(f));
  return also.length === situation.alsoOutstanding.length ? situation : { ...situation, alsoOutstanding: also };
}
