/**
 * The overlap-real decision's I/O half (knowledge-base: buildd/design/jev-scheduling.md
 * §5; pure half in `./orchestration-overlap-decision.ts`).
 *
 * Runs from the creation-manifest prediction hook, after a new task's own
 * prediction is recorded (`runOverlapRealShadow`, called from
 * `apps/web/src/lib/task-manifest-prediction.ts` inside the same `after()`).
 * It asks about the new task's soft pairs ONLY — other in-flight tasks whose
 * declared or predicted scope overlaps the new task's, bounded and deduped —
 * never on the claim hot path.
 *
 * ── Rollout (owner decision; see `./orchestration-overlap-decision.ts`) ─────
 * This capability (`orchestration_ordering`) applies from its first PR, gated
 * by a starting confidence threshold, with every call logged in
 * `orchestration_decisions` exactly like every other orchestration decision
 * (`runOrchestrationDecision`'s universal fallback ladder: capability off, no
 * key, deadline, invalid answer, provider error, thrown dependency all fall
 * back to the rule verdict `REAL`, i.e. today's behaviour — the pair stays an
 * ordinary soft edge with no stored override). An applied answer is written
 * ONLY to `orchestration_overlap_answers`, which only ever feeds
 * `claim-planner.ts`'s soft-edge weight: nothing here can create or remove a
 * hard edge, and nothing here writes `tasks.path_manifest` or `dependsOn`.
 */
import { and, desc, eq, gte, inArray, isNull, ne, notInArray, or } from 'drizzle-orm';
import { TERMINAL_TASK_STATUSES } from '@buildd/shared';
import { db } from './db/client';
import { orchestrationDecisions, orchestrationManifestPredictions, orchestrationOverlapAnswers, tasks } from './db/schema';
import { overlapPairKey } from './claim-planner';
import {
  OVERLAP_REAL_APPLYING_FRACTION,
  OVERLAP_REAL_CANDIDATE_POLICY_VERSION,
  OVERLAP_REAL_DECISION,
  OVERLAP_REAL_MAX_PAIRS_PER_TASK,
  buildOverlapState,
  findSoftOverlapPairs,
  overlapStateDigest,
  type OverlapPairCandidate,
  type OverlapRealDecisionType,
  type OverlapTaskScope,
} from './orchestration-overlap-decision';
import { runOrchestrationDecision, type OrchestrationDecisionDeps } from './orchestration-decision';
import { hasConcretePathManifest } from './path-overlap';

export const OVERLAP_REAL_CAPABILITY = 'orchestration_ordering' as const;

/** Candidate tasks pulled per new-task check, before pair selection narrows it to the top few. */
export const OVERLAP_CANDIDATE_TASK_LIMIT = 50;

// ── Candidate scope loading ──────────────────────────────────────────────────

export function overlapCandidateTasksWhere(opts: { workspaceId: string; excludeTaskId: string }) {
  return and(
    eq(tasks.workspaceId, opts.workspaceId),
    ne(tasks.id, opts.excludeTaskId),
    notInArray(tasks.status, [...TERMINAL_TASK_STATUSES]),
    or(isNull(tasks.taskClass), eq(tasks.taskClass, 'work')),
  );
}

/** Other in-flight tasks in the workspace, most recent first, bounded. */
export async function loadOverlapCandidateTasks(opts: { workspaceId: string; excludeTaskId: string; limit?: number }): Promise<Array<{ id: string; title: string; description: string | null; pathManifest: string[] | null }>> {
  const rows = await db
    .select({ id: tasks.id, title: tasks.title, description: tasks.description, pathManifest: tasks.pathManifest })
    .from(tasks)
    .where(overlapCandidateTasksWhere(opts))
    .orderBy(desc(tasks.createdAt))
    .limit(opts.limit ?? OVERLAP_CANDIDATE_TASK_LIMIT);
  return rows as Array<{ id: string; title: string; description: string | null; pathManifest: string[] | null }>;
}

/** The latest manifest prediction's selected set + confidence, per task id (for candidates with no concrete manifest). */
export async function loadPredictedScopes(opts: { workspaceId: string; taskIds: string[] }): Promise<Map<string, { selected: string[]; setConfidence: number | null }>> {
  const out = new Map<string, { selected: string[]; setConfidence: number | null }>();
  if (opts.taskIds.length === 0) return out;
  const rows = await db
    .select({ taskId: orchestrationManifestPredictions.taskId, selected: orchestrationManifestPredictions.selected, setConfidence: orchestrationManifestPredictions.setConfidence, createdAt: orchestrationManifestPredictions.createdAt })
    .from(orchestrationManifestPredictions)
    .where(and(eq(orchestrationManifestPredictions.workspaceId, opts.workspaceId), inArray(orchestrationManifestPredictions.taskId, opts.taskIds)))
    .orderBy(desc(orchestrationManifestPredictions.createdAt));
  for (const r of rows as Array<{ taskId: string; selected: string[]; setConfidence: number | null; createdAt: Date }>) {
    if (out.has(r.taskId)) continue; // most recent wins (ordered desc)
    out.set(r.taskId, { selected: r.selected ?? [], setConfidence: r.setConfidence });
  }
  return out;
}

/** Builds the other-side scopes for pair selection: concrete manifest wins; else the latest prediction. */
export async function loadOverlapCandidateScopes(opts: { workspaceId: string; excludeTaskId: string; limit?: number }): Promise<OverlapTaskScope[]> {
  const candidates = await loadOverlapCandidateTasks(opts);
  const needsPrediction = candidates.filter(c => !hasConcretePathManifest(c.pathManifest)).map(c => c.id);
  const predicted = await loadPredictedScopes({ workspaceId: opts.workspaceId, taskIds: needsPrediction });
  return candidates.map((c): OverlapTaskScope => {
    const declared = hasConcretePathManifest(c.pathManifest) ? c.pathManifest : null;
    const p = declared ? null : predicted.get(c.id) ?? null;
    return {
      taskId: c.id,
      title: c.title,
      description: c.description ?? null,
      declaredScope: declared,
      predictedScope: p ? p.selected : null,
      setConfidence: p ? p.setConfidence : null,
    };
  });
}

// ── Dedupe (anchored on the new task; see module header) ────────────────────

export interface OverlapDecisionKey {
  workspaceId: string;
  taskId: string;
  decisionId: string;
  fingerprint: string;
  candidateDigest: string;
  since: Date;
}

export function recentOverlapDecisionWhere(k: OverlapDecisionKey) {
  return and(
    eq(orchestrationDecisions.workspaceId, k.workspaceId),
    eq(orchestrationDecisions.taskId, k.taskId),
    eq(orchestrationDecisions.decisionId, k.decisionId),
    eq(orchestrationDecisions.fingerprint, k.fingerprint),
    eq(orchestrationDecisions.candidateDigest, k.candidateDigest),
    gte(orchestrationDecisions.createdAt, k.since),
  );
}

/** Was this exact pair state already asked about recently? A failed read answers true: never re-ask on an unreadable ledger. */
export async function hasRecentOverlapDecision(k: OverlapDecisionKey): Promise<boolean> {
  try {
    const rows = await db.select({ id: orchestrationDecisions.id }).from(orchestrationDecisions).where(recentOverlapDecisionWhere(k)).limit(1);
    return rows.length > 0;
  } catch (err) {
    console.warn('[orchestration-overlap] recent-decision read failed (skipping):', (err as Error)?.message ?? err);
    return true;
  }
}

/** How long the same pair-state is not re-asked about. */
export const OVERLAP_REAL_RECENT_ASK_MS = 10 * 60_000;

// ── Writes ───────────────────────────────────────────────────────────────────

export type NewOverlapAnswerRow = typeof orchestrationOverlapAnswers.$inferInsert;

/** One applied answer, upserted by (workspace, pair, decision). Never throws. */
export async function recordOverlapAnswer(row: NewOverlapAnswerRow): Promise<void> {
  try {
    await db.insert(orchestrationOverlapAnswers).values(row).onConflictDoUpdate({
      target: [orchestrationOverlapAnswers.workspaceId, orchestrationOverlapAnswers.pairKey, orchestrationOverlapAnswers.decisionId],
      set: { answer: row.answer, confidence: row.confidence, fingerprint: row.fingerprint, taskAId: row.taskAId, taskBId: row.taskBId, createdAt: row.createdAt ?? new Date() },
    });
  } catch (err) {
    console.warn('[orchestration-overlap] answer write failed (non-fatal):', (err as Error)?.message ?? err);
  }
}

/** Stored overlap answers for a batch of task ids, keyed by `overlapPairKey` — what the claim planner reads. */
export async function loadStoredOverlapAnswers(opts: { workspaceId: string; taskIds: readonly string[] }): Promise<Record<string, 'REAL' | 'NOT_REAL'>> {
  const out: Record<string, 'REAL' | 'NOT_REAL'> = {};
  if (opts.taskIds.length < 2) return out;
  try {
    const ids = new Set(opts.taskIds);
    const rows = await db
      .select({ pairKey: orchestrationOverlapAnswers.pairKey, taskAId: orchestrationOverlapAnswers.taskAId, taskBId: orchestrationOverlapAnswers.taskBId, answer: orchestrationOverlapAnswers.answer })
      .from(orchestrationOverlapAnswers)
      .where(eq(orchestrationOverlapAnswers.workspaceId, opts.workspaceId));
    for (const r of rows as Array<{ pairKey: string; taskAId: string; taskBId: string; answer: 'REAL' | 'NOT_REAL' }>) {
      if (ids.has(r.taskAId) && ids.has(r.taskBId)) out[r.pairKey] = r.answer;
    }
  } catch (err) {
    console.warn('[orchestration-overlap] stored-answer read failed (none applied):', (err as Error)?.message ?? err);
  }
  return out;
}

// ── Orchestration ────────────────────────────────────────────────────────────

export interface OverlapRealShadowInput {
  teamId: string;
  workspaceId: string;
  missionId?: string | null;
  accountId?: string | null;
  userId?: string | null;
}

export interface OverlapRealShadowDeps {
  decision?: OverlapRealDecisionType;
  loadCandidates?: (opts: { workspaceId: string; excludeTaskId: string }) => Promise<OverlapTaskScope[]>;
  hasRecent?: (k: OverlapDecisionKey) => Promise<boolean>;
  recordAnswer?: (row: NewOverlapAnswerRow) => Promise<void>;
  decide?: typeof runOrchestrationDecision;
  decisionDeps?: OrchestrationDecisionDeps;
  applyingFraction?: number;
  now?: () => number;
  maxPairs?: number;
}

/**
 * Ask about the new task's soft pairs. Never throws; every pair is
 * independent so one failure cannot stop the rest.
 */
export async function runOverlapRealShadow(
  newTask: OverlapTaskScope,
  input: OverlapRealShadowInput,
  deps: OverlapRealShadowDeps = {},
): Promise<void> {
  const decision = deps.decision ?? OVERLAP_REAL_DECISION;
  const now = deps.now ?? (() => Date.now());
  const decide = deps.decide ?? runOrchestrationDecision;
  try {
    const others = await (deps.loadCandidates ?? ((opts) => loadOverlapCandidateScopes(opts)))({
      workspaceId: input.workspaceId,
      excludeTaskId: newTask.taskId,
    });
    const pairs = findSoftOverlapPairs(newTask, others, { max: deps.maxPairs ?? OVERLAP_REAL_MAX_PAIRS_PER_TASK });
    for (const pair of pairs) {
      await askOnePair(pair, input, { decision, now, decide, deps });
    }
  } catch (err) {
    console.warn('[orchestration-overlap] shadow failed (non-fatal):', (err as Error)?.message ?? err);
  }
}

async function askOnePair(
  pair: OverlapPairCandidate,
  input: OverlapRealShadowInput,
  ctx: { decision: OverlapRealDecisionType; now: () => number; decide: typeof runOrchestrationDecision; deps: OverlapRealShadowDeps },
): Promise<void> {
  try {
    const digest = overlapStateDigest(pair);
    const key: OverlapDecisionKey = {
      workspaceId: input.workspaceId,
      taskId: pair.a.taskId,
      decisionId: ctx.decision.id,
      fingerprint: ctx.decision.fingerprint,
      candidateDigest: digest,
      since: new Date(ctx.now() - OVERLAP_REAL_RECENT_ASK_MS),
    };
    if (await (ctx.deps.hasRecent ?? hasRecentOverlapDecision)(key)) return;

    const outcome = await ctx.decide({
      decision: ctx.decision,
      question: 'overlap',
      capability: OVERLAP_REAL_CAPABILITY,
      scope: {
        teamId: input.teamId,
        workspaceId: input.workspaceId,
        missionId: input.missionId ?? null,
        taskId: pair.a.taskId,
      },
      ruleVerdict: 'REAL',
      candidatePolicy: { version: OVERLAP_REAL_CANDIDATE_POLICY_VERSION, digest, count: 2 },
      buildState: async () => buildOverlapState(pair),
      isValidAnswer: (v) => v === 'REAL' || v === 'NOT_REAL',
      cohort: { fraction: ctx.deps.applyingFraction ?? OVERLAP_REAL_APPLYING_FRACTION, unitId: pair.a.taskId },
      deps: ctx.deps.decisionDeps,
    });

    if (outcome.applied && (outcome.effective === 'REAL' || outcome.effective === 'NOT_REAL')) {
      await (ctx.deps.recordAnswer ?? recordOverlapAnswer)({
        teamId: input.teamId,
        workspaceId: input.workspaceId,
        missionId: input.missionId ?? null,
        pairKey: overlapPairKey(pair.a.taskId, pair.b.taskId),
        taskAId: pair.a.taskId,
        taskBId: pair.b.taskId,
        decisionId: ctx.decision.id,
        fingerprint: ctx.decision.fingerprint,
        answer: outcome.effective,
        confidence: outcome.confidence ?? 0,
      });
    }
  } catch (err) {
    console.warn('[orchestration-overlap] pair ask failed (non-fatal):', (err as Error)?.message ?? err);
  }
}
