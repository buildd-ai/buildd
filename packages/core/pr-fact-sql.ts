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

/** Brand of a scope. Referenced only here and in the kernel (the S4a write-site guard). */
export const PR_FACT_SCOPE: unique symbol = Symbol.for('buildd.pr-fact-scope');

/**
 * Which rows a terminal fact may reach. `where(kind)` is an extra predicate on
 * the funnel's `w` (workers) alias, or null for none. Mint one only in the
 * kernel (`pr-fact-scope.ts`); `unscopedPrFactScope` is for an operator script
 * that cannot import it, and is listed by the guard.
 */
export interface PrFactScope {
  readonly [PR_FACT_SCOPE]: string;
  where(kind: TerminalPrFactKind): SQL | null;
}

/** A scope with no predicate: every targeted row, as before S4a. The reason names who needs it. */
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

