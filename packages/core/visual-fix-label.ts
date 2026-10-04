/**
 * The one fix-status label every surface renders (docs/design/visual-qa-human-review.md):
 * the UI's `FixStatus` (apps/web/src/components/visual-review/VisualShotCompare.tsx) and
 * the chat/MCP text line (`visual-review-text.ts`) both call this instead of reading
 * `fix.status` on their own.
 *
 * The rule: the label reports what landed, not the task's own status. A `completed`
 * fix task with no merged PR never reads as done, and a PR merged only into a
 * mission's own integration branch (not trunk) never reads the same as a PR merged
 * to trunk — neither has shipped the fix where the audited page actually runs.
 */
import { isTerminalTaskStatus, type VisualReviewFixTask } from '@buildd/shared';

export type FixLabelTone = 'success' | 'warning' | 'muted';

export interface FixLabel {
  text: string;
  tone: FixLabelTone;
}

/**
 * `finding` continues a prior round's issue under the auditor's own convention
 * (`default-roles.ts`: "start each finding with 'Resolved:' or 'Still there:'").
 */
export function findingIsStillThere(finding: string | null | undefined): boolean {
  return typeof finding === 'string' && /^\s*still there\b/i.test(finding);
}

/**
 * `stillPresent`: the shot this label sits under is itself a "Still there" issue
 * finding — the audit re-checked and the problem is still visible. That evidence
 * outranks the fix task's own PR/merge state: a finished fix next to proof the
 * defect persists is never a done/success label.
 */
export function fixStatusLabel(fix: VisualReviewFixTask, opts: { stillPresent?: boolean } = {}): FixLabel {
  if (opts.stillPresent && isTerminalTaskStatus(fix.status)) {
    return { text: 'Fix finished, problem still present', tone: 'warning' };
  }
  if (fix.mergedAt) {
    return fix.mergedInto === 'mission_branch'
      ? { text: 'PR merged to mission branch only', tone: 'warning' }
      : { text: 'PR merged', tone: 'success' };
  }
  // Checked before `prUrl`: a terminal failure outranks a PR reference left
  // over from before the task failed or was cancelled.
  if (fix.status === 'cancelled') {
    return { text: 'Fix cancelled', tone: 'muted' };
  }
  if (fix.status === 'failed') {
    return { text: 'Task failed, no PR merged', tone: 'warning' };
  }
  if (fix.prUrl) {
    return { text: 'PR open, not merged', tone: 'warning' };
  }
  if (fix.status === 'completed') {
    return { text: 'Task finished, no PR merged', tone: 'warning' };
  }
  return { text: fix.status.replace(/_/g, ' '), tone: 'warning' };
}
