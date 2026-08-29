/**
 * Pre-claim subject-liveness gate (§6 of docs/design/task-subject-anchors.md).
 *
 * Filters tasks whose subject PR has been reconciled (dead) before a worker is
 * dispatched. Reads persisted task columns only — zero extra DB calls on the
 * hot path.
 *
 * Two expressions, ONE contract: `subjectLivenessCondition()` (SQL prefilter)
 * and `subjectStillLive()` (in-loop guard) both derive from
 * `lib/subject-gate-contract.ts`, the same anti-drift pattern the dep gate uses
 * (`lib/dep-gate-contract.ts`, PR #1867). Only anchors whose `source` is in
 * SUBJECT_BINDING_SOURCES can make a task unclaimable — a prose mention of a PR
 * is advisory, never mortal (see the contract module for the aeb80f incident).
 */

import { tasks } from '@buildd/core/db/schema';
import { sql, type SQL } from 'drizzle-orm';
import {
  BYPASS_SUBJECT_GATE_KEY,
  SUBJECT_ADVISORY_CONFIDENCE,
  SUBJECT_BINDING_SOURCES,
  SUBJECT_DEAD_RESOLUTION,
  isSubjectDead,
  type SubjectGateFields,
} from '@/lib/subject-gate-contract';

export {
  BYPASS_SUBJECT_GATE_KEY,
  SUBJECT_ADVISORY_CONFIDENCE,
  SUBJECT_BINDING_SOURCES,
  SUBJECT_DEAD_RESOLUTION,
  isSubjectDead,
};

/**
 * SQL eligibility predicate for the subject-liveness gate.
 *
 * A task is eligible (TRUE) unless ALL of these hold:
 *   - subject_kind = 'pull_request' AND subject_pr_number IS NOT NULL
 *   - subject_resolution = 'reconciled' (the sweep declared the PR dead)
 *   - subject_anchor->>'source' ∈ SUBJECT_BINDING_SOURCES
 *   - subject_anchor->>'confidence' != 'derived' (an anchor the filer marked as
 *     inferred is advisory even when its source is structured — an explicitly
 *     passed API subjectAnchor defaults to derived)
 *   - context->>'bypassSubjectGate' is not 'true'
 *
 * The source check is what keeps a *derived* anchor (a PR number scraped from
 * prose or a URL in the description) from silently making a task unclaimable
 * forever. `source` lives only inside the jsonb anchor — there is no relational
 * projection of it — so the predicate reads subject_anchor directly.
 *
 * Inserted into claimableConditions after the held-mission gate and before the
 * dependency gate, per §6 ordering.
 */
export function subjectLivenessCondition(): SQL {
  const bindingSources = sql.join(
    SUBJECT_BINDING_SOURCES.map((s) => sql`${s}`),
    sql`, `,
  );

  return sql`NOT (
    ${tasks.subjectKind} = 'pull_request'
    AND ${tasks.subjectPrNumber} IS NOT NULL
    AND ${tasks.subjectResolution} = ${SUBJECT_DEAD_RESOLUTION}
    AND COALESCE(${tasks.subjectAnchor}->>'source', '') IN (${bindingSources})
    AND COALESCE(${tasks.subjectAnchor}->>'confidence', '') != ${SUBJECT_ADVISORY_CONFIDENCE}
    AND COALESCE(${tasks.context}->>${BYPASS_SUBJECT_GATE_KEY}, '') != 'true'
  )`;
}

/**
 * Per-task in-loop liveness check. Reads persisted task columns only.
 *
 * Returns false ONLY when the subject gate genuinely makes the task
 * unclaimable — identical rule to `subjectLivenessCondition()` above, via the
 * shared `isSubjectDead()` predicate.
 *
 * NOTE: `subjectAnchor` must be selected by the query feeding this function.
 * An unselected column reads as `undefined`, which the contract treats as
 * advisory (fail open) rather than binding, so a missing column can never make
 * a task silently unclaimable — but it would also drop the legitimate block.
 * The claim route's candidate query selects all task columns.
 */
export function subjectStillLive(task: SubjectGateFields): boolean {
  return !isSubjectDead(task);
}
