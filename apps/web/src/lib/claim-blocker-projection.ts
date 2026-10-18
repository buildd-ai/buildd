/**
 * Health's blocker projection from the claim scheduler's recorded decisions
 * (spec 97b1bd0b R-10). The claim loop writes every refusal to `gate_events`
 * (`claim_loop_deferral`); this turns the newest one per task into what Health
 * may say about it, instead of re-deriving "blocked" from the configured
 * backend or a stored credential.
 *
 * Three states, never conflated:
 *   - `blocked`: the loop refused the task recently; `reason`/`phrase` say why.
 *   - `stale`:   the newest refusal is old enough that it may no longer hold.
 *     Shown with its time, never as a current block.
 *   - `unknown`: no decision on record. Health does not call it blocked.
 *
 * Pure, so the rule is testable without a database; the loader is in
 * `loadClaimBlockers`.
 */
import { db } from '@buildd/core/db';
import { gateEvents } from '@buildd/core/db/schema';
import { and, desc, eq, gt, inArray } from 'drizzle-orm';
import { sqlOrderBy, sqlWhere } from '@buildd/core/db/relational-sql';
import { GATE_SLUGS } from './gate-ledger';
import { claimHoldPhrase } from './claim-hold-phrase';

// Mirror `DEFERRAL_FRESHNESS_MS` and `CLAIM_HOLD_WINDOW_MS` in mission-claim-deferrals.ts.
// Not imported: core may not import a module (scripts/module-boundaries.test.ts).
const DEFERRAL_FRESHNESS_MS = 15 * 60 * 1000;
const CLAIM_HOLD_WINDOW_MS = 6 * 60 * 60 * 1000;

export type ClaimBlockerState = 'blocked' | 'stale' | 'unknown';

export interface ClaimBlocker {
  state: ClaimBlockerState;
  /** The scheduler's own reason slug, when a decision is on record. */
  reason: string | null;
  /** Words for `reason`; null when the reason is not one Health has words for. */
  phrase: string | null;
  /** ISO time the scheduler last recorded this decision; null when unknown. */
  evaluatedAt: string | null;
}

export interface ClaimDecisionRow {
  taskId: string | null;
  reason: string;
  occurredAt: Date | string;
}

/** Refusals that only concern one backend; they say nothing about a task routed elsewhere. */
const BACKEND_SPECIFIC_REASONS: Readonly<Record<string, string>> = { codex_single_flight: 'codex' };

const UNKNOWN: ClaimBlocker = { state: 'unknown', reason: null, phrase: null, evaluatedAt: null };

/** Pure: one task's blocker from its newest recorded decision. */
export function projectClaimBlocker(
  row: { reason: string; occurredAt: Date | string } | null | undefined,
  now: number = Date.now(),
  /** The backend the task now routes to; a refusal for another backend is stale, not current. */
  effectiveBackend?: string | null,
): ClaimBlocker {
  if (!row) return UNKNOWN;
  const at = new Date(row.occurredAt);
  if (Number.isNaN(at.getTime())) return UNKNOWN;
  const forOtherBackend = !!effectiveBackend
    && BACKEND_SPECIFIC_REASONS[row.reason] !== undefined
    && BACKEND_SPECIFIC_REASONS[row.reason] !== effectiveBackend;
  return {
    state: !forOtherBackend && now - at.getTime() <= DEFERRAL_FRESHNESS_MS ? 'blocked' : 'stale',
    reason: row.reason,
    phrase: claimHoldPhrase(row.reason),
    evaluatedAt: at.toISOString(),
  };
}

/** Pure: newest decision per task from rows ordered newest first. */
export function projectClaimBlockers(
  taskIds: readonly string[],
  rows: readonly ClaimDecisionRow[],
  now: number = Date.now(),
  effectiveBackends?: ReadonlyMap<string, string>,
): Map<string, ClaimBlocker> {
  const newest = new Map<string, ClaimDecisionRow>();
  for (const r of rows) if (r.taskId && !newest.has(r.taskId)) newest.set(r.taskId, r);
  return new Map(taskIds.map(id => [id, projectClaimBlocker(newest.get(id), now, effectiveBackends?.get(id))]));
}

/**
 * Blockers for pending tasks. A failed read yields `unknown` for every task,
 * never a guessed block.
 */
export async function loadClaimBlockers(
  taskIds: readonly string[],
  effectiveBackends?: ReadonlyMap<string, string>,
): Promise<Map<string, ClaimBlocker>> {
  if (taskIds.length === 0) return new Map();
  try {
    const rows = await db.query.gateEvents.findMany({
      where: sqlWhere(and(
        inArray(gateEvents.taskId, [...taskIds]),
        eq(gateEvents.gate, GATE_SLUGS.CLAIM_LOOP_DEFERRAL),
        inArray(gateEvents.outcome, ['deferred', 'stranded']),
        gt(gateEvents.occurredAt, new Date(Date.now() - CLAIM_HOLD_WINDOW_MS)),
      )),
      orderBy: sqlOrderBy([desc(gateEvents.occurredAt)]),
      limit: Math.min(500, taskIds.length * 20),
      columns: { taskId: true, reason: true, occurredAt: true },
    });
    return projectClaimBlockers(taskIds, rows, Date.now(), effectiveBackends);
  } catch {
    return projectClaimBlockers(taskIds, []);
  }
}
