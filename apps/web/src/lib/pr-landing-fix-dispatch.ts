/**
 * The fix landing names when no door wires its own (task a90fc99b).
 *
 * `landPr` answers `needs_fix` for red CI and a migration-number collision,
 * but no door ever passed a `dispatchFix`, so the answer was only words: the
 * PR waited (or paged) with nothing filed. These are not a second decision
 * path. Each hands the PR to the one that already decides that fix:
 *
 *  - `ci_fix` → `retryCiFailureForPr`, the same entry the check-suite
 *    webhook and the red-PR sweep use (kernel ledger for a kernel-owned PR,
 *    the legacy budget otherwise, single-flight per PR + head);
 *  - `renumber_migration` → `tryDispatchMigrationCollisionRetry`, the same
 *    renumber the review path files (conflict-retry dedupe and cap).
 *
 * `re_review` is not here: landPr's own re-review dispatcher already runs it.
 * Every dependency is injectable so landing's tests stay free of the db.
 */
import type { FixDispatchInput } from '@/lib/pr-landing';
import type { MigrationCollision } from '@/lib/migration-safety';
import type { CiRetryOutcome, CiFailureInput } from '@/lib/ci-failure-retry';
import type { MigrationCollisionRetryParams, MigrationCollisionRetryResult } from '@/lib/migration-collision-retry';

export interface LandingFixDispatchDeps {
  retryCi?: (input: CiFailureInput) => Promise<CiRetryOutcome>;
  renumber?: (params: MigrationCollisionRetryParams) => Promise<MigrationCollisionRetryResult>;
}

export type LandingFixResult = { taskId?: string; skipped?: string } | null;

/**
 * The collision migration-safety.ts describes, read back from its reason:
 * `migration number collision: <file> conflicts with open PR #<n> migration <otherFile>`.
 * A slot taken on the base reads `#null` and comes back with `against: 'base'`. Null for any other wording.
 */
export function collisionFromReason(reason: string): MigrationCollision | null {
  const m = /^migration number collision:\s*(\S+)\s+conflicts with open PR #(\d+|null) migration\s+(\S+)/.exec(reason);
  if (!m) return null;
  // A slot taken on the base renders its PR number as "null" (migration-safety.ts).
  if (m[2] === 'null') return { file: m[1]!, otherPrNumber: null, otherFile: m[3]!, against: 'base' };
  return { file: m[1]!, otherPrNumber: Number(m[2]), otherFile: m[3]! };
}

export async function dispatchLandingFix(input: FixDispatchInput, deps: LandingFixDispatchDeps = {}): Promise<LandingFixResult> {
  if (input.kind === 'ci_fix') {
    if (!input.headSha) return { skipped: 'no_head' };
    const retryCi = deps.retryCi ?? (await import('@/lib/ci-failure-retry')).retryCiFailureForPr;
    const out = await retryCi({
      repoFullName: input.repoFullName, prNumber: input.prNumber, headSha: input.headSha,
      installationId: input.installationId, surface: 'landing',
    });
    if (out.kind === 'dispatched' || out.kind === 'diagnose_dispatched') return { taskId: out.taskId };
    if (out.kind === 'skipped') return out.inFlightTaskId ? { taskId: out.inFlightTaskId } : { skipped: out.reason };
    return { skipped: 'not_ours' };
  }
  if (input.kind === 'renumber_migration') {
    const collision = collisionFromReason(input.reason);
    if (!collision) return { skipped: 'collision_unreadable' };
    if (!input.owner.taskId || !input.owner.workerId || !input.headSha) return { skipped: 'no_owner' };
    const renumber = deps.renumber ?? (await import('@/lib/migration-collision-retry')).tryDispatchMigrationCollisionRetry;
    const res = await renumber({
      collision, workerId: input.owner.workerId, taskId: input.owner.taskId, prNumber: input.prNumber,
      headSha: input.headSha, repoFullName: input.repoFullName, workspaceId: input.workspaceId, installationId: input.installationId,
    });
    return res.handled ? {} : { skipped: 'renumber_not_filed' };
  }
  return null;
}
