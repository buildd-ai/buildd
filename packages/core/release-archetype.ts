import type { WorkspaceReleaseConfig, WorkspaceGitConfig } from './db/schema';

export type ReleaseArchetype = 'gated' | 'continuous' | 'store' | 'package' | 'none';

export interface ArchetypeInput {
  name?: string | null;
  releaseConfig?: WorkspaceReleaseConfig | null;
  gitConfig?: WorkspaceGitConfig | null;
}

export function detectArchetype(workspace: ArchetypeInput): ReleaseArchetype {
  const { name, releaseConfig, gitConfig } = workspace;

  // none: coordination/unconfigured workspaces
  if (name === '__coordination' || name === 'My Workspace') return 'none';
  if ((!releaseConfig || releaseConfig.enabled === false) && gitConfig?.requiresPR !== false) return 'none';

  // continuous: PR not required, or release points to the same branch as default
  const defaultBranch = gitConfig?.defaultBranch ?? 'main';
  if (gitConfig?.requiresPR === false) return 'continuous';
  if (releaseConfig?.enabled === true && releaseConfig.prodBranch === defaultBranch) return 'continuous';

  // gated: releases enabled with a distinct prod branch
  if (releaseConfig?.enabled === true && releaseConfig.prodBranch && releaseConfig.prodBranch !== defaultBranch) {
    return 'gated';
  }

  return 'none';
}
