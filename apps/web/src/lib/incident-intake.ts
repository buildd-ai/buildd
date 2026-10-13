/**
 * Incident intake: the one door every problem report goes through
 * (docs/specs/bug-intake-and-quality.md §3.1).
 *
 * `intakeReport` is the only writer of `incident_reports`. It:
 *
 * 1. computes the fingerprint and extracts the subject anchor;
 * 2. inserts the row, idempotent on `(workspace_id, idempotency_key)`. The
 *    insert is `ON CONFLICT DO NOTHING` against a unique index, so two racing
 *    callers converge on one row without a read-then-write (neon-http has no
 *    interactive transactions);
 * 3. hands a newly created report to the reconciliation seam and writes the
 *    decision it returns.
 *
 * It never throws to its caller (I-8). A failure after step 2 leaves the row
 * with `decision = null` for a later sweep to pick up. S1 ships the seam
 * (`reconcileReport`) with nothing behind it; the reconciliation slice fills it.
 */
import type {
  IncidentReport,
  IncidentReportDecidedBy,
  IncidentReportDecision,
  IncidentReportRefs,
  IncidentReportSource,
} from '@buildd/shared';
import { normalizeErrorSignature } from '@buildd/core/error-signature';
import { toFrictionSignature } from '@buildd/core/failure-friction-signature';
import { createSecretRedactor } from '@buildd/core/redaction';
import { extractSubjectAnchor } from '@buildd/core/subject-anchor-extractor';

export const MAX_REPORT_TITLE = 120;
export const MAX_REPORT_EXCERPT = 2000;
export const MAX_REPORT_PATHS = 20;
/** Namespace of `fingerprint`: toFrictionSignature(normalizeErrorSignature(excerpt), 'report'). */
export const REPORT_FINGERPRINT_NAMESPACE = 'report';

export interface IntakeInput {
  workspaceId: string;
  source: IncidentReportSource;
  /** Source-specific and unique per workspace; a repeat returns the existing report. */
  idempotencyKey: string;
  /** The key the source supplied, as given. */
  signature?: string | null;
  title: string;
  excerpt?: string | null;
  refs?: IncidentReportRefs;
  reporterTaskId?: string | null;
  reporterAccountId?: string | null;
}

/** A report row before the database assigns id, timestamps and decision fields. */
export type NewIncidentReport = Omit<
  IncidentReport,
  'id' | 'incidentId' | 'decision' | 'decidedBy' | 'reasonCode' | 'confidence' | 'decisionRecordId'
  | 'movedFromIncidentId' | 'movedAt' | 'createdAt'
>;

/** What reconciliation decided about one report. */
export interface ReconcileOutcome {
  decision: IncidentReportDecision;
  decidedBy: IncidentReportDecidedBy;
  reasonCode: string;
  confidence?: number | null;
  incidentId?: string | null;
  decisionRecordId?: string | null;
}

export type ReconcileReport = (report: IncidentReport) => Promise<ReconcileOutcome | null>;

/**
 * The seam the reconciliation slice fills. Null means "no decision": the report
 * stays undecided and a sweep picks it up later.
 */
export const reconcileReport: ReconcileReport = async () => null;

export interface IncidentReportPort {
  /** INSERT … ON CONFLICT (workspace_id, idempotency_key) DO NOTHING. Null when the key already exists. */
  insertIfAbsent(row: NewIncidentReport): Promise<IncidentReport | null>;
  findByKey(workspaceId: string, idempotencyKey: string): Promise<IncidentReport | null>;
  /** Writes the decision onto an undecided report. Returns the row after the write. */
  applyDecision(id: string, outcome: ReconcileOutcome): Promise<IncidentReport | null>;
}

export interface IntakeOptions {
  port?: IncidentReportPort;
  reconcile?: ReconcileReport;
  onError?: (err: unknown, stage: 'store' | 'reconcile') => void;
}

export interface IntakeResult {
  /** Null only when the store itself failed. */
  report: IncidentReport | null;
  /** False when the idempotency key already existed (or the store failed). */
  created: boolean;
}

const redact = createSecretRedactor([]);

function bound(text: string | null | undefined, max: number): string | null {
  if (!text) return null;
  const t = redact(text);
  return t.length > max ? t.slice(0, max) : t;
}

function buildRow(input: IntakeInput): NewIncidentReport {
  const excerpt = bound(input.excerpt, MAX_REPORT_EXCERPT);
  const refs: IncidentReportRefs = { ...(input.refs ?? {}) };
  if (refs.paths) refs.paths = refs.paths.slice(0, MAX_REPORT_PATHS);
  const title = bound(input.title, MAX_REPORT_TITLE) ?? '';

  let subjectAnchor = null;
  try {
    subjectAnchor = extractSubjectAnchor({
      title,
      description: excerpt ?? undefined,
      systemContext: {
        origin: 'watcher',
        prNumber: refs.prNumber,
        headSha: refs.headSha,
        subjectMissionId: refs.missionId,
      },
    }).anchor;
  } catch {
    // An anchor is a hint; a report without one is still a report.
  }

  return {
    workspaceId: input.workspaceId,
    source: input.source,
    signature: input.signature ?? null,
    fingerprint: excerpt ? toFrictionSignature(normalizeErrorSignature(excerpt), REPORT_FINGERPRINT_NAMESPACE) : null,
    subjectAnchor,
    title,
    excerpt,
    refs,
    reporterTaskId: input.reporterTaskId ?? null,
    reporterAccountId: input.reporterAccountId ?? null,
    idempotencyKey: input.idempotencyKey,
  };
}

export async function intakeReport(input: IntakeInput, opts: IntakeOptions = {}): Promise<IntakeResult> {
  const onError = opts.onError ?? ((err, stage) => console.error(`[incident-intake] ${stage} failed:`, err));
  const reconcile = opts.reconcile ?? reconcileReport;

  let report: IncidentReport;
  try {
    const port = opts.port ?? (await createDbIncidentReportPort());
    const row = buildRow(input);
    const inserted = await port.insertIfAbsent(row);
    if (!inserted) {
      const existing = await port.findByKey(input.workspaceId, input.idempotencyKey);
      return { report: existing, created: false };
    }
    report = inserted;

    try {
      const outcome = await reconcile(report);
      if (outcome) report = (await port.applyDecision(report.id, outcome)) ?? report;
    } catch (err) {
      onError(err, 'reconcile');
    }
    return { report, created: true };
  } catch (err) {
    onError(err, 'store');
    return { report: null, created: false };
  }
}

export async function createDbIncidentReportPort(): Promise<IncidentReportPort> {
  const { db } = await import('@buildd/core/db');
  const { incidentReports } = await import('@buildd/core/db/schema');
  const { and, eq, isNull } = await import('drizzle-orm');
  type Row = typeof incidentReports.$inferSelect;

  const fromRow = (r: Row): IncidentReport => ({
    id: r.id,
    workspaceId: r.workspaceId,
    incidentId: r.incidentId,
    source: r.source,
    signature: r.signature,
    fingerprint: r.fingerprint,
    subjectAnchor: r.subjectAnchor,
    title: r.title,
    excerpt: r.excerpt,
    refs: r.refs ?? {},
    reporterTaskId: r.reporterTaskId,
    reporterAccountId: r.reporterAccountId,
    decision: r.decision,
    decidedBy: r.decidedBy,
    reasonCode: r.reasonCode,
    confidence: r.confidence === null ? null : Number(r.confidence),
    decisionRecordId: r.decisionRecordId,
    movedFromIncidentId: r.movedFromIncidentId,
    movedAt: r.movedAt ? r.movedAt.toISOString() : null,
    idempotencyKey: r.idempotencyKey,
    createdAt: r.createdAt.toISOString(),
  });

  return {
    async insertIfAbsent(row) {
      const [r] = await db
        .insert(incidentReports)
        .values(row)
        .onConflictDoNothing({ target: [incidentReports.workspaceId, incidentReports.idempotencyKey] })
        .returning();
      return r ? fromRow(r) : null;
    },
    async findByKey(workspaceId, idempotencyKey) {
      const [r] = await db
        .select()
        .from(incidentReports)
        .where(and(eq(incidentReports.workspaceId, workspaceId), eq(incidentReports.idempotencyKey, idempotencyKey)))
        .limit(1);
      return r ? fromRow(r) : null;
    },
    async applyDecision(id, o) {
      // Only an undecided report takes a decision; a later correction is its own write.
      const [r] = await db
        .update(incidentReports)
        .set({
          decision: o.decision,
          decidedBy: o.decidedBy,
          reasonCode: o.reasonCode,
          confidence: o.confidence == null ? null : o.confidence.toFixed(3),
          incidentId: o.incidentId ?? null,
          decisionRecordId: o.decisionRecordId ?? null,
        })
        .where(and(eq(incidentReports.id, id), isNull(incidentReports.decision)))
        .returning();
      return r ? fromRow(r) : null;
    },
  };
}
