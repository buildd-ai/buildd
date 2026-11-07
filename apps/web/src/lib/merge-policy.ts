import { z } from 'zod';
import type { MergePolicy } from '@buildd/shared';
import { parseMergePolicy, reviewByRiskShapeError } from '@buildd/shared';
import type { WorkspaceGitConfig } from '@buildd/core/db/schema';
import { isMissionIntegrationBase } from '@buildd/core/mission-integration';
import { reviewByRiskFor } from '@/lib/review-by-risk';

// Write-path schema. Hand-written `threshold.denyPaths` / `agentReview.escalateToPaths`
// are deliberately absent, so `.strict()` refuses them; callers check
// `findRemovedPathFieldInMergePolicy` first for the clearer 400. Reads go through
// `parseMergePolicyRead`, which still tolerates stored values for one release.
const thresholdSchema = z.object({
  maxLines: z.number().optional(),
  maxSourceLines: z.number().optional(),
}).strict();

const agentReviewSchema = z.object({
  reviewerRole: z.string(),
  maxConfidenceThreshold: z.number().optional(),
  gateCondition: z.enum(['approve-and-merge', 'approve-only']).optional(),
}).strict();

export const mergePolicySchema = z.object({
  tier: z.enum(['auto-threshold', 'agent-review', 'human']),
  threshold: thresholdSchema.optional(),
  agentReview: agentReviewSchema.optional(),
  stallNotifyMinutes: z.number().optional(),
  dataMigrations: z.enum(['person', 'agent-review']).optional(),
  reviewOverride: z.enum(['admins', 'off']).optional(),
  autoReviewUnowned: z.boolean().optional(),
  reviewByRisk: z.object({
    enabled: z.boolean(),
    areas: z.object({
      access: z.array(z.string()).optional(),
      credentials: z.array(z.string()).optional(),
      dataMigrations: z.array(z.string()).optional(),
    }).strict().optional(),
  }).strict().superRefine((v, ctx) => {
    const err = reviewByRiskShapeError(v);
    if (err) ctx.addIssue({ code: 'custom', message: err });
  }).optional(),
}).strict();

export const DEFAULT_MERGE_POLICY: MergePolicy = {
  tier: 'auto-threshold',
  threshold: { maxLines: 800, denyPaths: [] },
};

/**
 * Standard column set for missions when passed to resolvePolicy.
 * Every caller of resolvePolicy must use this to ensure the predicate has
 * all fields it needs: mergePolicy and requiresReview for the precedence chain,
 * workingBranch and integrationBranchEnabled for isMissionIntegrationBase.
 */
export const RESOLVE_POLICY_MISSION_COLUMNS = {
  mergePolicy: true,
  requiresReview: true,
  workingBranch: true,
  integrationBranchEnabled: true,
} as const;

// Workers path: never resolves requiresReview (that decision belongs to the reviewer)
export const WORKERS_POLICY_MISSION_COLUMNS = {
  mergePolicy: true,
  workingBranch: true,
  integrationBranchEnabled: true,
} as const;

/**
 * Parse a stored MergePolicy value on the read path — fail soft.
 * Malformed policy logs a warning and returns the default; never throws.
 */
export function parseMergePolicyRead(val: unknown): MergePolicy {
  if (!val) return DEFAULT_MERGE_POLICY;
  const result = parseMergePolicy(val);
  if (!result.ok) {
    console.warn(`[merge-policy] malformed stored policy (${result.error}); falling back to default`);
    return DEFAULT_MERGE_POLICY;
  }
  return result.policy;
}

/**
 * Is this PR's base the mission's integration branch (Option A′)?
 *
 * Re-exported, not reimplemented. The predicate lives in
 * `@buildd/core/mission-integration` because three places must never disagree
 * about it — merge-policy resolution here, task creation
 * (`api/tasks/route.ts`, `approve-plan.ts`), and the completion criterion — and
 * a false positive silently deletes a human review gate. Two copies of a
 * branch-name rule is the bug `packages/core/branch-names.ts` exists to have
 * fixed once.
 */
export { isMissionIntegrationBase } from '@buildd/core/mission-integration';

/**
 * Resolve the effective MergePolicy for a PR.
 *
 * Precedence chain (highest to lowest):
 *   1. task.requiresReview                → { tier: 'human' }
 *   2. PR based on the mission integration branch (Option A')
 *                                          → { tier: 'auto-threshold', threshold: <carried through> }
 *   2b. review by risk on, PR based on the workspace integration branch
 *                                          → { tier: 'auto-threshold', threshold: <carried>, reviewByRisk }
 *   3. mission.mergePolicy
 *   4. mission.requiresReview              → { tier: 'human' }
 *   5. workspace.gitConfig.mergePolicy
 *   6. DEFAULT_MERGE_POLICY
 *
 * ## The crux of Option A' (mission integration branches)
 *
 * Under Option A' a mission's task PRs are retargeted at a mission integration
 * branch (`missions.workingBranch`, shape `mission/<slug>-<id8>`); when the
 * mission's work is done that branch opens ONE PR into trunk. The merge-policy
 * TIER applies to that MISSION PR — not to the task PRs that target it.
 *
 * So a task PR whose base is the integration branch runs `auto-threshold` and
 * lands unattended into a branch that is, by construction, quarantined from
 * trunk. `human` / `agent-review` then fires exactly once, at the mission PR
 * (whose base is trunk, so rule 2 does not apply to it). If the tier were
 * instead applied per task PR, A' would collapse into today's behaviour with an
 * extra branch in the middle and N human gates instead of one.
 *
 * Two deliberate asymmetries:
 *
 * - `task.requiresReview` still wins (rule 1 above rule 2). That flag is an
 *   explicit, per-task operator act — somebody asked for a human on this exact
 *   task by name — and A' must not silently revoke it.
 * - The THRESHOLD is carried through from whatever the rest of the chain would
 *   have resolved (falling back to DEFAULT_MERGE_POLICY.threshold), so its
 *   denyPaths still apply. Its aggregate line cap does NOT apply to the task
 *   PR: `evaluateAutoMergeSafety` exempts a PR whose base is its own mission's
 *   integration branch, and applies the cap once, at the mission-to-trunk PR,
 *   with the rest of the tier.
 *
 * Backwards compatibility: with `pr` omitted, `pr.baseRef` null, or the mission
 * not opted in (`integrationBranchEnabled` false, the default), this returns
 * exactly what it returned before Option A' existed.
 *
 * Legacy autoMerge* fields are no longer consulted — they were migrated to
 * mergePolicy during the 0112 migration.
 */
export function resolvePolicy(
  workspace: { gitConfig?: WorkspaceGitConfig | null },
  mission?: {
    mergePolicy?: MergePolicy | null;
    requiresReview?: boolean;
    workingBranch?: string | null;
    integrationBranchEnabled?: boolean;
  } | null,
  task?: { requiresReview?: boolean } | null,
  pr?: { baseRef?: string | null } | null,
): MergePolicy {
  // 1. Task-level requiresReview — explicit human gate, never overridden
  if (task?.requiresReview) return { tier: 'human' };

  // 2. Option A': task PR based on the mission integration branch. The tier
  //    belongs to the mission PR, so drop it here and carry the threshold.
  if (isMissionIntegrationBase({ baseRef: pr?.baseRef, mission })) {
    const carried = resolveChainBelowIntegrationBranch(workspace, mission);
    return {
      tier: 'auto-threshold',
      threshold: carried.threshold ?? DEFAULT_MERGE_POLICY.threshold,
    };
  }

  // 2b. Review by risk (spec 62e985a8 R-1, R-9): the workspace has the mode on
  //     and this PR targets its integration branch. It merges on its own under
  //     the auto-threshold rails, carried threshold and all, with
  //     `reviewByRisk` attached: that is what lifts the aggregate size cap and
  //     adds the risk-area and acceptance-test holds in evaluateAutoMergeSafety.
  //     Read from the workspace policy only; a mission's policy never turns it on.
  const risk = reviewByRiskFor({ gitConfig: workspace.gitConfig, baseRef: pr?.baseRef, mission: mission ?? null });
  if (risk) {
    const carried = resolveChainBelowIntegrationBranch(workspace, mission);
    return {
      tier: 'auto-threshold',
      threshold: carried.threshold ?? DEFAULT_MERGE_POLICY.threshold,
      reviewByRisk: risk.policy,
    };
  }

  return resolveChainBelowIntegrationBranch(workspace, mission);
}

/**
 * Steps 3-6 of the precedence chain. Split out so the Option A' branch can
 * resolve the policy the rest of the chain WOULD have produced and carry its
 * threshold forward without duplicating the chain.
 */
function resolveChainBelowIntegrationBranch(
  workspace: { gitConfig?: WorkspaceGitConfig | null },
  mission?: { mergePolicy?: MergePolicy | null; requiresReview?: boolean } | null,
): MergePolicy {
  // `reviewByRisk` is attached only by rule 2b, for the PRs it governs: a
  // stored copy on a mission or workspace policy never rides along to others.
  // 3. Mission explicit policy
  if (mission?.mergePolicy) return withoutReviewByRisk(parseMergePolicyRead(mission.mergePolicy));

  // 4. Mission requiresReview
  if (mission?.requiresReview) return { tier: 'human' };

  // 5. Workspace explicit policy
  if (workspace.gitConfig?.mergePolicy) return withoutReviewByRisk(parseMergePolicyRead(workspace.gitConfig.mergePolicy));

  // 6. Default
  return DEFAULT_MERGE_POLICY;
}

function withoutReviewByRisk(policy: MergePolicy): MergePolicy {
  if (!('reviewByRisk' in policy)) return policy;
  const { reviewByRisk: _rbr, ...rest } = policy;
  return rest;
}
