import { z } from 'zod';
import type { MergePolicy } from '@buildd/shared';
import { parseMergePolicy } from '@buildd/shared';
import type { WorkspaceGitConfig } from '@buildd/core/db/schema';

export const DEFAULT_MERGE_POLICY: MergePolicy = {
  tier: 'auto-threshold',
  threshold: { maxLines: 800, denyPaths: [] },
};

const thresholdSchema = z.object({
  maxLines: z.number().optional(),
  maxSourceLines: z.number().optional(),
  denyPaths: z.array(z.string()).optional(),
}).strict();

const agentReviewSchema = z.object({
  reviewerRole: z.string(),
  escalateToPaths: z.array(z.string()).optional(),
  maxConfidenceThreshold: z.number().optional(),
  gateCondition: z.enum(['approve-and-merge', 'approve-only']).optional(),
}).strict();

export const mergePolicySchema = z.object({
  tier: z.enum(['auto-threshold', 'agent-review', 'human']),
  threshold: thresholdSchema.optional(),
  agentReview: agentReviewSchema.optional(),
  stallNotifyMinutes: z.number().optional(),
}).strict();

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
 * Resolve the effective MergePolicy for a PR.
 *
 * Precedence chain (highest to lowest):
 *   task.requiresReview → { tier: 'human' }
 *   mission.mergePolicy
 *   mission.requiresReview → { tier: 'human' }
 *   workspace.gitConfig.mergePolicy
 *   DEFAULT_MERGE_POLICY
 *
 * Legacy autoMerge* fields are no longer consulted — they were migrated to
 * mergePolicy during the 0112 migration.
 */
export function resolvePolicy(
  workspace: { gitConfig?: WorkspaceGitConfig | null },
  mission?: { mergePolicy?: MergePolicy | null; requiresReview?: boolean } | null,
  task?: { requiresReview?: boolean } | null,
): MergePolicy {
  // 1. Task-level requiresReview — explicit human gate
  if (task?.requiresReview) return { tier: 'human' };

  // 2. Mission explicit policy
  if (mission?.mergePolicy) return parseMergePolicyRead(mission.mergePolicy);

  // 3. Mission requiresReview
  if (mission?.requiresReview) return { tier: 'human' };

  // 4. Workspace explicit policy
  if (workspace.gitConfig?.mergePolicy) return parseMergePolicyRead(workspace.gitConfig.mergePolicy);

  // 5. Default
  return DEFAULT_MERGE_POLICY;
}
