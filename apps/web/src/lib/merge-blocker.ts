/**
 * The merge-blocker card's content: a PR that cannot merge because it
 * conflicts with its base. Pure, and derived only from server-built queue
 * fields, so the card renders from server truth.
 *
 * The card is read on a phone. Collapsed, it holds exactly three things: the
 * state, one concrete reason and one next step. Reviewer prose, attempt
 * history and the raw merge state go behind Details.
 */
import type { ActionQueueItem } from '@/lib/action-queue';

const GENERIC_CONFLICT_REASON = 'Conflicts with recent changes on the base branch';

/**
 * One concrete line for a conflict, read from a conflict retry's
 * `context.failureContext` (written by `buildConflictRetryTask`). Null when
 * nothing usable is recorded.
 */
export function describeConflictReason(failureContext: unknown): string | null {
  if (!failureContext || typeof failureContext !== 'object') return null;
  const fc = failureContext as { errorType?: unknown; summary?: unknown };
  const summary = typeof fc.summary === 'string' ? fc.summary : '';
  if (fc.errorType === 'migration_collision') {
    const index = /migration (\d+)_/i.exec(summary)?.[1];
    return index ? `Migration ${index} collides with another change` : 'A migration number collides with another change';
  }
  if (fc.errorType === 'semantic_conflict') return 'Edits the same code as a recent change on the base branch';
  if (fc.errorType === 'merge_conflict') return GENERIC_CONFLICT_REASON;
  return null;
}

export type MergeBlockerAction =
  /** An agent is on it: link to its task. */
  | { kind: 'view_task'; label: string; taskId: string }
  /** The conflict-retry machinery owns it; the attempt is being filed. */
  | { kind: 'fixing'; label: string }
  /** A person resolves it on the branch. */
  | { kind: 'fix_conflict'; label: string };

export interface MergeBlockerView {
  /** Whether a person has to act. False while automation owns the conflict. */
  needsYou: boolean;
  state: string;
  reason: string;
  action: MergeBlockerAction;
  /** Diagnostic lines for Details; never shown on the collapsed card. */
  details: string[];
}

/**
 * The collapsed merge-blocker card, derived only from server-built fields.
 * Null for anything that is not a conflict card (red CI keeps its own card).
 */
export function describeMergeBlocker(item: ActionQueueItem): MergeBlockerView | null {
  if (!item.mergeConflict) return null;
  const reason = item.conflictReason ?? GENERIC_CONFLICT_REASON;
  const baseDetails: string[] = [];
  if (item.conflictRetryIteration != null) baseDetails.push(`Automatic fix attempt ${item.conflictRetryIteration}`);
  if (item.escalationReason) baseDetails.push(item.escalationReason);
  if (item.recommendation) baseDetails.push(`Agent's suggestion: ${item.recommendation}`);
  baseDetails.push('GitHub reports the branch conflicts with its base, so the merge cannot go through as is.');

  // S37: the live fix exists but stalled. Say so, and offer to run THAT fix
  // (its task page carries Start / retry), never to file a second one.
  if (item.chip === 'RESOLVING' && item.remediationStalled && item.conflictRetryTaskId) {
    const shown = item.remediationStalled;
    const details = [reason, ...baseDetails].filter(l => l !== shown && !l.includes(shown));
    return {
      needsYou: false,
      state: 'Conflict fix stalled',
      reason: shown,
      action: { kind: 'view_task', label: 'Run fix', taskId: item.conflictRetryTaskId },
      details,
    };
  }
  if (item.chip === 'RESOLVING') {
    const details = [reason, ...baseDetails].filter(l => l !== reason && !l.includes(reason));
    return {
      needsYou: false,
      state: 'Resolving merge conflict',
      reason,
      action: item.conflictRetryTaskId
        ? { kind: 'view_task', label: 'View task', taskId: item.conflictRetryTaskId }
        : { kind: 'fixing', label: 'Fixing…' },
      details,
    };
  }
  const details = [reason, ...baseDetails].filter(l => l !== reason && !l.includes(reason));
  return {
    needsYou: true,
    state: item.deadZoneExhausted ? 'Merge blocked · automatic fixes ran out' : 'Merge blocked · automatic fixes are off',
    reason,
    action: { kind: 'fix_conflict', label: 'Fix conflict' },
    details,
  };
}
