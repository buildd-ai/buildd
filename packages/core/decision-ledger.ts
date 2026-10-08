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
import { and, desc, eq, gte, inArray, isNotNull, lt, ne, sql } from 'drizzle-orm';
import { db } from './db/client';
import { decisionChallengerRuns, decisionOutcomes, decisionRecords } from './db/schema';
import type { ChallengerRun } from '@builddai/ai-kit/decide';

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
  /** Decision-kind fields (decision-policy.ts). Omitted by call sites that predate kinds. */
  policyVersion?: string | null;
  provider?: string | null;
  attemptCount?: number | null;
  escalated?: boolean;
  failureClass?: 'capability' | 'key' | 'provider' | null;
  subjectType?: string | null;
  subjectId?: string | null;
  /** Only from experiment-randomizer.ts `assignExperimentArm`; the readout's causal lift reads nothing else. */
  experimentId?: string | null;
  experimentArm?: string | null;
  propensity?: number | null;
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
    policyVersion: input.policyVersion ?? null,
    provider: input.provider ?? null,
    attemptCount: input.attemptCount ?? null,
    escalated: input.escalated ?? false,
    failureClass: input.failureClass ?? null,
    subjectType: input.subjectType ?? null,
    subjectId: input.subjectId ?? null,
    experimentId: input.experimentId ?? null,
    experimentArm: input.experimentArm ?? null,
    propensity: input.propensity ?? null,
    humanOverride: null as Record<string, unknown> | null,
    overriddenAt: null as Date | null,
    overriddenBy: null as string | null,
  };
}

/** Insert one row; resolves to its id when the store reports one. */
export type InsertDecisionRow = (row: ReturnType<typeof rowFromRecord>) => Promise<string | null | void>;

async function dbInsertDecisionRow(row: ReturnType<typeof rowFromRecord>): Promise<string | null> {
  const [inserted] = await db.insert(decisionRecords).values(row).returning({ id: decisionRecords.id });
  return inserted?.id ?? null;
}

/**
 * Persist one decision-call attempt. Never throws; a failed insert costs a
 * row, not the caller. Resolves to the row id (null on failure), which is what
 * a challenger run or an outcome label attaches to.
 */
export async function recordDecision(input: DecisionLedgerInput, deps: { insert?: InsertDecisionRow } = {}): Promise<string | null> {
  try {
    return (await (deps.insert ?? dbInsertDecisionRow)(rowFromRecord(input))) ?? null;
  } catch (err) {
    console.warn('[decision-ledger] insert failed (non-fatal):', (err as Error)?.message ?? err);
    return null;
  }
}

/** A challenger run (ai-kit `runChallenger`) against a recorded decision. */
export interface ChallengerRunInput {
  decisionRecordId: string;
  teamId: string;
  capability: string;
  /** Stable id of the challenger config, e.g. `openrouter/acme/rich-1`. One row per (decision, key). */
  challengerKey: string;
  run: ChallengerRun;
}

export function challengerRowFromRun(input: ChallengerRunInput) {
  const a = input.run.attempt;
  return {
    decisionRecordId: input.decisionRecordId,
    teamId: input.teamId,
    capability: input.capability,
    challengerKey: input.challengerKey,
    status: input.run.status,
    skipReason: input.run.skipReason,
    provider: a?.provider ?? null,
    model: a?.model ?? null,
    modelVersion: a?.modelVersion ?? null,
    outcome: a?.outcome ?? null,
    decision: a?.decision ?? null,
    confidence: a?.confidence ?? null,
    appliedAnswer: input.run.appliedDecision,
    agrees: input.run.agrees,
    failureKind: a?.failure?.kind ?? null,
    latencyMs: a ? Math.round(a.latencyMs) : null,
    costUsd: a?.usage.costUsd ?? null,
  };
}

export type InsertChallengerRow = (row: ReturnType<typeof challengerRowFromRun>) => Promise<void>;

async function dbInsertChallengerRow(row: ReturnType<typeof challengerRowFromRun>): Promise<void> {
  await db.insert(decisionChallengerRuns).values(row)
    .onConflictDoNothing({ target: [decisionChallengerRuns.decisionRecordId, decisionChallengerRuns.challengerKey] });
}

/** Persist a challenger run. Idempotent per (decision, challenger key). Never throws. */
export async function recordChallengerRun(input: ChallengerRunInput, deps: { insert?: InsertChallengerRow } = {}): Promise<void> {
  try {
    await (deps.insert ?? dbInsertChallengerRow)(challengerRowFromRun(input));
  } catch (err) {
    console.warn('[decision-ledger] challenger insert failed (non-fatal):', (err as Error)?.message ?? err);
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

/**
 * The review read: one page of a window, newest first, with each row's late
 * outcome labels. Unlike `queryDecisionLedger` this THROWS on a store error:
 * a weekly review must tell "the read failed" from "nothing was decided", and
 * an error that reads as an empty page is exactly the blind spot it cannot
 * afford. `truncated` says more rows match; continue with `until` set to the
 * oldest row's `createdAt`.
 */
export async function readDecisionLedgerPage(f: DecisionLedgerFilters, limit = DECISION_LEDGER_MAX_ROWS) {
  const cap = Math.max(1, Math.min(limit, DECISION_LEDGER_MAX_ROWS));
  const rows = await db.select().from(decisionRecords)
    .where(decisionLedgerWhere(f))
    .orderBy(desc(decisionRecords.createdAt))
    .limit(cap + 1);
  const page = rows.slice(0, cap);
  const outcomes = page.length
    ? await db.select({
      decisionRecordId: decisionOutcomes.decisionRecordId,
      source: decisionOutcomes.source,
      label: decisionOutcomes.label,
      value: decisionOutcomes.value,
      observedAt: decisionOutcomes.observedAt,
    }).from(decisionOutcomes).where(and(
      eq(decisionOutcomes.teamId, f.teamId),
      inArray(decisionOutcomes.decisionRecordId, page.map(r => r.id)),
    ))
    : [];
  return { rows: page, outcomes, truncated: rows.length > cap };
}

type SummaryRow = Pick<typeof decisionRecords.$inferSelect, 'status' | 'verdict' | 'appliedAnswer' | 'reason' | 'humanOverride' | 'confidence'>;

/**
 * Counts a reviewer reads before the rows: by status, by the model's verdict
 * (for the question gate, its decide / hold / ask disposition), by the answer
 * in effect, by reason, and how many a human later overrode. Free-text
 * applied answers (a decided option's label) count under `decided_option`, so
 * the summary never carries question content.
 */
export function summarizeDecisionLedger(rows: readonly SummaryRow[], outcomeCount = 0) {
  const tally = (key: (r: SummaryRow) => string | null | undefined) => {
    const out: Record<string, number> = {};
    for (const r of rows) { const k = key(r) ?? 'none'; out[k] = (out[k] ?? 0) + 1; }
    return out;
  };
  const KNOWN_ANSWERS = new Set(['hold', 'ask']);
  const confident = rows.filter(r => typeof r.confidence === 'number');
  return {
    total: rows.length,
    byStatus: tally(r => r.status),
    byVerdict: tally(r => r.verdict),
    byAppliedAnswer: tally(r => r.appliedAnswer == null ? null : KNOWN_ANSWERS.has(r.appliedAnswer) ? r.appliedAnswer : 'decided_option'),
    byReason: tally(r => r.reason),
    overridden: rows.filter(r => r.humanOverride != null).length,
    outcomeLabels: outcomeCount,
    meanConfidence: confident.length ? Number((confident.reduce((a, r) => a + (r.confidence as number), 0) / confident.length).toFixed(3)) : null,
  };
}
