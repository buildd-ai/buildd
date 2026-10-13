/**
 * Implicit human corrections of applied decisions.
 *
 * People correct decisions all the time without ever opening the override
 * route: they change the role a role pick filled, or tap the other button on
 * a strand card. Each of those write paths calls `labelHumanCorrection` once
 * the user's change is written. It finds the decision row that applied the
 * value being replaced and records:
 *
 *  - `decision_records.human_override` (`recordHumanOverride`), so the
 *    feature health override rate counts it, and
 *  - a `decision_outcomes` row, source `human`, label `overridden` (the same
 *    label the explicit override route writes), with the corrected answer in
 *    `metadata.answer`.
 *
 * Only a change of the value a decision actually applied counts: no applied
 * row, or a row that applied something else, writes nothing. A correction is
 * observational (it is not proof the original answer was wrong). Never throws
 * and never blocks the user's change: callers run it after their write.
 *
 * Decisions in `orchestration_decisions` (start anyway on a held task,
 * ordering) cannot be labelled here: `decision_outcomes` references
 * `decision_records` only.
 */
import { labelDecisionOutcome } from './decision-outcomes';

export const HUMAN_CORRECTION_SOURCE = 'human';
export const HUMAN_CORRECTION_LABEL = 'overridden';

export interface HumanCorrectionInput {
  teamId: string;
  /** `decision_records.capability` of the decision being corrected. */
  capability: string;
  /** The decision row, when the caller already has it. */
  decisionRecordId?: string;
  /** Or the task it decided for: the latest applied row for this task. */
  taskId?: string;
  /** The value before the person's change; must be what the decision applied. */
  from: string | null;
  to: string;
  /** User or account id; null when unknown (the override column needs one). */
  by: string | null;
  at?: Date;
}

export interface HumanCorrectionDeps {
  findApplied?: (q: { teamId: string; capability: string; taskId?: string; decisionRecordId?: string }) => Promise<{ id: string; appliedAnswer: string | null } | null>;
  recordOverride?: (decisionRecordId: string, override: Record<string, unknown>, by: string) => Promise<void>;
  label?: typeof labelDecisionOutcome;
}

export type HumanCorrectionResult = 'labelled' | 'no_decision' | 'not_a_correction' | 'failed';

async function dbFindApplied(q: { teamId: string; capability: string; taskId?: string; decisionRecordId?: string }) {
  const { db } = await import('./db/client');
  const { decisionRecords } = await import('./db/schema');
  const { and, desc, eq } = await import('drizzle-orm');
  const [row] = await db
    .select({ id: decisionRecords.id, appliedAnswer: decisionRecords.appliedAnswer })
    .from(decisionRecords)
    .where(and(
      eq(decisionRecords.teamId, q.teamId),
      eq(decisionRecords.capability, q.capability),
      eq(decisionRecords.applied, true),
      q.decisionRecordId ? eq(decisionRecords.id, q.decisionRecordId) : eq(decisionRecords.taskId, q.taskId!),
    ))
    .orderBy(desc(decisionRecords.createdAt))
    .limit(1);
  return row ?? null;
}

export async function labelHumanCorrection(input: HumanCorrectionInput, deps: HumanCorrectionDeps = {}): Promise<HumanCorrectionResult> {
  if (!input.from || input.from === input.to || (!input.taskId && !input.decisionRecordId)) return 'not_a_correction';
  try {
    const row = await (deps.findApplied ?? dbFindApplied)({
      teamId: input.teamId, capability: input.capability, taskId: input.taskId, decisionRecordId: input.decisionRecordId,
    });
    if (!row || row.appliedAnswer !== input.from) return 'no_decision';
    const correction = { answer: input.to, from: input.from, implicit: true };
    if (input.by) {
      const record = deps.recordOverride ?? (await import('./decision-ledger')).recordHumanOverride;
      await record(row.id, correction, input.by);
    }
    const res = await (deps.label ?? labelDecisionOutcome)({
      teamId: input.teamId,
      decisionRecordId: row.id,
      source: HUMAN_CORRECTION_SOURCE,
      label: HUMAN_CORRECTION_LABEL,
      metadata: correction,
      observedAt: input.at ?? new Date(),
    });
    return res.ok ? 'labelled' : 'failed';
  } catch (err) {
    console.warn('[decision-correction] label failed (non-fatal):', (err as Error)?.message ?? err);
    return 'failed';
  }
}
