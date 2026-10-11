import { isNull, or, sql, type SQL } from 'drizzle-orm';
import { BYPASS_DEPS_GATE_KEY, bypassFlagCondition } from '@/lib/bypass-flags';
import { tasks, workers, dependencyReleases } from '@buildd/core/db/schema';
import { FORCE_START_CONTEXT_KEY } from '@buildd/core/waiting-reason';
import {
  DEP_SATISFYING_STATUSES,
  DEP_UNBLOCKING_PR_LIFECYCLE,
  EARLY_RELEASE_SATISFYING_DECISIONS,
} from '@/lib/dep-gate-contract';
import { SURFACE_AUDIT_TITLE_PREFIX } from '@buildd/core/member-scoped-deps';
import { MIGRATION_PATH_RE } from '@buildd/core/path-overlap';
import { LIVE_WORKER_STATUSES } from '@buildd/shared';

/**
 * Re-exported for callers already importing the contract from the gate module.
 * The definition lives in lib/dep-gate-contract.ts so the display gate
 * (`isGateSatisfied` in lib/task-presentation.ts) reads the same constant —
 * `dependenciesSatisfied()` below builds its SQL `IN (...)` list from it, so
 * neither the SQL nor the UI can drift from the contract.
 */
export { DEP_SATISFYING_STATUSES };

/**
 * Dependency-completion gate for the claim route.
 *
 * Returns a SQL condition that is TRUE when every id in `tasks.depends_on`
 * resolves to a satisfied dependency:
 *
 *   satisfied = (status ∈ DEP_SATISFYING_STATUSES
 *                AND NOT (status = 'completed' AND the dep has an open/unmerged PR))
 *               OR a non-revoked dependency_releases row names this task as the
 *                  dependent and this dep as the upstream, with
 *                  decision ∈ EARLY_RELEASE_SATISFYING_DECISIONS
 *
 * The open-PR guard only applies to `completed` deps — it prevents a downstream
 * task from starting while an upstream PR is still open (root cause of the
 * 6-overlapping-PR burst, PRs #1044-1049). `cancelled` deps carry no such guard.
 *
 * The early-release arm (docs/design/early-release.md "Data model") is purely
 * additive — it OR's onto the status check, never replaces it, so a workspace
 * that never writes a `dependency_releases` row sees zero behavior change.
 *
 * Callers should OR this with the bypass conditions (no deps, empty deps,
 * `context.bypassDepsGate = 'true'`).
 */
export function dependenciesSatisfied(): SQL {
  return sql`NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(${tasks.dependsOn}::jsonb) AS dep_id
    WHERE NOT ${dependencySatisfied(sql`dep_id::uuid`)}
    AND NOT ${outsideSurfaceAuditMission(sql`dep_id::uuid`)}
  )`;
}

/**
 * TRUE when the dependent (the outer `tasks` row) is a mission's
 * `[surface audit]` and `depId` is not a task of that mission any more. The
 * audit waits on the mission's builder work as it is now: its dependsOn was
 * extended as tasks were filed, and a task unlinked or moved since must not
 * hold it (`dependencyHoldsTask` in @buildd/core/member-scoped-deps is the
 * same rule in TS). A dependency row that no
 * longer exists is not a member either. Every other task keeps waiting on
 * every dependency it names, in any mission.
 */
export function outsideSurfaceAuditMission(depId: SQL): SQL {
  return sql`(
    ${tasks.missionId} IS NOT NULL
    AND ${tasks.title} LIKE ${`${SURFACE_AUDIT_TITLE_PREFIX}%`}
    AND NOT EXISTS (
      SELECT 1 FROM ${tasks} t3
      WHERE t3.id = ${depId}
      AND t3.mission_id = ${tasks.missionId}
    )
  )`;
}

/**
 * TRUE when the ONE dependency `depId` names is satisfied. The per-dependency
 * half of `dependenciesSatisfied()`, exported so the explicit-claim diagnosis
 * can say WHICH dependency is blocking with the same predicate the claim used.
 */
export function dependencySatisfied(depId: SQL): SQL {
  const satisfyingStatuses = sql.join(
    DEP_SATISFYING_STATUSES.map((s) => sql`${s}`),
    sql`, `,
  );

  const releaseDecisions = sql.join(
    EARLY_RELEASE_SATISFYING_DECISIONS.map((d) => sql`${d}`),
    sql`, `,
  );

  return sql`(
    EXISTS (
      SELECT 1 FROM ${tasks} t2
      WHERE t2.id = ${depId}
      AND t2.status IN (${satisfyingStatuses})
      AND NOT (
        -- A completed dep with a still-open PR keeps blocking its dependents.
        -- Exception: a closed/abandoned PR (pr_lifecycle_status = 'closed') should
        -- unblock dependents — the work was abandoned, not merged. Without this
        -- guard a dependent task blocks forever when the upstream PR is closed.
        t2.status = 'completed'
        AND EXISTS (
          SELECT 1 FROM ${workers} w
          WHERE w.task_id = t2.id
          AND w.pr_url IS NOT NULL
          AND w.merged_at IS NULL
          AND COALESCE(w.pr_lifecycle_status, '') != ${DEP_UNBLOCKING_PR_LIFECYCLE}
        )
      )
    )
    OR EXISTS (
      -- Early release: a human/decision-model call to start this dependent
      -- before the upstream's own status/PR state would otherwise allow it.
      -- Revoked rows (revoked_at set) do not count — see docs/design/early-release.md.
      SELECT 1 FROM ${dependencyReleases} dr
      WHERE dr.dependent_task_id = ${tasks.id}
      AND dr.upstream_task_id = ${depId}
      AND dr.decision IN (${releaseDecisions})
      AND dr.revoked_at IS NULL
    )
    OR ${migrationEdgeOnOtherBase(depId)}
    OR ${inferredEdgeOntoUnstartedHolder(depId)}
    OR ${forceStartLiftsEdge(depId)}
  )`;
}

/**
 * TRUE when a person's unexpired dashboard Force start names `depId` in
 * `context.forceStart.liftDependsOn` AND the edge is one the system inferred
 * at creation (`pathDeclaration.inferredDependsOn`): incidental file-overlap
 * ordering, which a force may lift for claim order (docs/specs/force-start.md).
 * A declared edge never qualifies, even if named. The intent is single-use:
 * the claim consumes it, and after `expiresAt` it no longer lifts anything.
 * The edit-time path lease still serializes the shared files.
 */
function forceStartLiftsEdge(depId: SQL): SQL {
  // A constant key, inlined so the gate's bound parameters stay the contract's.
  const key = sql.raw(`'${FORCE_START_CONTEXT_KEY}'`);
  return sql`(
    ${tasks.pathDeclaration}->'inferredDependsOn' ? (${depId})::text
    AND ${tasks.context}->${key}->'liftDependsOn' ? (${depId})::text
    AND (${tasks.context}->${key}->>'expiresAt') > to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )`;
}

/**
 * TRUE when `depId` is an overlap edge the creation route inferred
 * (`pathDeclaration.inferredDependsOn`) and the dependency has not started:
 * still pending, no live worker, and no worker holding an open PR. The edge
 * stops two tasks editing a migration index or hard surface at once; a holder
 * that has not started is editing nothing. Whichever of the two claims first
 * takes the paths, and the claim route's live gates (path leases, open-PR
 * overlap) hold the other until it lands. Without this, a small task queued
 * behind a feature deferred for days, and behind that feature's own edges.
 * Caller-declared edges never qualify.
 */
function inferredEdgeOntoUnstartedHolder(depId: SQL): SQL {
  const liveStatuses = sql.join(LIVE_WORKER_STATUSES.map((s) => sql`${s}`), sql`, `);
  return sql`(
    ${isInferredEdge(depId)}
    AND EXISTS (
      SELECT 1 FROM ${tasks} t5
      WHERE t5.id = ${depId}
      AND t5.status = ${'pending'}
    )
    AND NOT EXISTS (
      SELECT 1 FROM ${workers} w5
      WHERE w5.task_id = ${depId}
      AND (
        w5.status IN (${liveStatuses})
        OR (w5.pr_url IS NOT NULL AND w5.merged_at IS NULL
          AND COALESCE(w5.pr_lifecycle_status, '') != ${DEP_UNBLOCKING_PR_LIFECYCLE})
      )
    )
  )`;
}

/**
 * The claim route's whole dependency gate: TRUE when the task has no
 * dependencies, a person force-started it (context.bypassDepsGate), or every
 * dependency is satisfied.
 *
 * Two-valued on purpose. The bypass check used to be a bare
 * `context->>'bypassDepsGate' = 'true'`, which is NULL (not FALSE) whenever the
 * key is absent, so a blocked task's gate evaluated to `NULL OR FALSE = NULL`.
 * The claim WHERE excludes NULL just like FALSE, but the explicit-claim probe
 * read NULL as "not evaluated" and answered "Excluded by a claim filter this
 * diagnosis does not cover" (friction cad81659).
 */
export function depsGate(): SQL {
  return or(
    isNull(tasks.dependsOn),
    sql`${tasks.dependsOn}::jsonb = '[]'::jsonb`,
    bypassFlagCondition(tasks.context, BYPASS_DEPS_GATE_KEY),
    dependenciesSatisfied(),
  )!;
}

/**
 * TRUE when the dependent's creation route inferred the `depId` edge, FALSE
 * otherwise, never NULL. A row with no `inferredDependsOn` key makes the bare
 * `?` NULL, and `dependenciesSatisfied()` reads `NOT (… OR NULL)` as NULL, which
 * drops that dependency from its NOT EXISTS: the arm built on it would release
 * a caller-declared edge whenever the rest of the arm held.
 */
function isInferredEdge(depId: SQL): SQL {
  return sql`COALESCE(${tasks.pathDeclaration}->'inferredDependsOn' ? (${depId})::text, FALSE)`;
}

// Mirrors MISSION_BRANCH_PREFIX in @buildd/core/mission-integration (not imported:
// the module-boundaries ratchet forbids this edge).
const MISSION_BRANCH_LIKE = 'mission/%';

/**
 * TRUE when `depId` is a migration-overlap edge the claim minted itself
 * (`pathDeclaration.inferredDependsOn`) and the dependency's PR targets a
 * different landing base than the dependent will. The edge exists to stop two
 * tasks taking the same migration index on one base. Work landing on another
 * base (a mission integration branch vs trunk, or one mission branch vs
 * another) cannot collide until that base merges, and the index check runs
 * again then (the renumber path), so the dependent is not serialized behind it,
 * whether or not the dependency's PR has merged. Caller-declared edges never
 * qualify, and an unknown base (`pr_base_ref` NULL) keeps the edge closed.
 *
 * The dependent's base is its mission's working branch when the mission uses an
 * integration branch, trunk otherwise. Trunk's name is not in SQL, so "differs"
 * is: the PR base is not the dependent's mission branch, and at least one side
 * is a mission branch.
 */
function migrationEdgeOnOtherBase(depId: SQL): SQL {
  const dependentBranch = sql`(
    SELECT m.working_branch FROM missions m
    WHERE m.id = ${tasks.missionId} AND m.integration_branch_enabled IS TRUE
  )`;
  return sql`(
    ${isInferredEdge(depId)}
    AND EXISTS (
      SELECT 1 FROM ${tasks} t4
      WHERE t4.id = ${depId}
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(COALESCE(t4.path_manifest, '[]'::jsonb)) AS mp
        WHERE mp ~* ${MIGRATION_PATH_RE.source}
      )
    )
    AND EXISTS (
      SELECT 1 FROM ${workers} w4
      WHERE w4.task_id = ${depId}
      AND w4.pr_url IS NOT NULL
      AND w4.pr_base_ref IS NOT NULL
      AND w4.pr_base_ref IS DISTINCT FROM ${dependentBranch}
      AND (w4.pr_base_ref LIKE ${MISSION_BRANCH_LIKE} OR ${dependentBranch} IS NOT NULL)
    )
  )`;
}
