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
