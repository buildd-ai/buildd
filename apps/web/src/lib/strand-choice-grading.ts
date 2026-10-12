/**
 * Writes the strand-choice gold (lib/strand-choice-gold.ts) into
 * `decision_outcomes`, source `strand_followup`, once a decision's window has
 * closed. Run daily from the orchestration readout cron.
 *
 * - Reads model-answered `mission_strand_choice` records with no gold yet,
 *   newest first and bounded, from the last `STRAND_GRADING_LOOKBACK_MS`.
 * - Evidence: the mission's status, the worker claims on its tasks since the
 *   oldest decision (`runner = 'mcp'` is an interactive session), and the
 *   owner's tap already recorded on the record (`human` / `human_choice`).
 * - Idempotent: a graded record is not listed again, and `labelDecisionOutcome`
 *   treats the same label twice as a duplicate. An unknown writes nothing and
 *   is retried until it ages out of the lookback.
 *
 * Ids, labels and minutes only. Never throws.
 */
import { labelDecisionOutcome } from '@buildd/core/decision-outcomes';
import { STRAND_CHOICE_CAPABILITY } from './strand-choice-decision';
import { STRAND_GOLD_SOURCE, STRAND_GOLD_WINDOW_MS, gradeStrandChoice } from './strand-choice-gold';

export const STRAND_GRADING_LOOKBACK_MS = 8 * 24 * 60 * 60 * 1000;
export const STRAND_GRADING_LIMIT = 500;
/** Claims read per run. Enough for a day of local missions; a cut-off list reads as fewer claims, so it is logged. */
export const STRAND_GRADING_MAX_CLAIMS = 20_000;

const TERMINAL_MISSION = new Set(['completed', 'archived', 'cancelled']);

export interface UngradedStrandDecision {
  id: string;
  teamId: string;
  missionId: string | null;
  verdict: string | null;
  createdAt: Date;
}

export interface StrandMissionEvidence {
  ended: boolean;
  claims: ReadonlyArray<{ runner: string; at: Date }>;
}

export interface StrandGradingStore {
  listUngraded(opts: { since: Date; before: Date; limit: number }): Promise<UngradedStrandDecision[]>;
  /** Missions that exist, with their task claims at or after `since`. */
  loadMissions(missionIds: string[], since: Date): Promise<Map<string, StrandMissionEvidence>>;
  /** The owner's tap per record, from the `human` outcome the strand-choice route writes. */
  loadTaps(recordIds: string[]): Promise<Map<string, { button: string; at: Date }>>;
}

export interface StrandGradingResult {
  scanned: number;
  labelled: number;
  duplicates: number;
  conflicts: number;
  /** Why records got no label, by reason. */
  unknown: Record<string, number>;
  errors: number;
}

async function dbStore(): Promise<StrandGradingStore> {
  const { db } = await import('@buildd/core/db');
  const { decisionOutcomes, decisionRecords, missions, tasks, workers } = await import('@buildd/core/db/schema');
  const { and, desc, eq, gte, inArray, isNotNull, lt, notExists } = await import('drizzle-orm');
  return {
    async listUngraded({ since, before, limit }) {
      const rows = await db
        .select({ id: decisionRecords.id, teamId: decisionRecords.teamId, missionId: decisionRecords.missionId, verdict: decisionRecords.verdict, createdAt: decisionRecords.createdAt })
        .from(decisionRecords)
        .where(and(
          eq(decisionRecords.capability, STRAND_CHOICE_CAPABILITY),
          isNotNull(decisionRecords.verdict),
          gte(decisionRecords.createdAt, since),
          lt(decisionRecords.createdAt, before),
          notExists(db.select({ one: decisionOutcomes.id }).from(decisionOutcomes).where(and(
            eq(decisionOutcomes.decisionRecordId, decisionRecords.id),
            eq(decisionOutcomes.source, STRAND_GOLD_SOURCE),
          ))),
        ))
        .orderBy(desc(decisionRecords.createdAt))
        .limit(limit);
      return rows;
    },
    async loadMissions(missionIds, since) {
      const out = new Map<string, StrandMissionEvidence & { claims: Array<{ runner: string; at: Date }> }>();
      if (missionIds.length === 0) return out;
      const ms = await db.select({ id: missions.id, status: missions.status }).from(missions).where(inArray(missions.id, missionIds));
      for (const m of ms) out.set(m.id, { ended: TERMINAL_MISSION.has(m.status), claims: [] });
      const claims = await db
        .select({ missionId: tasks.missionId, runner: workers.runner, at: workers.createdAt })
        .from(workers)
        .innerJoin(tasks, eq(tasks.id, workers.taskId))
        .where(and(inArray(tasks.missionId, missionIds), gte(workers.createdAt, since)))
        .limit(STRAND_GRADING_MAX_CLAIMS);
      if (claims.length >= STRAND_GRADING_MAX_CLAIMS) console.warn('[strand-grading] claim read hit its cap; some decisions may read as local_absent');
      for (const c of claims) if (c.missionId) out.get(c.missionId)?.claims.push({ runner: c.runner, at: c.at });
      return out;
    },
    async loadTaps(recordIds) {
      const out = new Map<string, { button: string; at: Date }>();
      if (recordIds.length === 0) return out;
      const rows = await db
        .select({ id: decisionOutcomes.decisionRecordId, metadata: decisionOutcomes.metadata, at: decisionOutcomes.observedAt })
        .from(decisionOutcomes)
        .where(and(inArray(decisionOutcomes.decisionRecordId, recordIds), eq(decisionOutcomes.source, 'human'), eq(decisionOutcomes.label, 'human_choice')));
      for (const r of rows) {
        const button = r.metadata?.button;
        if (typeof button === 'string') out.set(r.id, { button, at: r.at });
      }
      return out;
    },
  };
}

const bump = (o: Record<string, number>, k: string) => { o[k] = (o[k] ?? 0) + 1; };

export async function gradeStrandChoiceDecisions(
  opts: { now?: Date; limit?: number; lookbackMs?: number } = {},
  deps: { store?: StrandGradingStore; label?: typeof labelDecisionOutcome } = {},
): Promise<StrandGradingResult> {
  const result: StrandGradingResult = { scanned: 0, labelled: 0, duplicates: 0, conflicts: 0, unknown: {}, errors: 0 };
  const now = opts.now ?? new Date();
  const label = deps.label ?? labelDecisionOutcome;
  try {
    const store = deps.store ?? await dbStore();
    const records = await store.listUngraded({
      since: new Date(now.getTime() - (opts.lookbackMs ?? STRAND_GRADING_LOOKBACK_MS)),
      before: new Date(now.getTime() - STRAND_GOLD_WINDOW_MS),
      limit: opts.limit ?? STRAND_GRADING_LIMIT,
    });
    result.scanned = records.length;
    if (records.length === 0) return result;

    const missionIds = [...new Set(records.map(r => r.missionId).filter((m): m is string => !!m))];
    const oldest = new Date(Math.min(...records.map(r => r.createdAt.getTime())));
    const [missionEvidence, taps] = await Promise.all([
      store.loadMissions(missionIds, oldest),
      store.loadTaps(records.map(r => r.id)),
    ]);

    for (const r of records) {
      const evidence = r.missionId ? missionEvidence.get(r.missionId) : undefined;
      if (!evidence) { bump(result.unknown, 'mission_missing'); continue; }
      const gold = gradeStrandChoice({
        verdict: r.verdict,
        decidedAt: r.createdAt,
        now,
        localClaimsAt: evidence.claims.filter(c => c.runner === 'mcp').map(c => c.at),
        runnerClaimsAt: evidence.claims.filter(c => c.runner !== 'mcp').map(c => c.at),
        tap: taps.get(r.id) ?? null,
        missionEnded: evidence.ended,
      });
      if (gold.status === 'unknown') { bump(result.unknown, gold.reason); continue; }
      const observedAt = new Date(r.createdAt.getTime() + (gold.afterMinutes === null ? STRAND_GOLD_WINDOW_MS : gold.afterMinutes * 60_000));
      try {
        const res = await label({
          teamId: r.teamId,
          decisionRecordId: r.id,
          source: STRAND_GOLD_SOURCE,
          label: gold.right,
          value: gold.afterMinutes,
          metadata: { reason: gold.reason },
          observedAt,
        });
        if (!res.ok) { result.errors++; continue; }
        const status = res.results[0]?.status;
        if (status === 'recorded') result.labelled++;
        else if (status === 'duplicate') result.duplicates++;
        else result.conflicts++;
      } catch {
        result.errors++;
      }
    }
  } catch (err) {
    console.warn('[strand-grading] failed (non-fatal):', err instanceof Error ? err.message : err);
    result.errors++;
  }
  return result;
}
