/**
 * Late outcome labels for the decision ledger.
 *
 * A decision record is immutable once written: what was asked, who answered,
 * what was applied. Whether that answer turned out right is known later (the
 * task finished, the PR merged, a person corrected it), by someone other than
 * the call site. That knowledge is its own row in `decision_outcomes`, keyed
 * (decision, source):
 *
 * - the same label from the same source again is a `duplicate` (no write), so
 *   an adapter can relabel on every webhook or sweep without bookkeeping;
 * - a different label from the same source is a `conflict`: the first label
 *   stands and the caller is told, so a flapping adapter shows up instead of
 *   rewriting history;
 * - another source labels independently (`task_terminal` and `human` can
 *   disagree, and the readout picks which source it scores).
 *
 * Labels are the kind's own vocabulary. What a label means for quality is the
 * kind's objective callback in the readout (`decision-readout.ts`), never this
 * module.
 *
 * Labelling by subject (`{ capability, subject }`) labels every record of
 * that kind for the subject: a re-asked decision gets the same outcome.
 */

export interface OutcomeLabelInput {
  teamId: string;
  /** Label one record. */
  decisionRecordId?: string;
  /** Or label every record of this kind for a subject (both required together). */
  capability?: string;
  subject?: { type: string; id: string };
  /** Who labels: an adapter id ('task_terminal', 'pr_merged') or 'human'. */
  source: string;
  label: string;
  value?: number | null;
  metadata?: Record<string, unknown> | null;
  /** When the outcome happened. Default: now. */
  observedAt?: Date;
}

export interface OutcomeRow {
  decisionRecordId: string;
  teamId: string;
  capability: string;
  source: string;
  label: string;
  value: number | null;
  metadata: Record<string, unknown> | null;
  observedAt: Date;
}

export type OutcomeLabelResult =
  | { decisionRecordId: string; status: 'recorded' | 'duplicate' }
  | { decisionRecordId: string; status: 'conflict'; existing: { label: string; value: number | null } };

export type LabelDecisionOutcomeResult =
  | { ok: true; results: OutcomeLabelResult[] }
  | { ok: false; error: 'invalid' | 'not_found' | 'store_failed' };

export interface OutcomeStore {
  /** Records the team owns matching the id, or the kind + subject. */
  findRecords(q: { teamId: string; decisionRecordId?: string; capability?: string; subject?: { type: string; id: string } }): Promise<Array<{ id: string; capability: string }>>;
  /** Insert unless (decision, source) exists. True when inserted. */
  insertOutcome(row: OutcomeRow): Promise<boolean>;
  readOutcome(decisionRecordId: string, source: string): Promise<{ label: string; value: number | null } | null>;
}

const MAX_SUBJECT_RECORDS = 200;

async function dbStore(): Promise<OutcomeStore> {
  // Lazy: the DB client only loads inside the app.
  const { db } = await import('./db/client');
  const { decisionOutcomes, decisionRecords } = await import('./db/schema');
  const { and, eq } = await import('drizzle-orm');
  return {
    async findRecords(q) {
      const clauses = [eq(decisionRecords.teamId, q.teamId)];
      if (q.decisionRecordId) clauses.push(eq(decisionRecords.id, q.decisionRecordId));
      if (q.capability) clauses.push(eq(decisionRecords.capability, q.capability));
      if (q.subject) {
        clauses.push(eq(decisionRecords.subjectType, q.subject.type));
        clauses.push(eq(decisionRecords.subjectId, q.subject.id));
      }
      return db.select({ id: decisionRecords.id, capability: decisionRecords.capability })
        .from(decisionRecords).where(and(...clauses)).orderBy(decisionRecords.createdAt).limit(MAX_SUBJECT_RECORDS);
    },
    async insertOutcome(row) {
      const inserted = await db.insert(decisionOutcomes).values(row)
        .onConflictDoNothing({ target: [decisionOutcomes.decisionRecordId, decisionOutcomes.source] })
        .returning({ id: decisionOutcomes.id });
      return inserted.length > 0;
    },
    async readOutcome(decisionRecordId, source) {
      const [row] = await db.select({ label: decisionOutcomes.label, value: decisionOutcomes.value })
        .from(decisionOutcomes)
        .where(and(eq(decisionOutcomes.decisionRecordId, decisionRecordId), eq(decisionOutcomes.source, source)))
        .limit(1);
      return row ?? null;
    },
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Attach an outcome to one or more decision records. Never throws. */
export async function labelDecisionOutcome(
  input: OutcomeLabelInput,
  deps: { store?: OutcomeStore; now?: () => Date } = {},
): Promise<LabelDecisionOutcomeResult> {
  const source = input.source?.trim();
  const label = input.label?.trim();
  const bySubject = !input.decisionRecordId && !!input.capability && !!input.subject?.type && !!input.subject?.id;
  if (!input.teamId || !source || !label) return { ok: false, error: 'invalid' };
  if (!input.decisionRecordId && !bySubject) return { ok: false, error: 'invalid' };
  if (input.value !== undefined && input.value !== null && !Number.isFinite(input.value)) return { ok: false, error: 'invalid' };
  // A real store would reject a malformed id with a cast error; read it as not found.
  if (input.decisionRecordId && !deps.store && !UUID_RE.test(input.decisionRecordId)) return { ok: false, error: 'not_found' };

  try {
    const store = deps.store ?? await dbStore();
    const records = await store.findRecords({
      teamId: input.teamId,
      ...(input.decisionRecordId ? { decisionRecordId: input.decisionRecordId } : { capability: input.capability, subject: input.subject }),
    });
    if (records.length === 0) return { ok: false, error: 'not_found' };

    const value = input.value ?? null;
    const observedAt = input.observedAt ?? deps.now?.() ?? new Date();
    const results: OutcomeLabelResult[] = [];
    for (const rec of records) {
      const inserted = await store.insertOutcome({
        decisionRecordId: rec.id,
        teamId: input.teamId,
        capability: rec.capability,
        source,
        label,
        value,
        metadata: input.metadata ?? null,
        observedAt,
      });
      if (inserted) {
        results.push({ decisionRecordId: rec.id, status: 'recorded' });
        continue;
      }
      const existing = await store.readOutcome(rec.id, source);
      if (existing && existing.label === label && (existing.value ?? null) === value) {
        results.push({ decisionRecordId: rec.id, status: 'duplicate' });
      } else {
        results.push({ decisionRecordId: rec.id, status: 'conflict', existing: existing ?? { label: '', value: null } });
      }
    }
    return { ok: true, results };
  } catch (err) {
    console.warn('[decision-outcomes] label failed (non-fatal):', (err as Error)?.message ?? err);
    return { ok: false, error: 'store_failed' };
  }
}
