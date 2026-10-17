/**
 * Writes the spec decisions' outcome labels (lib/spec-decision-gold.ts) into
 * `decision_outcomes`, one source per kind, from events after the call. Run
 * daily from the orchestration readout cron.
 *
 * - Duplicate check (source `spec_duplicate_followup`): a model `duplicate`
 *   with an author override on its ledger row is labelled from the override; a
 *   warned duplicate, or a `distinct`, is matched to the spec created right
 *   after the check (its first revision's card hashes to the pair's subject)
 *   and read from that spec's retirement record.
 * - Area filing (source `spec_area_followup`): the filing row the decision
 *   made (`spec_filings.decision_record_id`), its status and where the spec
 *   sits now.
 *
 * Idempotent: a graded record is not listed again, and `labelDecisionOutcome`
 * keeps the first label per (decision, source). An unknown writes nothing and
 * is retried until it ages out of the lookback. Ids, labels and times only.
 * Never throws.
 */
import { labelDecisionOutcome } from '@buildd/core/decision-outcomes';
import { sql } from 'drizzle-orm';
import {
  SPEC_AREA_GOLD_SOURCE,
  SPEC_AREA_KIND_ID,
  SPEC_DUPLICATE_GOLD_SOURCE,
  SPEC_DUPLICATE_KIND_ID,
  SPEC_GOLD_LOOKBACK_MS,
  gradeAreaFiling,
  gradeDuplicateDecision,
} from './spec-decision-gold';

export const SPEC_GRADING_LIMIT = 500;
/** The spec a check led to is created in the same request, so it appears right after the ledger row. */
export const NEW_SPEC_WINDOW_MS = 10 * 60 * 1000;

export interface UngradedDuplicate {
  id: string;
  teamId: string;
  workspaceId: string | null;
  verdict: string | null;
  /** `<named spec id>:<new card hash>`. */
  subjectId: string | null;
  createdAt: Date;
  override: string | null;
}

export interface UngradedAreaFiling {
  decisionRecordId: string;
  teamId: string;
  kind: string;
  status: string;
  createdAt: Date;
  resolvedAt: Date | null;
  filedParentId: string | null;
  currentParentId: string | null;
}

export interface SpecGradingStore {
  listUngradedDuplicates(opts: { since: Date; limit: number }): Promise<UngradedDuplicate[]>;
  /** The spec created in the workspace in `[from, to]` whose first revision hashes to `cardHash`. */
  findNewSpec(q: { workspaceId: string; from: Date; to: Date; cardHash: string }): Promise<{ id: string; createdAt: Date } | null>;
  /** The spec that replaced `specId` (its newest status change says superseded), with that spec's creation time. */
  findSupersededBy(specId: string): Promise<{ id: string; createdAt: Date; at: Date } | null>;
  listUngradedAreaFilings(opts: { since: Date; limit: number }): Promise<UngradedAreaFiling[]>;
}

export interface SpecGradingResult {
  scanned: number;
  labelled: number;
  duplicates: number;
  conflicts: number;
  unknown: Record<string, number>;
  errors: number;
}

const emptyResult = (): SpecGradingResult => ({ scanned: 0, labelled: 0, duplicates: 0, conflicts: 0, unknown: {}, errors: 0 });
const bump = (o: Record<string, number>, k: string) => { o[k] = (o[k] ?? 0) + 1; };

/** A `decision_records` row with no outcome from `source` yet: the predicate both lists share. */
export function noOutcomeFromSource(source: string) {
  return sql`not exists (select 1 from decision_outcomes o where o.decision_record_id = decision_records.id and o.source = ${source})`;
}

async function dbStore(): Promise<SpecGradingStore> {
  const { db } = await import('@buildd/core/db');
  const { decisionRecords, specFilings, specMetadataChanges, specRevisions, specs } = await import('@buildd/core/db/schema');
  const { and, asc, desc, eq, gte, isNotNull, lte } = await import('drizzle-orm');
  const { getArtifactRevision } = await import('@/lib/artifact-revisions');
  const { specCard } = await import('@/lib/specs/card');
  const { digest } = await import('@/lib/spec-duplicate-decision');
  return {
    async listUngradedDuplicates({ since, limit }) {
      const rows = await db.select({
        id: decisionRecords.id, teamId: decisionRecords.teamId, workspaceId: decisionRecords.workspaceId,
        verdict: decisionRecords.verdict, subjectId: decisionRecords.subjectId, createdAt: decisionRecords.createdAt,
        humanOverride: decisionRecords.humanOverride,
      }).from(decisionRecords)
        .where(and(
          eq(decisionRecords.capability, SPEC_DUPLICATE_KIND_ID),
          isNotNull(decisionRecords.verdict),
          gte(decisionRecords.createdAt, since),
          noOutcomeFromSource(SPEC_DUPLICATE_GOLD_SOURCE),
        ))
        .orderBy(desc(decisionRecords.createdAt))
        .limit(limit);
      return rows.map(({ humanOverride, ...r }) => ({ ...r, override: typeof humanOverride?.decision === 'string' ? humanOverride.decision : null }));
    },
    async findNewSpec({ workspaceId, from, to, cardHash }) {
      const candidates = await db.select({ id: specs.id, title: specs.title, createdAt: specs.createdAt, bodyArtifactId: specs.bodyArtifactId, artifactRevision: specRevisions.artifactRevision })
        .from(specs)
        .innerJoin(specRevisions, and(eq(specRevisions.specId, specs.id), eq(specRevisions.revision, 1)))
        .where(and(eq(specs.workspaceId, workspaceId), gte(specs.createdAt, from), lte(specs.createdAt, to)))
        .orderBy(asc(specs.createdAt))
        .limit(20);
      for (const c of candidates) {
        const body = await getArtifactRevision(c.bodyArtifactId, c.artifactRevision);
        if (typeof body?.content === 'string' && digest(specCard(c.title, body.content)) === cardHash) return { id: c.id, createdAt: c.createdAt };
      }
      return null;
    },
    async findSupersededBy(specId) {
      const [last] = await db.select({ newValue: specMetadataChanges.newValue, at: specMetadataChanges.createdAt }).from(specMetadataChanges)
        .where(and(eq(specMetadataChanges.specId, specId), eq(specMetadataChanges.field, 'status')))
        .orderBy(desc(specMetadataChanges.createdAt)).limit(1);
      const nv = last?.newValue as { status?: unknown; supersededBy?: unknown } | null | undefined;
      if (!last || nv?.status !== 'superseded' || typeof nv.supersededBy !== 'string') return null;
      const [by] = await db.select({ id: specs.id, createdAt: specs.createdAt }).from(specs).where(eq(specs.id, nv.supersededBy)).limit(1);
      return by ? { id: by.id, createdAt: by.createdAt, at: last.at } : null;
    },
    async listUngradedAreaFilings({ since, limit }) {
      const rows = await db.select({
        decisionRecordId: decisionRecords.id, teamId: decisionRecords.teamId, kind: specFilings.kind, status: specFilings.status,
        createdAt: specFilings.createdAt, resolvedAt: specFilings.resolvedAt, filedParentId: specFilings.parentSpecId, currentParentId: specs.parentSpecId,
      }).from(specFilings)
        .innerJoin(decisionRecords, eq(decisionRecords.id, specFilings.decisionRecordId))
        .innerJoin(specs, eq(specs.id, specFilings.specId))
        .where(and(
          eq(decisionRecords.capability, SPEC_AREA_KIND_ID),
          eq(specFilings.source, 'model'),
          gte(specFilings.createdAt, since),
          noOutcomeFromSource(SPEC_AREA_GOLD_SOURCE),
        ))
        .orderBy(desc(specFilings.createdAt))
        .limit(limit);
      return rows;
    },
  };
}

interface Labelled { teamId: string; decisionRecordId: string; source: string; label: string; observedAt: Date; reason: string }

async function write(l: Labelled, label: typeof labelDecisionOutcome, result: SpecGradingResult): Promise<void> {
  try {
    const res = await label({ teamId: l.teamId, decisionRecordId: l.decisionRecordId, source: l.source, label: l.label, metadata: { reason: l.reason }, observedAt: l.observedAt });
    if (!res.ok) { result.errors++; return; }
    const status = res.results[0]?.status;
    if (status === 'recorded') result.labelled++;
    else if (status === 'duplicate') result.duplicates++;
    else result.conflicts++;
  } catch {
    result.errors++;
  }
}

export async function gradeSpecDecisions(
  opts: { now?: Date; limit?: number; lookbackMs?: number } = {},
  deps: { store?: SpecGradingStore; label?: typeof labelDecisionOutcome } = {},
): Promise<{ duplicate: SpecGradingResult; area: SpecGradingResult }> {
  const now = opts.now ?? new Date();
  const label = deps.label ?? labelDecisionOutcome;
  const since = new Date(now.getTime() - (opts.lookbackMs ?? SPEC_GOLD_LOOKBACK_MS));
  const limit = opts.limit ?? SPEC_GRADING_LIMIT;
  const out = { duplicate: emptyResult(), area: emptyResult() };
  let store: SpecGradingStore;
  try {
    store = deps.store ?? await dbStore();
  } catch (err) {
    console.warn('[spec-grading] store failed (non-fatal):', err instanceof Error ? err.message : err);
    out.duplicate.errors++; out.area.errors++;
    return out;
  }

  try {
    const records = await store.listUngradedDuplicates({ since, limit });
    out.duplicate.scanned = records.length;
    for (const r of records) {
      try {
        const [namedId, cardHash] = (r.subjectId ?? '').split(':');
        // An override on the row says everything; otherwise find the spec the check led to.
        const needsSpec = !r.override || r.verdict === 'distinct';
        const newSpec = needsSpec && r.workspaceId && cardHash
          ? await store.findNewSpec({ workspaceId: r.workspaceId, from: r.createdAt, to: new Date(r.createdAt.getTime() + NEW_SPEC_WINDOW_MS), cardHash })
          : null;
        const [newSpecSupersededBy, namedSupersededBy] = await Promise.all([
          newSpec && r.verdict === 'distinct' ? store.findSupersededBy(newSpec.id) : null,
          newSpec && r.verdict === 'duplicate' && !r.override && namedId ? store.findSupersededBy(namedId) : null,
        ]);
        const gold = gradeDuplicateDecision({
          verdict: r.verdict, decidedAt: r.createdAt, now, override: r.override, newSpec,
          newSpecSupersededBy, namedSupersededBy: namedSupersededBy ? { id: namedSupersededBy.id, at: namedSupersededBy.at } : null,
        });
        if (gold.status === 'unknown') { bump(out.duplicate.unknown, gold.reason); continue; }
        await write({ teamId: r.teamId, decisionRecordId: r.id, source: SPEC_DUPLICATE_GOLD_SOURCE, label: gold.label, observedAt: gold.observedAt, reason: gold.reason }, label, out.duplicate);
      } catch {
        out.duplicate.errors++;
      }
    }
  } catch (err) {
    console.warn('[spec-grading] duplicate grading failed (non-fatal):', err instanceof Error ? err.message : err);
    out.duplicate.errors++;
  }

  try {
    const filings = await store.listUngradedAreaFilings({ since, limit });
    out.area.scanned = filings.length;
    for (const f of filings) {
      const gold = gradeAreaFiling({ ...f, now });
      if (gold.status === 'unknown') { bump(out.area.unknown, gold.reason); continue; }
      await write({ teamId: f.teamId, decisionRecordId: f.decisionRecordId, source: SPEC_AREA_GOLD_SOURCE, label: gold.label, observedAt: gold.observedAt, reason: gold.reason }, label, out.area);
    }
  } catch (err) {
    console.warn('[spec-grading] area grading failed (non-fatal):', err instanceof Error ? err.message : err);
    out.area.errors++;
  }
  return out;
}
