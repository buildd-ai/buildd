/**
 * Migration-number collision → auto-dispatched renumber, instead of a human
 * escalation.
 *
 * `classifyPullRequestMigrations` (migration-safety.ts) already decided this
 * PR is the deterministic owner of a mechanical, non-destructive collision
 * (see `MigrationSafety.collision`). This module is the one place that turns
 * that verdict into an action: dispatch a same-branch renumber task through
 * the existing conflict-retry machinery (dedup, `maxConflictIterations` cap,
 * RESOLVING chip all reused as-is), and record a PR activity entry that says
 * it is resolving — never `human_review_required`, and no human alert.
 *
 * Callers only reach here when `migrationSafety.collision` is set. Every
 * other outcome (disabled, exhausted, dependency-bot branch, not found) falls
 * through unhandled so the caller's normal escalation path runs — retries
 * exhausted or a feature flag off are exactly when a human should still see
 * this.
 */

import { dispatchConflictRetry } from '@/lib/conflict-retry';
import { appendPrActivity } from '@/lib/pr-activity-comment';
import type { MigrationCollision } from '@/lib/migration-safety';

export interface MigrationCollisionRetryParams {
  collision: MigrationCollision;
  workerId: string;
  taskId: string;
  prNumber: number;
  headSha: string;
  repoFullName: string;
  workspaceId: string;
  /** Needed to post the PR activity entry; omit only when unavailable — the entry is best-effort. */
  installationId?: number | null;
}

export interface MigrationCollisionRetryResult {
  /**
   * True when this call fully handled the PR: a renumber task was dispatched
   * (or one is already in flight for this PR). The caller must skip its own
   * escalation and reviewer-dispatch logic entirely.
   *
   * False means the caller should proceed exactly as if this module didn't
   * exist — normal (human-escalating) handling of `migrationSafety`.
   */
  handled: boolean;
  /** The renumber task now carrying it (the one just filed, or the one already in flight). */
  taskId?: string;
  /**
   * Set when nothing was filed because an earlier open PR owns the next
   * migration slot (the migration lane). The caller must treat the PR as
   * handled-and-waiting, not escalate it to a person.
   */
  queuedBehind?: number;
}

export async function tryDispatchMigrationCollisionRetry(
  params: MigrationCollisionRetryParams,
): Promise<MigrationCollisionRetryResult> {
  const { collision, workerId, taskId, prNumber, headSha, repoFullName, workspaceId, installationId } = params;

  // Migration lane: renumbering past a PR that has not landed only dirties both
  // again when it does. Wait for the predecessor, then renumber once against the base.
  const queuedBehind = collision.queuedBehind ?? (collision.against !== 'base' ? collision.otherPrNumber ?? undefined : undefined);
  if (queuedBehind != null) return { handled: true, queuedBehind };

  const result = await dispatchConflictRetry({
    workerId,
    taskId,
    prNumber,
    headSha,
    repoFullName,
    workspaceId,
    migrationCollision: collision,
  });

  if (!result.dispatched && !result.inFlightTaskId) {
    // disabled / exhausted / dependencyBot / superseded / not found — let the
    // caller's normal escalation path decide (exhausted is exactly the "cap
    // reached, hand to a human" case).
    return { handled: false };
  }

  if (installationId) {
    await appendPrActivity({
      installationId,
      repoFullName,
      prNumber,
      workspaceId,
      entry: {
        kind: 'migration_collision_fixing',
        detail: collision.otherPrNumber == null ? `${collision.otherFile} on the base` : `PR #${collision.otherPrNumber}`,
      },
    }).catch(() => {
      // Best-effort — the dispatched task is the real state; the comment is UX only.
    });
  }

  return { handled: true, taskId: result.taskId ?? result.inFlightTaskId };
}
