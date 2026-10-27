import { db } from '@buildd/core/db';
import { tasks, workers } from '@buildd/core/db/schema';
import { eq, inArray, sql } from 'drizzle-orm';
import { acceptanceEditOf, pendingAcceptance } from '@buildd/spec-contract/acceptance-edit';
import { isBuildingRole } from '@/lib/acceptance-edit-sync';

/** One building task whose PR edits acceptance tests nobody has accepted yet (spec 1dc6cc39 R-80, AC-126). */
export interface AcceptanceHold {
  taskId: string;
  prNumber: number | null;
  /** The PR's diff page, when the PR is known. */
  diffUrl: string | null;
  paths: string[];
}

/**
 * The holds over a mission's tasks (pure). `prs` maps a task to its newest PR.
 * Same rule as `unacceptedPathsOf`: only building tasks carry a flag.
 */
export function acceptanceHolds(
  rows: ReadonlyArray<{ id: string; roleSlug: string | null; context: unknown }>,
  prs: ReadonlyMap<string, { prNumber: number | null; prUrl: string | null }>,
): AcceptanceHold[] {
  return rows.filter((t) => isBuildingRole(t.roleSlug)).flatMap((t) => {
    const paths = pendingAcceptance(acceptanceEditOf(t.context));
    if (!paths.length) return [];
    const pr = prs.get(t.id);
    return [{ taskId: t.id, prNumber: pr?.prNumber ?? null, diffUrl: pr?.prUrl ? `${pr.prUrl.replace(/\/+$/, '')}/files` : null, paths }];
  }).sort((a, b) => (a.prNumber ?? 0) - (b.prNumber ?? 0));
}

export async function loadAcceptanceHolds(missionId: string): Promise<AcceptanceHold[]> {
  // Only the flag is read: the page's task digest leaves `context` mostly out.
  const rows = await db.select({ id: tasks.id, roleSlug: tasks.roleSlug, context: sql<unknown>`jsonb_build_object('acceptanceEdit', ${tasks.context}->'acceptanceEdit')` })
    .from(tasks).where(eq(tasks.missionId, missionId));
  const flagged = rows.filter((r) => isBuildingRole(r.roleSlug) && acceptanceEditOf(r.context));
  if (!flagged.length) return [];
  const ws = await db.select({ taskId: workers.taskId, prNumber: workers.prNumber, prUrl: workers.prUrl })
    .from(workers).where(inArray(workers.taskId, flagged.map((r) => r.id)));
  const prs = new Map<string, { prNumber: number | null; prUrl: string | null }>();
  for (const w of ws) if (w.taskId && w.prNumber != null) prs.set(w.taskId, { prNumber: w.prNumber, prUrl: w.prUrl });
  return acceptanceHolds(flagged, prs);
}
