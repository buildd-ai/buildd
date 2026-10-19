/**
 * The SQL of the PR fact funnel (`pr-facts.ts`): the terminal-wins guard, the
 * column assignments, the kernel transition's projection, and the scope brand.
 * Its own module, beside the funnel, so a test that replaces `pr-facts` with a
 * stub still loads the kernel that embeds the projection. Writers of
 * `workers.pr_lifecycle_status` / `merged_at` are this file and `pr-facts.ts`
 * only (the write-site guards).
 */
import { sql, type SQL } from 'drizzle-orm';
import type { PrFact, PrFactBookkeeping } from './pr-facts';

export type TerminalPrFactKind = 'merged' | 'closed';
export type NonTerminalPrFactKind = 'open' | 'ci' | 'conflict' | 'unresolvable';

/** Brand of a scope. Referenced only here and in the kernel (the S4a write-site guard). */
export const PR_FACT_SCOPE: unique symbol = Symbol.for('buildd.pr-fact-scope');

/**
 * Which rows a fact may reach. Every fact carries one. Mint one only in the
 * kernel (`pr-fact-scope.ts`); `unscopedPrFactScope` is for an operator script
 * that cannot import it, and is listed by the guard.
 *
 *  - `where(kind)`: for a terminal fact, an extra predicate on the funnel's `w`
 *    (workers) alias, or null for none. A row outside it is not touched.
 *  - `defers(kind)`: for a non-terminal fact, the rows whose column is the
 *    kernel transition's projection (kernel.ts `w_live`), or null for none. A
 *    deferred row is reported back (`deferred: true`), so a caller's side
 *    effects still see a fact that is new for it, and is never written.
 */
export interface PrFactScope {
  readonly [PR_FACT_SCOPE]: string;
  where(kind: TerminalPrFactKind): SQL | null;
  defers?(kind: NonTerminalPrFactKind): SQL | null;
}

/** A scope with no predicate and nothing deferred: every targeted row, as before S4a. The reason names who needs it. */
export function unscopedPrFactScope(reason: string): PrFactScope {
  return { [PR_FACT_SCOPE]: `unscoped:${reason}`, where: () => null };
}

/** Statuses after which no CI, conflict or open fact applies (the reconcile terminal set). */
export const CLOSED_OR_UNRESOLVABLE = ['merged', 'closed', 'unresolvable'] as const;

const inList = (values: readonly string[]): SQL => sql.join(values.map((v) => sql`${v}::text`), sql`, `);
const statusNotIn = (values: readonly string[]): SQL => sql`(w.pr_lifecycle_status IS NULL OR w.pr_lifecycle_status NOT IN (${inList(values)}))`;

/** Terminal-wins, in the WHERE clause (§12). */
export function guardSql(f: PrFact): SQL {
  switch (f.kind) {
    case 'merged':
      return sql`(w.merged_at IS NULL OR w.pr_lifecycle_status IS DISTINCT FROM 'merged')`;
    case 'closed':
      return sql`w.merged_at IS NULL AND ${statusNotIn(['merged', 'closed'])}`;
    case 'open':
      return f.reopened
        ? sql`w.merged_at IS NULL AND ${statusNotIn(['merged'])}`
        : sql`w.merged_at IS NULL AND ${statusNotIn(['merged', 'closed'])}`;
    case 'ci':
      return sql`w.merged_at IS NULL AND ${statusNotIn([...CLOSED_OR_UNRESOLVABLE, f.status])}`;
    case 'conflict':
      return sql`w.merged_at IS NULL AND ${statusNotIn(CLOSED_OR_UNRESOLVABLE)}`;
    case 'unresolvable':
      return sql`w.merged_at IS NULL AND ${statusNotIn(['merged', 'closed', 'unresolvable'])}`;
  }
}

export function setSql(f: PrFact, b: PrFactBookkeeping): SQL {
  const sets: SQL[] = [sql`updated_at = now()`];
  switch (f.kind) {
    case 'merged':
      sets.push(sql`pr_lifecycle_status = 'merged'`, sql`merged_at = COALESCE(w.merged_at, ${new Date(f.mergedAt).toISOString()}::timestamptz)`);
      break;
    case 'closed': sets.push(sql`pr_lifecycle_status = 'closed'`); break;
    case 'open': sets.push(sql`pr_lifecycle_status = 'pr_open'`); break;
    case 'ci': sets.push(sql`pr_lifecycle_status = ${f.status}::text`); break;
    case 'conflict':
      sets.push(sql`pr_lifecycle_status = 'conflict'`, sql`conflict_detected_at = COALESCE(w.conflict_detected_at, now())`);
      break;
    case 'unresolvable':
      sets.push(sql`pr_lifecycle_status = 'unresolvable'`, sql`pr_unresolvable_reason = ${f.reason}::text`);
      break;
  }
  if (b.prLastCheckedAt) sets.push(sql`pr_last_checked_at = ${b.prLastCheckedAt.toISOString()}::timestamptz`);
  if (b.prLastVerifiedAt) sets.push(sql`pr_last_verified_at = ${b.prLastVerifiedAt.toISOString()}::timestamptz`);
  if (b.prCheckFailureCount !== undefined) sets.push(sql`pr_check_failure_count = ${b.prCheckFailureCount}::int`);
  if (b.prIsDraft !== undefined) sets.push(sql`pr_is_draft = ${b.prIsDraft}::boolean`);
  return sql.join(sets, sql`, `);
}

/**
 * The kernel transition's projection of a merge or close onto the worker rows
 * of its PR (S4a): an UPDATE the transition embeds as one of its CTEs, so the
 * delivery and the rows move in one statement. `from` / `where` name the
 * delivery CTE and how a row belongs to it; `mergedAt` is the instant to keep
 * (the delivery's `merged_at`, `now()` when GitHub gave none). Same terminal-wins
 * guard and assignments as `recordPrFact`; no bookkeeping.
 */
export function prFactProjectionSql(
  fact: { kind: TerminalPrFactKind },
  at: { from: SQL; where: SQL; mergedAt?: SQL },
): SQL {
  const f: PrFact = fact.kind === 'merged' ? { kind: 'merged', mergedAt: new Date(0) } : { kind: 'closed' };
  const sets = fact.kind === 'merged'
    ? sql`updated_at = now(), pr_lifecycle_status = 'merged', merged_at = COALESCE(w.merged_at, ${at.mergedAt ?? sql`NULL`}, now())`
    : setSql(f, {});
  return sql`UPDATE workers w SET ${sets}
FROM ${at.from}
WHERE ${at.where} AND ${guardSql(f)}
RETURNING w.id`;
}


/** Delivery states whose worker rows T17 / T18 own (or nobody moves again): the live projection leaves them alone. */
const NOT_LIVE = ['MERGED', 'CLOSED_UNMERGED', 'SUPERSEDED', 'ABANDONED', 'FAILED'] as const;

/**
 * AC-1, the non-terminal half: every other kernel transition projects the PR's
 * live status onto its worker rows, in the transition's own statement, from
 * the delivery's own readings at its current head. Dirty mergeability is a
 * conflict, then a red or green CI verdict, else the PR is open (no verdict on
 * this head yet, or a red a re-run withdrew). `conflict_detected_at` stays
 * first-seen. `from` / `where` name the delivery CTE (aliased `d`, carrying
 * `state`, `ci`, `ci_head_sha`, `mergeable`, `mergeable_head_sha`,
 * `current_head_sha`) and how a row belongs to it. A merged row is never moved,
 * and a row already saying it is not rewritten.
 */
export function prLiveProjectionSql(at: { from: SQL; where: SQL }): SQL {
  const status = sql`(CASE
    WHEN d.mergeable = 'dirty' AND d.mergeable_head_sha = d.current_head_sha THEN 'conflict'
    WHEN d.ci = 'red' AND d.ci_head_sha = d.current_head_sha THEN 'ci_failed'
    WHEN d.ci = 'green' AND d.ci_head_sha = d.current_head_sha THEN 'ci_green'
    ELSE 'pr_open' END)`;
  return sql`UPDATE workers w SET updated_at = now(), pr_lifecycle_status = ${status},
  conflict_detected_at = CASE WHEN ${status} = 'conflict' THEN COALESCE(w.conflict_detected_at, now()) ELSE w.conflict_detected_at END
FROM ${at.from}
WHERE ${at.where} AND d.state NOT IN (${inList(NOT_LIVE)})
  AND w.merged_at IS NULL AND w.pr_lifecycle_status IS DISTINCT FROM 'merged'
  AND w.pr_lifecycle_status IS DISTINCT FROM ${status}
RETURNING w.id`;
}
