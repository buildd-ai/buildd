/** Core-declared read hooks; review modules are wired in the composition root. */
import type { DeliveryView } from '@/lib/workflow/projections';
import type { WorkspaceGitConfig } from '@buildd/core/db/schema';
import type { MergePolicy } from '@buildd/shared';
export interface RunProgressReaders {
  /** `knownDelivery`: the caller's own read of one task's delivery view, used when that task owns the PR. */
  review(input: { workspaceId: string; prNumber: number; knownDelivery?: { taskId: string; view: Promise<DeliveryView | null> } }): Promise<{ state: string; reviewTaskId?: string | null; verdict?: string | null; iteration?: number | null }>;
  usesReviewer(
    workspace: { gitConfig?: WorkspaceGitConfig | null },
    mission?: { mergePolicy?: MergePolicy | null; requiresReview?: boolean; workingBranch?: string | null; integrationBranchEnabled?: boolean } | null,
    task?: { requiresReview?: boolean } | null,
    pr?: { baseRef?: string | null } | null,
  ): boolean;
}
