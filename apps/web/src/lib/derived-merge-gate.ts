/**
 * The gate-ledger row for a conflict retry the runner finished without an
 * agent (`derivedMergeFinish` on the completion PATCH, see
 * apps/runner/src/merge-drivers.ts `finishDerivedMerge`).
 *
 * Same family as the server's own no-agent conflict paths in
 * lib/conflict-retry.ts: `base_refresh`, `accepted` = the base went in with no
 * agent. `detail.stage: 'derived_merge'` separates these rows from GitHub's
 * update-branch merges, so the ledger can count retries finished mechanically.
 */
import { GATE_SLUGS } from '@buildd/core/gate-slugs';
import type { RecordGateEventInput } from '@buildd/core/gate-events';

const MAX_COMMANDS = 20;

export function derivedMergeGateEvent(
  status: unknown,
  report: unknown,
  ctx: { workspaceId: string | null; missionId: string | null; taskId: string | null; workerId: string },
): RecordGateEventInput | null {
  if (status !== 'completed' || !report || typeof report !== 'object') return null;
  const r = report as Record<string, unknown>;
  if (typeof r.baseRef !== 'string' || !r.baseRef) return null;
  const regenerated = Array.isArray(r.regenerated)
    ? r.regenerated.filter((c): c is string => typeof c === 'string').slice(0, MAX_COMMANDS)
    : [];
  return {
    gate: GATE_SLUGS.BASE_REFRESH,
    surface: 'runner derived-file merge',
    outcome: 'accepted',
    reason: 'conflict_retry_finished_without_agent',
    workspaceId: ctx.workspaceId,
    missionId: ctx.missionId,
    taskId: ctx.taskId,
    workerId: ctx.workerId,
    callerOrigin: 'worker',
    detail: {
      stage: 'derived_merge',
      baseRef: r.baseRef,
      regenerated,
      verification: typeof r.verification === 'string' ? r.verification : null,
      headSha: typeof r.headSha === 'string' ? r.headSha : null,
    },
  };
}
