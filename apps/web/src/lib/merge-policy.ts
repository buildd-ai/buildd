import type { MergePolicy } from '@buildd/shared';
import type { WorkspaceGitConfig } from '@buildd/core/db/schema';

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
