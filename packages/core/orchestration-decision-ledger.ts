/**
 * Capability-filtered read of `orchestration_decisions`. The generic decision
 * ledger (`decision_records`) never holds `orchestration_*` capabilities, so
 * `get_decision_stats capability=orchestration_claim` must read this table or
 * it reports "no evidence" next to hundreds of rows in the unfiltered view.
 * Rows are mapped to the generic ledger's shape (verdict / appliedAnswer /
 * reason) so one summary reads both.
 */
import { and, desc, eq, gte, lt } from 'drizzle-orm';
import { db } from './db/client';
import { orchestrationDecisions } from './db/schema';
import { DECISION_LEDGER_MAX_ROWS, summarizeDecisionLedger } from './decision-ledger';

export const isOrchestrationCapability = (capability?: string | null): capability is string =>
  !!capability && capability.startsWith('orchestration_');

export interface OrchestrationLedgerFilters {
  workspaceId: string;
  capability: string;
  since?: Date;
  until?: Date;
}

export function orchestrationLedgerWhere(f: OrchestrationLedgerFilters) {
  const d = orchestrationDecisions;
  return and(
    eq(d.workspaceId, f.workspaceId), eq(d.capability, f.capability),
    f.since ? gte(d.createdAt, f.since) : undefined,
    f.until ? lt(d.createdAt, f.until) : undefined,
  );
}

type Row = typeof orchestrationDecisions.$inferSelect;

/** `verdict` = what the model suggested; `appliedAnswer` = the answer in effect, only when it was applied. */
export function toLedgerRow(r: Row) {
  return {
    id: r.id, capability: r.capability, decisionId: r.decisionId, mode: r.mode, status: r.status,
    taskId: r.taskId, missionId: r.missionId, workerId: r.workerId,
    verdict: r.suggested, ruleAnswer: r.ruleVerdict, appliedAnswer: r.applied ? r.effective : null,
    effective: r.effective, applied: r.applied, confidence: r.confidence, reason: r.reason,
    experimentArm: r.experimentArm, createdAt: r.createdAt,
  };
}

/** Throws on a store error, like `readDecisionLedgerPage`. */
export async function readOrchestrationDecisionPage(f: OrchestrationLedgerFilters, limit = DECISION_LEDGER_MAX_ROWS) {
  const cap = Math.max(1, Math.min(limit, DECISION_LEDGER_MAX_ROWS));
  const rows = await db.select().from(orchestrationDecisions)
    .where(orchestrationLedgerWhere(f))
    .orderBy(desc(orchestrationDecisions.createdAt))
    .limit(cap + 1);
  return { rows: rows.slice(0, cap).map(toLedgerRow), truncated: rows.length > cap };
}

/** Same summary as the generic ledger, with applied answers kept verbatim (START / HOLD are not free text). */
export function summarizeOrchestrationDecisions(rows: ReturnType<typeof toLedgerRow>[]) {
  const base = summarizeDecisionLedger(rows.map(r => ({ ...r, humanOverride: null })));
  const byAppliedAnswer: Record<string, number> = {};
  for (const r of rows) { const k = r.appliedAnswer ?? 'none'; byAppliedAnswer[k] = (byAppliedAnswer[k] ?? 0) + 1; }
  return { ...base, byAppliedAnswer };
}
