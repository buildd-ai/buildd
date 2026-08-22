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

/**
 * Resolve the effective MergePolicy for a PR, applying the precedence chain:
 *   mission.mergePolicy → workspace.gitConfig.mergePolicy → legacy autoMerge* fields → default
 *
 * The legacy fields are never stripped — workspaces that haven't opted into mergePolicy
 * continue with identical behavior.
 */
export function resolvePolicy(
  workspace: { gitConfig?: WorkspaceGitConfig | null },
  mission?: { mergePolicy?: MergePolicy | null } | null,
): MergePolicy {
  // 1. Mission override takes precedence
  if (mission?.mergePolicy) return mission.mergePolicy;

  // 2. Workspace explicit policy
  if (workspace.gitConfig?.mergePolicy) return workspace.gitConfig.mergePolicy;

  // 3. Legacy fields → synthesize an auto-threshold policy
  const legacyAutoMerge =
    workspace.gitConfig?.autoMergeOnGreenCI ??
    workspace.gitConfig?.autoMergePR ??
    true;

  if (!legacyAutoMerge) return { tier: 'human' };

  return {
    tier: 'auto-threshold',
    threshold: {
      maxLines: workspace.gitConfig?.autoMergeMaxLines ?? 800,
      denyPaths: workspace.gitConfig?.autoMergeDenyPaths ?? [],
    },
  };
}
