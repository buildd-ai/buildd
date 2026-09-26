import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import type { CriteriaGrader } from '@buildd/shared';
import { asCriteriaGrader } from './mission-criteria-grader';

// ── Prose criterion grader ────────────────────────────────────────────────────

/**
 * The workspace's configured prose grader (`gitConfig.criteriaGrader`), or null.
 *
 * Lives in the existing `gitConfig` jsonb bag — where `defaultBackend` and
 * `maxBudgetUsd` already live — so it needs no column and is already writable
 * via PATCH /api/workspaces/[id] (MCP `manage_workspaces gitConfig={…}`). An
 * unrecognised value is ignored rather than trusted.
 */
export async function resolveWorkspaceCriteriaGrader(workspaceId?: string | null): Promise<CriteriaGrader | null> {
  if (!workspaceId) return null;
  const ws = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId),
    columns: { gitConfig: true },
  });
  return asCriteriaGrader((ws?.gitConfig as Record<string, unknown> | null | undefined)?.criteriaGrader);
}
