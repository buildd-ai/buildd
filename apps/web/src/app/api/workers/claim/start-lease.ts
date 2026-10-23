/**
 * The lane paths a claim leases up front. A task that starts alongside an open
 * PR on non-lane files (./overlap-policy) takes its own lane paths through the
 * exclusive primitive, all-or-nothing, before the atomic claim; a claim that
 * then loses the race gives back exactly the rows it inserted.
 */
import { TASK_STATUSES, isTerminalTaskStatus } from '@buildd/shared';
import { REPO_WIDE_SENTINEL } from '@buildd/core/path-overlap';
import type { AcquireInput, AcquireResult, LeaseRowsRelease, ReleaseResult } from '@buildd/core/path-claim';
import type { PathReleaseReason } from '@/lib/path-claim-release';

export interface StartLeaseDeps {
  acquire?: (input: AcquireInput) => Promise<AcquireResult>;
  /** Give back exactly the rows one acquisition inserted. Default `releaseLeaseRows`. */
  releaseRows?: (input: { workspaceId: string; taskId: string; leaseIds: string[]; keepStatuses: readonly string[] }) => Promise<LeaseRowsRelease>;
  /** Why the leases dropped, for the waiters. Default `resolveReleaseReasonForTask`. */
  releaseReason?: (taskId: string) => Promise<PathReleaseReason>;
  /** Waiter delivery. Default `deliverPathReleased`. */
  deliver?: (taskId: string, result: ReleaseResult, reason: PathReleaseReason) => Promise<void>;
}

export interface StartLeaseAcquisition {
  /** All the paths are now this task's: the claim may proceed. */
  ok: boolean;
  /** Paths this acquisition newly leased. */
  inserted: string[];
  /** The lease rows it inserted: exactly what a lost claim race gives back. */
  insertedIds: string[];
}

const defaultAcquire = async (input: AcquireInput) => (await import('@buildd/core/path-claim')).acquirePathClaims(input);

/**
 * Acquire the paths through the exclusive primitive, all-or-nothing, before
 * the claim. Not ok (hold) on any conflict, a closed task or an error. The
 * repo-wide sentinel has nothing to acquire.
 */
export async function acquireStartPaths(
  input: { workspaceId: string; taskId: string; paths: string[] },
  deps: Pick<StartLeaseDeps, 'acquire'> = {},
): Promise<StartLeaseAcquisition> {
  const none: StartLeaseAcquisition = { ok: false, inserted: [], insertedIds: [] };
  const paths = input.paths.filter(p => p !== REPO_WIDE_SENTINEL);
  if (paths.length === 0) return { ok: true, inserted: [], insertedIds: [] };
  try {
    const res = await (deps.acquire ?? defaultAcquire)({ workspaceId: input.workspaceId, taskId: input.taskId, paths, declare: true });
    return res.kind === 'acquired' && res.blocked.length === 0
      ? { ok: true, inserted: [...res.inserted], insertedIds: [...(res.insertedIds ?? [])] }
      : none;
  } catch (err) {
    console.warn('[claim] start path acquisition failed (holding):', (err as Error)?.message ?? err);
    return none;
  }
}

/** A task in one of these is owned by a claim that won: its leases are that claim's. */
export const OWNED_BY_LIVE_CLAIM: readonly string[] = TASK_STATUSES.filter(s => s !== 'pending' && !isTerminalTaskStatus(s));

const defaultReleaseRows: NonNullable<StartLeaseDeps['releaseRows']> = async (input) =>
  (await import('@buildd/core/path-claim')).releaseLeaseRows(input);
const defaultReleaseReason: NonNullable<StartLeaseDeps['releaseReason']> = async (taskId) =>
  (await import('@/lib/path-claim-release')).resolveReleaseReasonForTask(taskId);
const defaultDeliver: NonNullable<StartLeaseDeps['deliver']> = async (taskId, result, reason) =>
  (await import('@/lib/path-claim-release')).deliverPathReleased(taskId, result, reason);

export type StartLeaseRelease = 'nothing_inserted' | 'kept_live_owner' | 'released' | 'error';

/**
 * The claim acquired paths, then lost the atomic pending→assigned claim. Give
 * back exactly the lease rows that acquisition inserted, by id: a concurrent
 * attempt for the same task keeps its own rows, and the manifest is untouched.
 * If a winning claim now owns the task (checked inside the locked statement),
 * keep them. Waiters on a released path hear the task's real release reason
 * (`resolveReleaseReasonForTask`): a task that already finished may have
 * landed its work. Never throws; the path-claims reaper is the backstop for a
 * failed release.
 */
export async function releaseStartPaths(
  input: { workspaceId: string; taskId: string; insertedIds: string[] },
  deps: Pick<StartLeaseDeps, 'releaseRows' | 'releaseReason' | 'deliver'> = {},
): Promise<StartLeaseRelease> {
  if (input.insertedIds.length === 0) return 'nothing_inserted';
  try {
    const out = await (deps.releaseRows ?? defaultReleaseRows)({
      workspaceId: input.workspaceId,
      taskId: input.taskId,
      leaseIds: input.insertedIds,
      keepStatuses: OWNED_BY_LIVE_CLAIM,
    });
    if (out.kind === 'kept') return 'kept_live_owner';
    if (out.kind !== 'released') return 'released';
    if (out.result.notifiedWaiters.length > 0) {
      const reason = await (deps.releaseReason ?? defaultReleaseReason)(input.taskId);
      await (deps.deliver ?? defaultDeliver)(input.taskId, out.result, reason);
    }
    return 'released';
  } catch (err) {
    console.warn('[claim] start lease release after a lost claim failed (reaper will retry):', (err as Error)?.message ?? err);
    return 'error';
  }
}
