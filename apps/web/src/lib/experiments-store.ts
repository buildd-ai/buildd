/**
 * Experiments — the query half behind /api/experiments. Every predicate is a
 * named builder so experiments-store.test.ts can render it to SQL: a mocked
 * `db` accepts any WHERE clause at all, and team scoping here is the only thing
 * standing between one team and another team's experiments.
 */
import { and, desc, eq, ne, notExists, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '@buildd/core/db';
import { experiments } from '@buildd/core/db/schema';
import { invalidateModelRoutingExperimentCache } from '@buildd/core/model-routing-experiment-source';
import type { NewExperimentValues } from './experiments';

export type ExperimentRow = typeof experiments.$inferSelect;

export function teamExperimentsScope(teamId: string) {
  return eq(experiments.teamId, teamId);
}

export function teamExperimentScope(teamId: string, id: string) {
  return and(eq(experiments.id, id), eq(experiments.teamId, teamId));
}

/** Another running experiment of the same kind on the same team. */
export function otherRunningScope(teamId: string, kind: string, excludeId: string) {
  return and(
    eq(experiments.teamId, teamId),
    eq(experiments.kind, kind as 'model_routing'),
    eq(experiments.status, 'running'),
    ne(experiments.id, excludeId),
  );
}

const other = alias(experiments, 'other_experiment');

/**
 * The guarded UPDATE's WHERE: the row must still be in the state the patch was
 * planned against (status + policyVersion — optimistic lock, since neon-http
 * has no interactive transactions), and when starting, no other experiment of
 * the kind may be running. The pre-check in the route gives the readable 409;
 * this clause is what makes two concurrent starts unable to both win.
 */
export function guardedUpdateScope(
  teamId: string,
  id: string,
  expected: { status: string; policyVersion: number },
  requireNoOtherRunning: { kind: string } | null,
) {
  const base = and(
    eq(experiments.id, id),
    eq(experiments.teamId, teamId),
    eq(experiments.status, expected.status as ExperimentRow['status']),
    eq(experiments.policyVersion, expected.policyVersion),
  );
  if (!requireNoOtherRunning) return base;
  return and(
    base,
    notExists(
      db.select({ one: sql`1` }).from(other).where(and(
        eq(other.teamId, teamId),
        eq(other.kind, requireNoOtherRunning.kind as 'model_routing'),
        eq(other.status, 'running'),
        ne(other.id, id),
      )),
    ),
  );
}

export async function listTeamExperiments(teamId: string): Promise<ExperimentRow[]> {
  return db.select().from(experiments).where(teamExperimentsScope(teamId)).orderBy(desc(experiments.createdAt));
}

export async function getTeamExperiment(teamId: string, id: string): Promise<ExperimentRow | null> {
  const rows = await db.select().from(experiments).where(teamExperimentScope(teamId, id)).limit(1);
  return rows[0] ?? null;
}

export async function findOtherRunning(teamId: string, kind: string, excludeId: string): Promise<{ id: string; key: string } | null> {
  const rows = await db
    .select({ id: experiments.id, key: experiments.key })
    .from(experiments)
    .where(otherRunningScope(teamId, kind, excludeId))
    .limit(1);
  return rows[0] ?? null;
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string }; message?: string } | null;
  return e?.code === '23505' || e?.cause?.code === '23505' || /duplicate key|unique constraint/i.test(e?.message ?? '');
}

export async function insertExperiment(
  teamId: string,
  createdBy: string | null,
  values: NewExperimentValues,
): Promise<ExperimentRow | 'duplicate_key'> {
  try {
    const [row] = await db.insert(experiments).values({ ...values, teamId, createdBy, status: 'draft' }).returning();
    return row;
  } catch (err) {
    if (isUniqueViolation(err)) return 'duplicate_key';
    throw err;
  }
}

export async function applyExperimentUpdate(
  teamId: string,
  id: string,
  expected: { status: string; policyVersion: number },
  set: Record<string, unknown>,
  requireNoOtherRunning: { kind: string } | null,
): Promise<ExperimentRow | null> {
  const rows = await db
    .update(experiments)
    .set(set as Partial<typeof experiments.$inferInsert>)
    .where(guardedUpdateScope(teamId, id, expected, requireNoOtherRunning))
    .returning();
  // The claim route caches the running experiment per team for a minute; drop
  // this process's copy so a start/pause here is visible to the next claim it
  // serves. Other instances converge within the TTL.
  invalidateModelRoutingExperimentCache(teamId);
  return rows[0] ?? null;
}
