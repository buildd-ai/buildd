// Resolve a workspace's default branch strategy for NEW missions. Pure (no
// I/O) so the workspace config route and mission creation share one answer —
// the same reason `release-strategy.ts` exists for release config.
//
// This is a mission-CREATE-time default only. It sets `integrationBranchEnabled`
// on the mission row at insert; from then on the mission row is the runtime
// authority (`missionIntegrationBase()` in `mission-integration.ts`). Nothing
// here ever reads or changes an existing mission.

import type { WorkspaceGitConfig, BranchStrategy } from './db/schema';

export type { BranchStrategy };

export const BRANCH_STRATEGIES: BranchStrategy[] = ['mission-branch', 'direct'];

export function isValidBranchStrategy(value: unknown): value is BranchStrategy {
  return value === 'mission-branch' || value === 'direct';
}

// Absent ⇒ 'mission-branch' (opt-OUT) — see the field comment on
// WorkspaceGitConfig.branchStrategy in db/schema.ts for why.
export function resolveBranchStrategy(
  gitConfig: WorkspaceGitConfig | null | undefined,
): BranchStrategy {
  return gitConfig?.branchStrategy ?? 'mission-branch';
}
