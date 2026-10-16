/**
 * The trunk circuit breaker's half of the kernel's `Work` port
 * (docs/specs/workflow-state-kernel.md §6.10, §10.2): the shape of a
 * trunk-fix task. The handlers (`dispatch_trunk_fix`, and
 * `cancel_open_attempts` for `blocked_on_trunk`) are the package's
 * (packages/workflow-kernel/src/handlers/trunk.ts); the incident ledger they
 * read is core's `builddTrunk` (trunk.ts). Reached only through the
 * composition root (`workflowKernelHooks()` in apps/web/src/modules.ts).
 *
 * The kernel words the task (title, description) and picks its id (the
 * base's anchor incident), so every incident of one red base files the same
 * row; this builder adds what a buildd task row needs.
 */
import { eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { sqlWhere } from '@buildd/core/db/relational-sql';
import type { WorkBuilder } from './kernel-ports';

export const trunkFixWork: WorkBuilder = async (req) => {
  const workspace = await db.query.workspaces.findFirst({ where: sqlWhere(eq(workspaces.id, req.workspaceId)) });
  if (!workspace) return { skipped: 'no_workspace' };
  const detail = req.detail ?? {};
  return {
    workspace,
    values: {
      workspaceId: req.workspaceId,
      title: req.title,
      description: req.description,
      category: 'bug',
      kind: 'engineering',
      creationSource: 'webhook',
      outputRequirement: 'pr_required',
      status: 'pending',
      priority: 9,
      context: { trunkIncidentId: detail.incidentId, baseBranch: detail.baseRef, signature: detail.signature, baseHeadSha: detail.baseHeadSha ?? null },
    },
  };
};

/**
 * §13.13 rule 10 (AC-15): the fix owed when a PR was merged outside buildd over
 * a review verdict still open. The kernel words it (the review's ask, against
 * the base) and files it under its effect's id, once; this builder adds what a
 * task row needs. Like a trunk fix, it is work on the base branch, not the PR.
 */
export const externalMergeFixWork: WorkBuilder = async (req) => {
  const workspace = await db.query.workspaces.findFirst({ where: sqlWhere(eq(workspaces.id, req.workspaceId)) });
  if (!workspace) return { skipped: 'no_workspace' };
  const detail = req.detail ?? {};
  return {
    workspace,
    values: {
      workspaceId: req.workspaceId,
      title: req.title,
      description: req.description,
      category: 'bug',
      kind: 'engineering',
      creationSource: 'webhook',
      outputRequirement: 'pr_required',
      status: 'pending',
      priority: 7,
      context: {
        externalMergeFix: true,
        mergedPrNumber: detail.prNumber ?? null,
        reviewRoundId: detail.roundId ?? null,
        baseBranch: req.target.baseRef ?? null,
        mergeCommitSha: req.target.headSha ?? null,
      },
    },
  };
};
