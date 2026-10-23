import { db } from '@buildd/core/db';
import { specOutcomeVerdicts, tasks, workers } from '@buildd/core/db/schema';
import { and, desc, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { boundEvidenceRefs, type VerificationEvidenceRef, type VerificationVerdict } from '@buildd/core/verification-check';
import { newestOwnerDeliveries } from '@/lib/workflow/delivery-view';
import type { MissionSpecStanding } from './mission-outcome';

/**
 * What stands behind each criterion of a mission's Verify view (Navigation
 * d25d923d R-17, Living Specs D-46: evidence sits under the criterion it
 * supports): the recorded verdict's evidence, and the repair working on the
 * criterion now.
 *
 * Bounded reads, never one per criterion: the verdict rows the standings name
 * (one query), the mission's repairs still in play (one query), their newest
 * workers and their PRs (one each).
 */

/** At most this many verdict rows are read: well above every in-scope criterion of MAX_GOAL_CRITERIA specs. */
export const MAX_EVIDENCE_ROWS = 400;
/** At most this many repairs are read, newest first. */
export const MAX_REPAIRS = 50;
const MAX_OBSERVED = 500;
const MAX_STDOUT = 2000;

export interface VerdictEvidence {
  verdictId: string;
  result: VerificationVerdict;
  /** What the grader saw, in its words. */
  observed: string | null;
  refs: VerificationEvidenceRef[];
  readIds: string[];
  /** The tail of an acceptance test's or check line's output. */
  stdoutExcerpt: string | null;
  /** `user:<id>`, `final-verification:<task>`, `check:<task>`, `check:acceptance:<criterion>`, ... */
  recordedBy: string | null;
  at: string;
}

export interface RepairInFlight {
  taskId: string;
  title: string;
  status: string;
  /** Null on a repair filed before the spec was recorded on the marker. */
  specId: string | null;
  criterionId: string;
  /** When its newest worker started; null while none has. */
  workerStartedAt: string | null;
  /** Its PR, once it has one. `state` is the delivery's (OPEN-like states, MERGED, ...), null when unknown. */
  pr: { number: number; url: string | null; state: string | null } | null;
}

export interface MissionEvidence {
  verdicts: Map<string, VerdictEvidence>;
  repairs: RepairInFlight[];
}

type VerdictRow = { id: string; verdict: string; createdAt: Date | string; evidence: unknown };
type RepairRow = { id: string; title: string; status: string; context: unknown };
type WorkerRow = { taskId: string | null; startedAt: Date | string | null; prNumber: number | null; prUrl: string | null };
type DeliveryRow = { ownerTaskId: string; state: string; prNumber: number | null };

const iso = (v: Date | string | null | undefined) => (v == null ? null : v instanceof Date ? v.toISOString() : new Date(v).toISOString());
const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(-max) : null);

/** Pure: one verdict row's evidence in the shape Verify shows. */
export function verdictEvidenceOf(row: VerdictRow): VerdictEvidence {
  const ev = row.evidence && typeof row.evidence === 'object' ? (row.evidence as Record<string, unknown>) : {};
  return {
    verdictId: row.id,
    result: row.verdict as VerificationVerdict,
    observed: typeof ev.observed === 'string' && ev.observed.trim() ? ev.observed.trim().slice(0, MAX_OBSERVED) : null,
    refs: boundEvidenceRefs(ev.refs),
    readIds: Array.isArray(ev.readIds) ? ev.readIds.filter((x): x is string => typeof x === 'string') : [],
    stdoutExcerpt: text(ev.stdout, MAX_STDOUT),
    recordedBy: typeof ev.recordedBy === 'string' ? ev.recordedBy : null,
    at: iso(row.createdAt)!,
  };
}

/** Delivery states after which a repair has nothing left to do for its criterion. */
const DONE_DELIVERY = new Set(['MERGED', 'CLOSED_UNMERGED', 'SUPERSEDED', 'ABANDONED', 'FAILED']);

/**
 * Pure: the repairs still working on a criterion. A repair is in play while
 * its task runs, and after it completes until its PR merges or closes (the
 * criterion is re-checked once it merges). A failed or cancelled repair is not.
 */
export function repairsInFlight(rows: readonly RepairRow[], workerRows: readonly WorkerRow[], deliveries: readonly DeliveryRow[]): RepairInFlight[] {
  const newestWorker = new Map<string, WorkerRow>();
  for (const w of workerRows) if (w.taskId && !newestWorker.has(w.taskId)) newestWorker.set(w.taskId, w);
  const delivery = new Map(deliveries.map((d) => [d.ownerTaskId, d]));
  return rows.flatMap((t) => {
    const m = (t.context as Record<string, unknown> | null)?.specRepair as Record<string, unknown> | undefined;
    if (!m || typeof m.criterionId !== 'string') return [];
    const d = delivery.get(t.id);
    if (t.status === 'completed' && (!d || DONE_DELIVERY.has(d.state))) return [];
    const w = newestWorker.get(t.id);
    const number = d?.prNumber ?? w?.prNumber ?? null;
    return [{
      taskId: t.id,
      title: t.title,
      status: t.status,
      specId: typeof m.specId === 'string' ? m.specId : null,
      criterionId: m.criterionId,
      workerStartedAt: iso(w?.startedAt),
      pr: number == null ? null : { number, url: w?.prUrl ?? null, state: d?.state ?? null },
    }];
  });
}

/**
 * Pure: the repair working on one criterion of one spec. A repair that
 * names its spec matches only that spec; one filed before specs were
 * recorded matches the criterion id in any spec.
 */
export function repairFor(evidence: Pick<MissionEvidence, 'repairs'>, specId: string, criterionId: string): RepairInFlight | null {
  return evidence.repairs.find((r) => r.criterionId === criterionId && r.specId === specId)
    ?? evidence.repairs.find((r) => r.criterionId === criterionId && r.specId === null)
    ?? null;
}

export interface MissionEvidenceDeps {
  verdictRows(ids: string[]): Promise<VerdictRow[]>;
  repairRows(missionId: string): Promise<RepairRow[]>;
  workerRows(taskIds: string[]): Promise<WorkerRow[]>;
  deliveryRows(taskIds: string[]): Promise<DeliveryRow[]>;
}

const dbDeps: MissionEvidenceDeps = {
  verdictRows: (ids) => db.select({ id: specOutcomeVerdicts.id, verdict: specOutcomeVerdicts.verdict, createdAt: specOutcomeVerdicts.createdAt, evidence: specOutcomeVerdicts.evidence })
    .from(specOutcomeVerdicts).where(inArray(specOutcomeVerdicts.id, ids)),
  repairRows: (missionId) => db.select({ id: tasks.id, title: tasks.title, status: tasks.status, context: tasks.context })
    .from(tasks)
    .where(and(eq(tasks.missionId, missionId), sql`${tasks.context} ? 'specRepair'`, notInArray(tasks.status, ['failed', 'cancelled'])))
    .orderBy(desc(tasks.createdAt))
    .limit(MAX_REPAIRS),
  workerRows: (taskIds) => db.select({ taskId: workers.taskId, startedAt: workers.startedAt, prNumber: workers.prNumber, prUrl: workers.prUrl })
    .from(workers).where(inArray(workers.taskId, taskIds)).orderBy(desc(workers.createdAt)),
  deliveryRows: (taskIds) => newestOwnerDeliveries(taskIds),
};

/** The evidence behind every verdict the standings cite, and the repairs in play, for one mission. */
export async function loadMissionEvidence(
  missionId: string,
  standings: ReadonlyArray<Pick<MissionSpecStanding, 'standings'>>,
  deps: MissionEvidenceDeps = dbDeps,
): Promise<MissionEvidence> {
  const ids = [...new Set(standings.flatMap((s) => s.standings.flatMap((c) => (c.verdictId ? [c.verdictId] : []))))].slice(0, MAX_EVIDENCE_ROWS);
  const [rows, repairRows] = await Promise.all([ids.length ? deps.verdictRows(ids) : Promise.resolve([]), deps.repairRows(missionId)]);
  const repairIds = repairRows.map((r) => r.id);
  const [workerRows, deliveries] = repairIds.length
    ? await Promise.all([deps.workerRows(repairIds), deps.deliveryRows(repairIds)])
    : [[], []];
  return {
    verdicts: new Map(rows.map((r) => [r.id, verdictEvidenceOf(r)])),
    repairs: repairsInFlight(repairRows, workerRows, deliveries),
  };
}
