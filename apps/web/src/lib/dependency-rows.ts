/**
 * Loads dependency tasks that sit outside the rows a caller already holds
 * (typically: a mission task depending on a task in another mission), with the
 * worker PR facts the dependency contract reads. One query by id list.
 *
 * Every requested id gets an entry: an id with no row becomes
 * `missingDependencyRow`, which is unmet — the claim SQL blocks on a
 * dependency whose row does not exist. Server-only (touches the db).
 */
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { inArray } from 'drizzle-orm';
import { missingDependencyRow, type DependencyRow } from '@/lib/mission-helpers';
import { sqlWhere } from '@buildd/core/db/relational-sql';
import { resolveDependencyHolders, withHolderReach, type DependencyViewer } from '@/lib/task-dependency-reach';

/** Who the rows are rendered for (spec e28018c2 R-6); omitted, rows are returned as stored. */
export interface DependencyRowScope {
  viewer: DependencyViewer;
  teamId: string | null;
  dependentWorkspaceId: string | null;
}

/**
 * With `scope`, each row is resolved for that viewer: one it cannot see loses
 * its title and is marked `hidden`, one in another workspace carries
 * `workspaceName`. Status and workers stay: the gate predicate reads them.
 */
export async function loadDependencyRows(ids: readonly string[], scope?: DependencyRowScope): Promise<Map<string, DependencyRow>> {
  const out = new Map<string, DependencyRow>();
  if (ids.length === 0) return out;
  const rows = await db.query.tasks.findMany({
    where: sqlWhere(inArray(tasks.id, [...ids])),
    columns: { id: true, title: true, status: true, updatedAt: true },
    with: { workers: { columns: { status: true, prUrl: true, mergedAt: true, prLifecycleStatus: true } } },
  });
  const reach = scope ? await resolveDependencyHolders(scope, ids) : null;
  for (const r of rows as DependencyRow[]) if (r.id) out.set(r.id, reach ? withHolderReach(r, reach.get(r.id)) : r);
  for (const id of ids) if (!out.has(id)) out.set(id, missingDependencyRow(id));
  return out;
}
