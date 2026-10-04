import type { ClaimDiagnostics, ClaimTaskExclusion } from '@buildd/shared';

/**
 * The reason an explicitly requested task (claim with `taskId`) was deferred
 * INSIDE the dispatch loop, after it passed every SQL-level gate.
 *
 * Before this, only path overlap named itself there; every other deferral fell
 * through to "claimable but held back this poll", so a caller who named the
 * task could not tell a mission concurrency cap from a Codex slot from a
 * provider wall (friction cad81659). One sentence per `deferrals` key, filled
 * in with the details the loop already had in hand.
 */
export type DeferralReason = keyof Required<NonNullable<ClaimDiagnostics['deferrals']>>;

const FORCE_HINT = 'An admin can claim it anyway with claim_task force: true.';

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function describeExplicitDeferral(
  reason: DeferralReason,
  detail: Record<string, unknown> = {},
): ClaimTaskExclusion {
  switch (reason) {
    case 'connector_mismatch':
      return { code: reason, detail: 'A connector its role requires is not available in this workspace.' };
    case 'subject_dead':
      return { code: reason, detail: `Its subject PR was reconciled as dead while this claim ran. ${FORCE_HINT}` };
    case 'path_overlap': {
      const pr = num(detail.prNumber);
      const blocker = str(detail.blockingTaskId);
      const what = pr ? `open PR #${pr}` : blocker ? `an active claim held by task ${blocker}` : 'another task\'s files';
      return { code: reason, detail: `Its files overlap ${what}. ${FORCE_HINT}` };
    }
    case 'advisory_manifest': {
      const peer = str(detail.blockingPeer);
      return {
        code: reason,
        detail: `It declares no file scope and its mission already has a scope-undeclared task in flight${peer ? ` (${peer})` : ''}; only one runs at a time. Wait for that task, or re-create this one with a pathManifest (or outputRequirement 'artifact_required' / 'none' if it edits no files).`,
      };
    }
    case 'mission_budget':
      return { code: reason, detail: 'Its mission is budget_exhausted. Raise the mission budget to resume it.' };
    case 'mission_concurrent': {
      const active = num(detail.active);
      const cap = num(detail.cap);
      return {
        code: reason,
        detail: `Its mission is at its concurrency cap${active !== null && cap !== null ? ` (${active}/${cap} tasks in flight)` : ''}. Wait for one to finish, or raise maxConcurrentTasks. ${FORCE_HINT}`,
      };
    }
    case 'mission_paced': {
      const at = str(detail.nextEligibleAt);
      return { code: reason, detail: `Its mission is paced; the next task may start${at ? ` at ${at}` : ' later'}. ${FORCE_HINT}` };
    }
    case 'workspace_cap': {
      const active = num(detail.active);
      const cap = num(detail.cap);
      return {
        code: reason,
        detail: `The workspace is at its concurrent-task cap${active !== null && cap !== null ? ` (${active}/${cap})` : ''}. ${FORCE_HINT}`,
      };
    }
    case 'provider_unavailable':
      return { code: reason, detail: 'Claude is disabled for the team and Codex has no credential or free slot in this workspace.' };
    case 'budget_paused': {
      const backend = str(detail.backend) ?? 'its provider';
      const at = str(detail.resetsAt);
      return { code: reason, detail: `The ${backend} budget or rate limit is exhausted${at ? ` until ${at}` : ''}, with no provider to fail over to.` };
    }
    case 'routing_paused':
      return { code: reason, detail: 'Model routing paused it under budget pressure; it is retried on the next poll.' };
    case 'duplicate_worker': {
      const w = str(detail.liveWorkerId);
      return { code: reason, detail: `Another worker${w ? ` (${w})` : ''} took the task while this claim ran.` };
    }
    case 'sibling_retry_open':
      return {
        code: reason,
        detail: 'Another fix attempt for the same PR is already open, so this one was cancelled rather than started beside it: one retry lineage updates one PR.',
      };
    case 'runner_capability': {
      const model = str(detail.model);
      const req = str(detail.requiredVersion);
      return {
        code: reason,
        detail: `Its model${model ? ` ${model}` : ''} needs Claude Code ${req ?? 'a newer version'} or newer than this caller reports.`,
      };
    }
    case 'codex_single_flight':
      return { code: reason, detail: 'It runs on Codex and this workspace\'s one Codex slot is taken.' };
    case 'oauth_parallelism':
      return { code: reason, detail: 'The seat is at the session cap its learned OAuth budget allows right now.' };
    case 'role_env_unsatisfied': {
      const role = str(detail.roleSlug);
      const missing = Array.isArray(detail.missing) ? (detail.missing as unknown[]).filter((m): m is string => typeof m === 'string') : [];
      return {
        code: reason,
        detail: `${role ? `Its role '${role}'` : 'Its workspace'} declares env ${missing.length > 0 ? missing.join(', ') : 'vars'} that no secret supplies. Add a role_env_secret under the mapped label (or remove the declaration), and it is claimable on the next poll.`,
      };
    }
  }
}
