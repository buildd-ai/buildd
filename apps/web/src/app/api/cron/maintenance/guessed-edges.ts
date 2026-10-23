import type { PathDeclaration } from '@buildd/shared';
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { wakeTasks } from '@/lib/dispatch-authority';

/**
 * Strip the overlap edges the platform guessed off pending tasks (spec 75217f55
 * R-4, AC-7). Task creation no longer guesses ordering from overlapping paths;
 * this removes the guesses already stored, so a task waits only on edges a
 * person or agent declared.
 *
 * Guessed = the ids in `pathDeclaration.inferredDependsOn`, plus every edge on a
 * legacy conflict/collision attempt (`taskClass: attempt` with a
 * `conflictRetryPrNumber` and no `overlapPolicy`), the same rule as migration
 * 0276: that dispatch path never copied a declared edge and never tagged its
 * guesses. Soft overlaps are cleared too. Any other id in `dependsOn` is
 * declared and is never touched.
 *
 * Runs as code in the maintenance cron, not as a migration, so it never takes
 * the schema lane. The write is a compare-and-set on `dependsOn` and
 * `pathDeclaration` (as `reconcilePendingRepairEdges` does): a concurrent edit
 * wins and the row is retried on the next run. A stripped row matches none of
 * the read's conditions, so a second run writes nothing.
 */

export type GuessedEdgeRow = {
  id: string;
  status: string;
  taskClass: string | null;
  conflictRetryPrNumber: number | null;
  dependsOn: string[] | null;
  pathDeclaration: PathDeclaration | null;
};

const BATCH = 500;

function isLegacyAttempt(row: GuessedEdgeRow): boolean {
  return row.taskClass === 'attempt' && row.conflictRetryPrNumber != null && row.pathDeclaration?.overlapPolicy == null;
}

/** The row with its guessed edges and soft overlaps removed, or null when there is nothing to strip. */
export function stripGuessedEdges(row: GuessedEdgeRow): { dependsOn: string[]; pathDeclaration: PathDeclaration } | null {
  if (row.status !== 'pending') return null;
  const deps = row.dependsOn ?? [];
  const decl = row.pathDeclaration;
  const legacy = isLegacyAttempt(row) && deps.length > 0;
  const recorded = decl?.inferredDependsOn ?? [];
  if (!legacy && recorded.length === 0 && !decl?.softOverlaps?.length) return null;
  const guessed = new Set(legacy ? deps : recorded);
  const { softOverlaps: _cleared, ...rest } = decl ?? {};
  return {
    dependsOn: deps.filter(id => !guessed.has(id)),
    pathDeclaration: {
      ...rest,
      // Kept as [] (never dropped) so the row reads as tagged: a declared edge
      // added later is never mistaken for an untagged guess.
      inferredDependsOn: [],
      // A legacy attempt is marked v2 as 0276 does, so the legacy rule stops applying.
      ...(legacy ? { overlapPolicy: 'v2' as const } : {}),
    } as PathDeclaration,
  };
}

/** Apply the strip to rows as read; answers the ids actually written (a CAS miss is left for the next run). */
export async function stripGuessedEdgesFrom(rows: readonly GuessedEdgeRow[]): Promise<string[]> {
  const written: string[] = [];
  for (const row of rows) {
    const next = stripGuessedEdges(row);
    if (!next) continue;
    try {
      const won = await db.update(tasks).set({ dependsOn: next.dependsOn, pathDeclaration: next.pathDeclaration }).where(and(
        eq(tasks.id, row.id),
        eq(tasks.status, 'pending'),
        // A concurrent claim, declaration or dependency edit wins over this read.
        sql`${tasks.dependsOn} IS NOT DISTINCT FROM ${row.dependsOn ? JSON.stringify(row.dependsOn) : null}::jsonb`,
        sql`${tasks.pathDeclaration} IS NOT DISTINCT FROM ${row.pathDeclaration ? JSON.stringify(row.pathDeclaration) : null}::jsonb`,
      )).returning({ id: tasks.id });
      if (won.length > 0) written.push(row.id);
    } catch (err) {
      console.error(`[guessed-edges] strip failed for task ${row.id}:`, err instanceof Error ? err.message : err);
    }
  }
  return written;
}

const nonEmptyArray = (path: ReturnType<typeof sql>) =>
  sql`(jsonb_typeof(${path}) = 'array' AND ${path} <> '[]'::jsonb)`;

/** One maintenance pass: read a batch of pending rows carrying guesses, strip them, wake what changed. */
export async function sweepGuessedEdges(): Promise<number> {
  try {
    const rows = await db.select({
      id: tasks.id,
      status: tasks.status,
      taskClass: tasks.taskClass,
      conflictRetryPrNumber: tasks.conflictRetryPrNumber,
      dependsOn: tasks.dependsOn,
      pathDeclaration: tasks.pathDeclaration,
    }).from(tasks).where(and(
      eq(tasks.status, 'pending'),
      sql`(${nonEmptyArray(sql`${tasks.pathDeclaration} -> 'inferredDependsOn'`)}
        OR ${nonEmptyArray(sql`${tasks.pathDeclaration} -> 'softOverlaps'`)}
        OR (${tasks.taskClass} = 'attempt' AND ${tasks.conflictRetryPrNumber} IS NOT NULL
          AND (${tasks.pathDeclaration} ->> 'overlapPolicy') IS NULL
          AND ${nonEmptyArray(sql`${tasks.dependsOn}`)}))`,
    )).limit(BATCH);
    const written = await stripGuessedEdgesFrom(rows as GuessedEdgeRow[]);
    // The edges that held them are gone: wake each through the outbox.
    if (written.length > 0) await wakeTasks(written, 'dependency.satisfied');
    return written.length;
  } catch (err) {
    console.warn('[guessed-edges] sweep failed:', err instanceof Error ? err.message : err);
    return 0;
  }
}
