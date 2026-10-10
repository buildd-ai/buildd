/** Core-declared read hooks; review modules are wired in the composition root. */
import type { WorkspaceGitConfig } from '@buildd/core/db/schema';
import type { MergePolicy } from '@buildd/shared';
export interface RunProgressReaders {
  review(input: { workspaceId: string; prNumber: number }): Promise<{ state: string }>;
  usesReviewer(
    workspace: { gitConfig?: WorkspaceGitConfig | null },
    mission?: { mergePolicy?: MergePolicy | null; requiresReview?: boolean; workingBranch?: string | null; integrationBranchEnabled?: boolean } | null,
    task?: { requiresReview?: boolean } | null,
    pr?: { baseRef?: string | null } | null,
  ): boolean;
}
