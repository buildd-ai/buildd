/**
 * The database side of the decision model optimizer (`./optimizer.ts`). Every
 * write is one statement (neon-http has no transactions); ending a switch is
 * `UPDATE … WHERE status = 'active'`, so two enders cannot both win.
 */
import { and, desc, eq, gt, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { decisionModelSwitches, decisionRecords, promptEvalRuns, teams } from '@buildd/core/db/schema';
import { recordDecision } from '@buildd/core/decision-ledger';
import { probeDecisionModel } from '@buildd/core/decision-probe';
import { setDecisionModelForKind } from '@buildd/core/decision-model-store';
import { canonicalMeasuredModel, loadMeasurementsSafe, writeDecisionModelMeasurement } from '@buildd/core/decision-model-measurements';
import { sqlWhere } from '@buildd/core/db/relational-sql';
import { runModelComparison } from '../prompt-evals/compare-run';
import { collectedDeps, promptEvalDeps } from '../prompt-evals/store';
import { OPTIMIZER_CADENCE_MS, type OptimizerDeps, type SwitchRow, type SwitchStore } from './optimizer';

const LIVE_GRADE_ROWS = 2000;

const switches: SwitchStore = {
  pinnedKinds: async (teamId, at) => {
    const rows = await db.select({ kind: decisionModelSwitches.kind }).from(decisionModelSwitches)
      .where(and(eq(decisionModelSwitches.teamId, teamId), gt(decisionModelSwitches.pinnedUntil, at)));
    return new Set(rows.map(r => r.kind));
  },
  insert: async row => {
    const [r] = await db.insert(decisionModelSwitches).values(row).returning({ id: decisionModelSwitches.id });
    return r.id;
  },
  supersede: async (teamId, kind, at) => {
    await db.update(decisionModelSwitches).set({ status: 'superseded', endedAt: at })
      .where(and(eq(decisionModelSwitches.teamId, teamId), eq(decisionModelSwitches.kind, kind), eq(decisionModelSwitches.status, 'active')));
  },
  listActive: async teamId => {
    const rows = await db.select().from(decisionModelSwitches)
      .where(teamId
        ? and(eq(decisionModelSwitches.status, 'active'), eq(decisionModelSwitches.teamId, teamId))
        : eq(decisionModelSwitches.status, 'active'))
      .orderBy(desc(decisionModelSwitches.createdAt))
      .limit(500);
    return rows as SwitchRow[];
  },
  get: async id => {
    const [row] = await db.select().from(decisionModelSwitches).where(eq(decisionModelSwitches.id, id)).limit(1);
    return (row as SwitchRow | undefined) ?? null;
  },
  end: async (id, status, patch) => {
    const rows = await db.update(decisionModelSwitches)
      .set({ status, endedAt: patch.endedAt, endedBy: patch.endedBy ?? null, ...(patch.pinnedUntil !== undefined ? { pinnedUntil: patch.pinnedUntil } : {}) })
      .where(and(eq(decisionModelSwitches.id, id), eq(decisionModelSwitches.status, 'active')))
      .returning({ id: decisionModelSwitches.id });
    return rows.length > 0;
  },
};

/** Does a ledger row's reported model stand for the switched-to model (exact, or a dated suffix)? */
function sameModel(reported: string, model: string): boolean {
  const a = canonicalMeasuredModel(reported);
  const b = canonicalMeasuredModel(model);
  return a === b || (!['clef', 'clef-flash'].includes(b) && a.startsWith(`${b}-`));
}

/**
 * Live decisions of this kind the model's answer applied to, graded the way a
 * collected case is: the kind's outcome source and objective. No outcome yet,
 * or an objective that cannot say, is not graded.
 */
async function liveGrades(q: { teamId: string; kind: string; model: string; since: Date }): Promise<{ graded: number; correct: number }> {
  const kind = (await collectedDeps.kinds()).find(k => k.kind === q.kind);
  const objective = kind?.binding.readout?.objective;
  if (!objective) return { graded: 0, correct: 0 };
  const records = (await db.select({ id: decisionRecords.id, model: decisionRecords.model, answer: decisionRecords.appliedAnswer })
    .from(decisionRecords)
    .where(and(
      eq(decisionRecords.teamId, q.teamId),
      eq(decisionRecords.capability, q.kind),
      eq(decisionRecords.applied, true),
      gte(decisionRecords.createdAt, q.since),
      isNotNull(decisionRecords.model),
    ))
    .orderBy(desc(decisionRecords.createdAt))
    .limit(LIVE_GRADE_ROWS))
    .filter(r => r.model && r.answer && sameModel(r.model, q.model));
  if (records.length === 0) return { graded: 0, correct: 0 };
  const outcomes = await collectedDeps.loadOutcomes(records.map(r => r.id));
  let graded = 0, correct = 0;
  for (const r of records) {
    const first = (outcomes.get(r.id) ?? [])
      .filter(o => !objective.source || o.source === objective.source)
      .sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime())[0];
    if (!first) continue;
    let s: boolean | null = null;
    try {
      s = objective.score({ label: first.label, value: first.value }, r.answer!);
    } catch {
      s = null;
    }
    if (s === null) continue;
    graded++;
    if (s) correct++;
  }
  return { graded, correct };
}

async function readStoredDecisionModel(teamId: string): Promise<unknown> {
  const row = await db.query.teams.findFirst({ where: sqlWhere(eq(teams.id, teamId)), columns: { decisionModel: true } });
  return row?.decisionModel ?? null;
}

export function optimizerDeps(): OptimizerDeps {
  return {
    optedIn: async teamId => {
      const row = await db.query.teams.findFirst({ where: sqlWhere(eq(teams.id, teamId)), columns: { decisionModelOptimizer: true } });
      return row?.decisionModelOptimizer === true;
    },
    readDecisionModel: readStoredDecisionModel,
    compare: input => runModelComparison(input, promptEvalDeps()),
    preflight: async (route, teamId) => {
      const r = await probeDecisionModel(route, { teamId });
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    },
    fingerprintFor: async kind => (await collectedDeps.kinds()).find(k => k.kind === kind)?.promptFingerprint ?? null,
    measurements: () => loadMeasurementsSafe(),
    writeMeasurement: async row => { await writeDecisionModelMeasurement(row); },
    setKindModel: async (teamId, kind, route, reason) => {
      const r = await setDecisionModelForKind(teamId, kind, route, { by: null, reason });
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    },
    switches,
    liveGrades,
    recordLedger: async input => { await recordDecision(input); },
  };
}

/** The switch-feed read for the team route: the switch store and the stored model only. */
export function switchFeedDeps(): Pick<OptimizerDeps, 'switches' | 'readDecisionModel'> {
  return { switches, readDecisionModel: readStoredDecisionModel };
}

/**
 * Opted-in teams due a run: no scheduled comparison started for them within
 * the cadence. Longest-waiting first, so a deferred team goes first next time.
 */
export async function dueOptimizerTeams(now: number = Date.now()): Promise<string[]> {
  const cutoff = new Date(now - OPTIMIZER_CADENCE_MS);
  const opted = await db.select({ id: teams.id }).from(teams).where(eq(teams.decisionModelOptimizer, true));
  if (opted.length === 0) return [];
  const ids = opted.map(t => t.id);
  const last = await db.select({ teamId: promptEvalRuns.teamId, at: sql<Date>`max(${promptEvalRuns.startedAt})` })
    .from(promptEvalRuns)
    .where(and(inArray(promptEvalRuns.teamId, ids), eq(promptEvalRuns.trigger, 'cron'), isNotNull(promptEvalRuns.models)))
    .groupBy(promptEvalRuns.teamId);
  const lastAt = new Map(last.map(r => [r.teamId, new Date(r.at).getTime()]));
  return ids
    .filter(id => !lastAt.has(id) || lastAt.get(id)! < cutoff.getTime())
    .sort((a, b) => (lastAt.get(a) ?? 0) - (lastAt.get(b) ?? 0));
}

/** Every opted-in team (the admin "run now" with no team named). */
export async function optedInTeams(): Promise<string[]> {
  return (await db.select({ id: teams.id }).from(teams).where(eq(teams.decisionModelOptimizer, true))).map(t => t.id);
}
