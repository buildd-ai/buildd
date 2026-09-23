/**
 * SQL scoping predicates for artifact queries. Server-only: this module pulls
 * in the drizzle schema, so never import it from a client component — import
 * `./artifact-prominence` there instead.
 */
import { artifacts, workers } from '@buildd/core/db/schema';
import { and, inArray, isNotNull, notInArray, or, eq, sql, type SQL } from 'drizzle-orm';
import { QueryBuilder } from 'drizzle-orm/pg-core';
import {
  BYPRODUCT_ARTIFACT_TYPES,
  REVIEW_ARTIFACT_TYPES,
} from './artifact-prominence';

/** A predicate that matches no row. Used so an empty access set fails closed. */
const MATCHES_NOTHING = sql`false`;

/**
 * Every artifact visible to a user who can access `workspaceIds`.
 *
 * Two arms, because an artifact has two possible tenancy anchors and
 * `workspace_id` is nullable:
 *
 *   workspace_id IN (accessible workspaces)   -- mission/initiative/workspace
 *                                                level rows, worker_id NULL
 *   OR worker_id IN (SELECT id FROM workers WHERE workspace_id IN (same))
 *                                             -- legacy rows whose
 *                                                workspace_id was never set
 *
 * Both arms are anchored to `workspaceIds`. There is deliberately no
 * `mission_id IS NOT NULL` style arm: a row whose `workspace_id` AND
 * `worker_id` are both NULL has no tenancy anchor and must stay invisible
 * rather than be reached through a mission join.
 *
 * The worker arm is a subquery rather than a caller-loaded id list, which
 * would grow with every worker ever run. Empty access fails closed.
 */
export function workspaceArtifactScope(workspaceIds: readonly string[]): SQL {
  if (workspaceIds.length === 0) return MATCHES_NOTHING;
  const ids = [...workspaceIds];
  // A built subquery, not a `sql` template: `db.query.*.findMany` re-aliases
  // every Column inside a root `where` SQL fragment to the root table, which
  // turned a templated subquery into a correlated self-reference on
  // `artifacts` that matched nothing. A query-builder subquery is left alone.
  const workerIdsInScope = new QueryBuilder()
    .select({ id: workers.id })
    .from(workers)
    .where(inArray(workers.workspaceId, ids));
  return or(
    inArray(artifacts.workspaceId, ids),
    inArray(artifacts.workerId, workerIdsInScope),
  )!;
}

/**
 * SQL mirror of `isReviewArtifact`. Built from the same exported type lists so
 * the two representations cannot drift apart on the vocabulary:
 *
 *   visibility = 'public'
 *   OR type IN (review types)
 *   OR (type NOT IN (byproduct types) AND (key IS NOT NULL
 *                                          OR mission_id IS NOT NULL
 *                                          OR initiative_id IS NOT NULL))
 *
 * The third arm is what admits a named or container-scoped working artifact
 * (and any out-of-vocabulary type) while keeping keyed byproducts out.
 *
 * `key IS NOT NULL` is the SQL stand-in for the TS `Boolean(key)`: every write
 * path stores `key || null`, so an empty-string key does not exist in practice.
 */
export function reviewArtifactScope(): SQL {
  return or(
    eq(artifacts.visibility, 'public'),
    inArray(artifacts.type, [...REVIEW_ARTIFACT_TYPES]),
    and(
      notInArray(artifacts.type, [...BYPRODUCT_ARTIFACT_TYPES]),
      or(
        isNotNull(artifacts.key),
        isNotNull(artifacts.missionId),
        isNotNull(artifacts.initiativeId),
      ),
    ),
  )!;
}
