import { z } from 'zod';
import type { MergePolicy } from '@buildd/shared';
import type { WorkspaceGitConfig } from '@buildd/core/db/schema';

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

const DEFAULT_MERGE_POLICY: MergePolicy = {
  tier: 'auto-threshold',
  threshold: { maxLines: 800 },
};

/**
 * Resolve the effective MergePolicy for a PR.
 *
 * Precedence chain (highest to lowest):
 *   task.requiresReview=true    → { tier: 'human' }
 *   mission.requiresReview=true → { tier: 'human' }
 *   mission.mergePolicy         → use it
 *   workspace.gitConfig.mergePolicy → use it
 *   default                     → { tier: 'auto-threshold', threshold: { maxLines: 800 } }
 */
export function resolvePolicy(
  workspace: { gitConfig?: WorkspaceGitConfig | null },
  mission?: { mergePolicy?: MergePolicy | null; requiresReview?: boolean } | null,
  task?: { requiresReview?: boolean } | null,
): MergePolicy {
  if (task?.requiresReview) return { tier: 'human' };
  if (mission?.requiresReview) return { tier: 'human' };
  if (mission?.mergePolicy) return mission.mergePolicy;
  if (workspace.gitConfig?.mergePolicy) return workspace.gitConfig.mergePolicy;
  return DEFAULT_MERGE_POLICY;
}
