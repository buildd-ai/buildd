/**
 * Shared contract for the human-override ("bypass") flags written into
 * `tasks.context` by `POST /api/tasks/[id]/start`.
 *
 * WHY THIS MODULE EXISTS
 * Every one of these flags is an operator escape hatch for a claim gate, and
 * each one is evaluated TWICE: once in the claim route's SQL prefilter
 * (`context->>'key'`, which always yields *text*) and once in the dispatch
 * loop's TypeScript check (`ctx.key`, which sees the raw JSON value). Before
 * this module the two sides disagreed about what "set" means:
 *
 *   flag                | SQL prefilter        | in-loop / route TS        |
 *   --------------------|----------------------|---------------------------|
 *   bypassDepsGate      | `= 'true'` (both)    | (SQL only)                |
 *   bypassHeldGate      | `= 'true'` (both)    | `=== true \|\| === 'true'`  |
 *   bypassSubjectGate   | `!= 'true'` (both)   | `=== true \|\| === 'true'`  |
 *   bypassStartGate     | never read (dead)    | never read (dead)         |
 *   capExempt           | ABSENT (the bug)     | `=== true` only           |
 *
 * `->>` renders JSON `true` and JSON `"true"` identically as the text `true`,
 * so the SQL side always accepted both forms while `=== true` accepted only
 * one. A writer using the string form would pass the prefilter and then be
 * dropped by the loop — the same prefilter/loop disagreement that made
 * `capExempt` a no-op. One predicate, one SQL builder, both fed from the same
 * key constants, is the fix.
 *
 * Must stay free of DB/schema imports beyond drizzle's `sql` tag so it can be
 * imported by any route without dragging schema into the bundle.
 */

import { sql, type SQL } from 'drizzle-orm';

// ── Keys ──────────────────────────────────────────────────────────────────────

/** Skip the dependency-PR merge gate (`dependenciesSatisfied()`). */
export const BYPASS_DEPS_GATE_KEY = 'bypassDepsGate' as const;
/** Skip the held-mission gate (`missionNotHeld()`). */
export const BYPASS_HELD_GATE_KEY = 'bypassHeldGate' as const;
/** Skip the mission `budget_exhausted` gate (claim-loop mission gate #1). */
export const BYPASS_MISSION_BUDGET_KEY = 'bypassMissionBudget' as const;
/** Let one task run as an extra slot past the workspace concurrency cap. */
export const CAP_EXEMPT_KEY = 'capExempt' as const;

export type BypassFlagKey =
  | typeof BYPASS_DEPS_GATE_KEY
  | typeof BYPASS_HELD_GATE_KEY
  | typeof BYPASS_MISSION_BUDGET_KEY
  | typeof CAP_EXEMPT_KEY;

/**
 * The value forms that count as "set".
 *
 * `true` is what /start writes today; `'true'` is what `context->>key` yields
 * for BOTH the boolean and the string form, so the TS side must accept it too
 * or the two evaluations of the same flag disagree.
 */
export function hasBypassFlag(
  context: Record<string, unknown> | null | undefined,
  key: string,
): boolean {
  const flag = context?.[key];
  return flag === true || flag === 'true';
}

/**
 * SQL transcription of `hasBypassFlag`, for the claim route's prefilter.
 *
 * `COALESCE(ctx->>key,'') = 'true'` is TRUE for JSON `true` and JSON `"true"`
 * and FALSE for a missing context or a missing key — exactly the TS predicate.
 *
 * @param contextColumn the `tasks.context` column reference
 */
export function bypassFlagCondition(contextColumn: unknown, key: BypassFlagKey): SQL {
  return sql`COALESCE(${contextColumn}->>${key}, '') = 'true'`;
}
