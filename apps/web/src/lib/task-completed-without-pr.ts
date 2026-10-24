/**
 * A task that finished saying it needs no PR opens none.
 *
 * The pr_required gate (PATCH /api/workers/[id]) accepts a completion without a
 * PR on recorded evidence: the work already shipped in a merged PR
 * (`alreadyShippedIn`), a mission-branch refresh already on the branch
 * (`refreshAlreadyLanded`), or edits explicitly discarded (`discardedEdits`).
 * A PR opened from that task's branch afterwards contradicts the outcome it
 * recorded: a refresh task that finished "no PR needed" had a PR opened from
 * its branch under a minute later, which then sat orphaned, was reopened and
 * merged stale (friction 0e0a8c78). Leaf module, no I/O.
 */

/** Why this task's completed outcome says it opens no PR, or null. */
export function completedWithoutPr(task: { status?: string | null; result?: unknown } | null | undefined): string | null {
  if (!task || task.status !== 'completed') return null;
  const result = (task.result ?? {}) as Record<string, unknown>;
  if (result.alreadyShippedIn) return 'its work had already shipped in a merged PR';
  if (result.refreshAlreadyLanded) return 'the mission branch already contained the refresh';
  if (typeof result.discardedEdits === 'string' && result.discardedEdits) return 'its edits were discarded';
  return null;
}
