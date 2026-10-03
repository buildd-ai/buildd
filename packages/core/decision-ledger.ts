/**
 * The decision ledger (knowledge-base: buildd/design/decision-calls.md "The
 * decision ledger"). One row per decision-call attempt for a capability that
 * is not already covered by its own specialized table — orchestration's
 * hold/start and manifest decisions keep writing to `orchestration_decisions`
 * (packages/core/orchestration-ledger-source.ts), which this table does not
 * replace.
 *
 * This is the record that replaces "shadow mode" as the audit trail: every
 * decision ships applying (behind its rails and confidence threshold) from
 * its first PR, and this is where its outcome is read back for a weekly
 * review instead of from a console log line.
 *
 * Split the same way orchestration-ledger-source.ts is: predicates are
 * exported functions so a test can render the real dialect against a mocked
 * db, which cannot see a WHERE clause otherwise.
 */
import { and, desc, eq, gte, isNotNull, lt, ne, sql } from 'drizzle-orm';
import { db } from './db/client';
import { decisionRecords } from './db/schema';

export interface DecisionLedgerInput {
  teamId: string;
  workspaceId?: string | null;
  missionId?: string | null;
  taskId?: string | null;
  capability: string;
  /** A hash of the inputs the model actually saw. */
  fingerprint: string;
  promptVersion?: string | null;
  model?: string | null;
  minConfidence?: number | null;
  /** The deterministic rule's answer, or null where the site has no prior rule. */
  ruleAnswer?: string | null;
  /** What Jev answered. Null on a failed/fallback call. */
  verdict?: string | null;
  confidence?: number | null;
  /** The answer actually in effect: the rule's on fallback, Jev's when applied. */
  appliedAnswer?: string | null;
  applied: boolean;
  status: 'applied' | 'suggested' | 'fallback';
  reason?: string | null;
  latencyMs?: number | null;
  inputTokens?: number | null;
  costUsd?: number | null;
}

/** Coerce every optional to an explicit null, so a test can assert on the full row. */
export function rowFromRecord(input: DecisionLedgerInput) {
  return {
    teamId: input.teamId,
    workspaceId: input.workspaceId ?? null,
    missionId: input.missionId ?? null,
    taskId: input.taskId ?? null,
    capability: input.capability,
    fingerprint: input.fingerprint,
    promptVersion: input.promptVersion ?? null,
    model: input.model ?? null,
    minConfidence: input.minConfidence ?? null,
    ruleAnswer: input.ruleAnswer ?? null,
    verdict: input.verdict ?? null,
    confidence: input.confidence ?? null,
    appliedAnswer: input.appliedAnswer ?? null,
    applied: input.applied,
    status: input.status,
    reason: input.reason ?? null,
    latencyMs: input.latencyMs ?? null,
    inputTokens: input.inputTokens ?? null,
    costUsd: input.costUsd ?? null,
    humanOverride: null as Record<string, unknown> | null,
    overriddenAt: null as Date | null,
    overriddenBy: null as string | null,
  };
}

export type InsertDecisionRow = (row: ReturnType<typeof rowFromRecord>) => Promise<void>;

async function dbInsertDecisionRow(row: ReturnType<typeof rowFromRecord>): Promise<void> {
  await db.insert(decisionRecords).values(row);
}

/** Persist one decision-call attempt. Never throws; a failed insert costs a row, not the caller. */
export async function recordDecision(input: DecisionLedgerInput, deps: { insert?: InsertDecisionRow } = {}): Promise<void> {
  try {
    await (deps.insert ?? dbInsertDecisionRow)(rowFromRecord(input));
  } catch (err) {
    console.warn('[decision-ledger] insert failed (non-fatal):', (err as Error)?.message ?? err);
  }
}

/** Record a human correcting an already-applied (or suggested) verdict. Never throws. */
export async function recordHumanOverride(
  decisionRecordId: string,
  override: Record<string, unknown>,
  overriddenBy: string,
  deps: { now?: () => Date } = {},
): Promise<void> {
  try {
    await db.update(decisionRecords)
      .set({ humanOverride: override, overriddenAt: deps.now?.() ?? new Date(), overriddenBy })
      .where(eq(decisionRecords.id, decisionRecordId));
  } catch (err) {
    console.warn('[decision-ledger] override insert failed (non-fatal):', (err as Error)?.message ?? err);
  }
}

export interface DecisionLedgerFilters {
  teamId: string;
  workspaceId?: string | null;
  capability?: string | null;
  since?: Date;
  until?: Date;
  /** Only rows where the final answer differs from what the deterministic rule would have given. */
  disagreementOnly?: boolean;
  /** Only rows a human later corrected. */
  overriddenOnly?: boolean;
}

/** The WHERE clause for a ledger read, rendered so a test can assert on the real dialect. */
export function decisionLedgerWhere(f: DecisionLedgerFilters) {
  const clauses = [eq(decisionRecords.teamId, f.teamId)];
  if (f.workspaceId) clauses.push(eq(decisionRecords.workspaceId, f.workspaceId));
  if (f.capability) clauses.push(eq(decisionRecords.capability, f.capability));
  if (f.since) clauses.push(gte(decisionRecords.createdAt, f.since));
  if (f.until) clauses.push(lt(decisionRecords.createdAt, f.until));
  if (f.disagreementOnly) {
    clauses.push(isNotNull(decisionRecords.ruleAnswer));
    clauses.push(isNotNull(decisionRecords.appliedAnswer));
    clauses.push(ne(decisionRecords.ruleAnswer, sql`${decisionRecords.appliedAnswer}`));
  }
  if (f.overriddenOnly) clauses.push(isNotNull(decisionRecords.humanOverride));
  return and(...clauses);
}

export const DECISION_LEDGER_MAX_ROWS = 500;

/** Read a window of decision records for one team, newest first. Never throws; an error reads as an empty page. */
export async function queryDecisionLedger(f: DecisionLedgerFilters, limit = DECISION_LEDGER_MAX_ROWS) {
  try {
    return await db.select().from(decisionRecords)
      .where(decisionLedgerWhere(f))
      .orderBy(desc(decisionRecords.createdAt))
      .limit(Math.min(limit, DECISION_LEDGER_MAX_ROWS));
  } catch (err) {
    console.warn('[decision-ledger] query failed (non-fatal, empty page):', (err as Error)?.message ?? err);
    return [];
  }
}
