import { db } from '@buildd/core/db';
import { missions, tasks, workspaces } from '@buildd/core/db/schema';
import { eq, and, desc, sql } from 'drizzle-orm';
import { recalculateOverall } from '@buildd/core/mission-helpers';
import type { GoalCriteriaState, CriterionVerdict, GoalCriteriaEvidenceRef } from '@buildd/shared';
import { dispatchNewTask } from '@/lib/task-dispatch';

/**
 * Batched, repo-grounded criteria evaluator.
 *
 * WHY TWO PATHS?
 * OAuth subscription auth is runner-anchored by design: the web server cannot
 * mint a subscription-authed one-shot call. "Evaluate via OAuth" and "dispatch a
 * worker" are therefore the same statement — there is no cheap third option.
 * Worker dispatch costs a clone, a concurrency seat, and rolling-session-window
 * time. So worker evaluation is BATCHED (all eligible criteria in one run) and
 * TRIGGER-GATED (only at mission-complete evaluation, not from the heartbeat prepass
 * routine — the heartbeat calls this path only when it reaches the completion gate).
 *
 * This module handles the 'worker' evaluationStrategy as well as command criteria
 * under the 'inline' strategy, since command criteria are structurally unevaluable
 * by an inline LLM call and need a process that can actually run them.
 *
 * Flow:
 *   1. `resolveCriteriaWorkerEval` finds an in-flight task or dispatches one,
 *      setting all covered criteria to PENDING.
 *   2. `handleCriteriaWorkerEvalOutcome` — called from the worker-completion hooks —
 *      reads `criteriaVerdicts` from structured output, writes them onto the criteria,
 *      re-folds `overall`, then re-attempts completion. A task that fails, times out,
 *      or is reaped without verdicts leaves each criterion NOT_EVALUATED with a reason
 *      that names the failed task — never a silent pass.
 */

/** Context marker written onto the worker task, read back on completion. */
export interface CriteriaWorkerEvalContext {
  missionId: string;
  /** Criterion indices this task was asked to evaluate (LLM-eligible + command). */
  criterionIndices: number[];
  /**
   * Fingerprints parallel to criterionIndices. Checked on write-back so that a
   * criterion edited while the task ran cannot receive a transplanted verdict.
   */
  fingerprints: string[];
}

/** How long a worker eval result stays authoritative before a re-evaluation dispatches a fresh task. */
export const WORKER_EVAL_TTL_MS = 30 * 60 * 1000;

const EVAL_TASK_TITLE_PREFIX = 'Evaluate goal criteria:';

/** JSON schema the worker must output — one entry per criterion. */
export const WORKER_EVAL_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['criteriaVerdicts'],
  properties: {
    criteriaVerdicts: {
      type: 'array',
      description: 'One entry per criterion you were asked to evaluate',
      items: {
        type: 'object',
        required: ['index', 'verdict', 'evidence'],
        properties: {
          index: {
            type: 'number',
            description: 'The criterion index exactly as given in the task description',
          },
          verdict: {
            type: 'string',
            enum: ['pass', 'fail', 'UNVERIFIED'],
            description: 'pass = criterion satisfied, fail = criterion violated, UNVERIFIED = insufficient evidence',
          },
          evidence: {
            type: 'string',
            description: 'One sentence citing what you found — for command criteria cite the exit code or output',
          },
          evidenceRef: {
            type: ['object', 'null'],
            properties: {
              type: { type: 'string', enum: ['artifact', 'task', 'file'] },
              id: { type: 'string' },
              title: { type: 'string' },
            },
          },
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
} as const;

export interface WorkerEvalCriterionInput {
  index: number;
  type: string;
  text: string;
  /** For command criteria, the command to run. */
  command?: string;
  fingerprint?: string;
}

export type CriteriaWorkerEvalResolution =
  | { kind: 'pending'; taskId: string; evidence: string }
  | { kind: 'unavailable'; evidence: string };

/**
 * In-flight or recently-terminal worker eval task for this mission, if any.
 * Matched on the marker in SQL to survive heartbeat-generated planning rows.
 */
async function findWorkerEvalTask(missionId: string) {
  const rows = await db.query.tasks.findMany({
    where: and(
      eq(tasks.missionId, missionId),
      sql`${tasks.context} -> 'criteriaWorkerEval' ->> 'missionId' = ${missionId}`,
    ),
    columns: { id: true, status: true, context: true, result: true, updatedAt: true },
    orderBy: [desc(tasks.createdAt)],
    limit: 5,
  });
  return rows.find(r => readMarker(r.context)?.missionId === missionId) ?? null;
}

function readMarker(context: unknown): CriteriaWorkerEvalContext | null {
  const m = (context as Record<string, unknown> | null)?.criteriaWorkerEval as CriteriaWorkerEvalContext | undefined;
  if (!m || typeof m.missionId !== 'string' || !Array.isArray(m.criterionIndices)) return null;
  return m;
}

/** True when this task is a criteria worker-eval task (cheap context check). */
export function isCriteriaWorkerEvalTask(context: unknown): boolean {
  return readMarker(context) !== null;
}

function sameQuestion(marker: CriteriaWorkerEvalContext, criteria: WorkerEvalCriterionInput[]): boolean {
  if (marker.criterionIndices.length !== criteria.length) return false;
  const asked = marker.criterionIndices.map((idx, i) => `${idx}:${marker.fingerprints?.[i] ?? ''}`).sort();
  const want = criteria.map(c => `${c.index}:${c.fingerprint ?? ''}`).sort();
  return asked.every((v, i) => v === want[i]);
}

function returnedVerdicts(result: unknown): boolean {
  const s = (result as Record<string, unknown> | null)?.structuredOutput;
  return parseVerdicts(s).length > 0;
}

/**
 * Ensure covered criteria have, or are about to have, a verdict from a worker task.
 *
 * Returns `pending` when a task is in flight or has just been dispatched,
 * and `unavailable` when dispatch is impossible (no workspace, no workspace path).
 */
export async function resolveCriteriaWorkerEval(opts: {
  missionId: string;
  criteria: WorkerEvalCriterionInput[];
  now?: number;
}): Promise<CriteriaWorkerEvalResolution> {
  const { missionId, criteria } = opts;
  const now = opts.now ?? Date.now();

  if (criteria.length === 0) {
    return { kind: 'unavailable', evidence: 'No criteria to evaluate' };
  }

  const mission = await db.query.missions.findFirst({
    where: eq(missions.id, missionId),
    columns: { id: true, title: true, description: true, workspaceId: true, workingBranch: true },
  });
  if (!mission) return { kind: 'unavailable', evidence: `Mission ${missionId} not found` };

  if (!mission.workspaceId) {
    return {
      kind: 'unavailable',
      evidence: 'Criteria cannot be worker-evaluated: mission has no workspace (nowhere to clone the repo)',
    };
  }

  const existing = await findWorkerEvalTask(missionId);
  if (existing) {
    const marker = readMarker(existing.context)!;
    const terminal = ['completed', 'failed', 'cancelled'].includes(existing.status);

    if (!terminal) {
      const waitedMs = now - new Date(existing.updatedAt).getTime();
      const stalled = waitedMs > 2 * WORKER_EVAL_TTL_MS;
      return {
        kind: 'pending',
        taskId: existing.id,
        evidence: stalled
          ? `Worker evaluator ${existing.id.slice(0, 8)} has been ${existing.status} for ${Math.round(waitedMs / 60000)}m — no runner has claimed it`
          : `Worker evaluator ${existing.id.slice(0, 8)} is ${existing.status} — evaluation in progress`,
      };
    }

    const age = now - new Date(existing.updatedAt).getTime();
    if (sameQuestion(marker, criteria) && age < WORKER_EVAL_TTL_MS && !returnedVerdicts(existing.result)) {
      // Finished without usable verdicts. Re-dispatching now would spend a real
      // agent run on the same empty answer every evaluation round.
      return {
        kind: 'unavailable',
        evidence: `Worker evaluator ${existing.id.slice(0, 8)} finished without returning verdicts — will retry after ${Math.round(WORKER_EVAL_TTL_MS / 60000)}m`,
      };
    }
    // Stale, criteria changed, or verdicts are gone — dispatch a fresh task.
  }

  const dispatched = await dispatchWorkerEvalTask({ mission, criteria });
  if (!dispatched.ok) return { kind: 'unavailable', evidence: dispatched.reason };
  return {
    kind: 'pending',
    taskId: dispatched.taskId,
    evidence: `Worker evaluator ${dispatched.taskId.slice(0, 8)} dispatched — evaluating ${criteria.length} criteri${criteria.length === 1 ? 'on' : 'a'}`,
  };
}

function buildEvalPrompt(
  mission: { title: string; description: string | null; workingBranch: string | null },
  criteria: WorkerEvalCriterionInput[],
): string {
  const criteriaList = criteria.map(c => {
    const label = c.type === 'command'
      ? `[COMMAND] index=${c.index}: run \`${c.text}\` and report the exit code`
      : `[PROSE] index=${c.index}: ${c.text}`;
    return label;
  }).join('\n');

  const commandCriteria = criteria.filter(c => c.type === 'command');
  const proseCriteria = criteria.filter(c => c.type !== 'command');

  return `## Goal criteria evaluation

Mission: **${mission.title}**
${mission.description ? `\n${mission.description}\n` : ''}
${mission.workingBranch ? `Working branch: \`${mission.workingBranch}\`\n` : ''}
You are evaluating this mission's goal criteria. This is a **read-only verification task**:
- Do NOT change code.
- Do NOT open PRs or create tasks.
- Do NOT fix failures you find — only report what you observe.

### Criteria to evaluate (${criteria.length})
${criteriaList}

${commandCriteria.length > 0 ? `### Command criteria (${commandCriteria.length})
For each command criterion:
1. Run the command exactly as written using Bash.
2. Observe the exit code and any relevant output.
3. \`pass\` if it exits 0; \`fail\` if it exits non-zero or errors; \`UNVERIFIED\` if you cannot run it.
4. In \`evidence\`, state the exit code and any key output line.

` : ''}${proseCriteria.length > 0 ? `### Prose criteria (${proseCriteria.length})
For each prose criterion:
1. Read the repository to find relevant evidence.
2. \`pass\` if the evidence directly supports the criterion.
3. \`fail\` if the evidence directly contradicts it.
4. \`UNVERIFIED\` if evidence is absent, ambiguous, or insufficient.

` : ''}### Output
Return one entry per criterion via your outputSchema using the SAME \`index\` values
listed above. Keep your turn short — observe, judge, report.`;
}

async function dispatchWorkerEvalTask(opts: {
  mission: { id: string; title: string; description: string | null; workspaceId: string | null; workingBranch: string | null };
  criteria: WorkerEvalCriterionInput[];
}): Promise<{ ok: true; taskId: string } | { ok: false; reason: string }> {
  const { mission, criteria } = opts;
  if (!mission.workspaceId) return { ok: false, reason: 'No workspace for worker eval dispatch' };

  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, mission.workspaceId),
  });
  if (!workspace) return { ok: false, reason: 'Workspace not found for worker eval dispatch' };

  const evalContext: CriteriaWorkerEvalContext = {
    missionId: mission.id,
    criterionIndices: criteria.map(c => c.index),
    fingerprints: criteria.map(c => c.fingerprint ?? ''),
  };

  const title = `${EVAL_TASK_TITLE_PREFIX} ${mission.title}`.slice(0, 200);
  const description = buildEvalPrompt(mission, criteria);

  const [task] = await db
    .insert(tasks)
    .values({
      workspaceId: mission.workspaceId,
      missionId: mission.id,
      title,
      description,
      priority: 2,
      status: 'pending',
      mode: 'execution',
      // Bookkeeping: an evaluator task counted as a deliverable would keep the
      // mission's pending count above zero and block the completion its verdict gates.
      taskClass: 'bookkeeping',
      creationSource: 'orchestrator',
      outputRequirement: 'none',
      tier: 'budget',
      outputSchema: WORKER_EVAL_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
      context: {
        criteriaWorkerEval: evalContext,
        // Opt out of auto-retry: one honest evaluation run, not a silent second attempt.
        retryCount: 1,
      },
    } as any)
    .returning({ id: tasks.id });

  if (!task) return { ok: false, reason: 'Worker eval task insert returned no row' };

  await dispatchNewTask(
    { id: task.id, title, description: null, workspaceId: mission.workspaceId, mode: 'execution', priority: 2, missionId: mission.id },
    workspace as any,
  ).catch(e => console.error(`[criteria-worker-eval] dispatch failed for task ${task.id}:`, e));

  console.log(
    `[criteria-worker-eval] mission ${mission.id}: dispatched ${task.id} to evaluate criteria [${evalContext.criterionIndices.join(', ')}]`
  );
  return { ok: true, taskId: task.id };
}

interface ParsedVerdict {
  index: number;
  verdict: CriterionVerdict;
  evidence: string;
  evidenceRef?: GoalCriteriaEvidenceRef;
}

function parseVerdicts(structuredOutput: unknown): ParsedVerdict[] {
  if (!structuredOutput || typeof structuredOutput !== 'object') return [];
  const raw = (structuredOutput as Record<string, unknown>).criteriaVerdicts;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((v: any) => {
    if (!v || typeof v.index !== 'number') return [];
    const verdict = (['pass', 'fail', 'UNVERIFIED'].includes(v.verdict) ? v.verdict : 'UNVERIFIED') as CriterionVerdict;
    const result: ParsedVerdict = {
      index: v.index,
      verdict,
      evidence: typeof v.evidence === 'string' ? v.evidence : '',
    };
    if (v.evidenceRef && typeof v.evidenceRef === 'object' && v.evidenceRef !== null) {
      result.evidenceRef = v.evidenceRef as GoalCriteriaEvidenceRef;
    }
    return [result];
  });
}

/**
 * Apply a finished worker eval task's verdicts back to mission criteria state.
 *
 * Called from the worker-completion hooks for any task carrying a
 * `criteriaWorkerEval` marker. A task that fails, times out, or is reaped without
 * returning verdicts leaves each criterion NOT_EVALUATED with a reason naming the
 * failed task — never a silent pass. Re-folds `overall` and re-attempts completion.
 */
export async function handleCriteriaWorkerEvalOutcome(
  taskId: string,
  structuredOutput?: unknown,
): Promise<{ applied: boolean }> {
  const task = await db.query.tasks.findFirst({
    where: eq(tasks.id, taskId),
    columns: { id: true, status: true, context: true, result: true, missionId: true },
  });
  if (!task) return { applied: false };

  const marker = readMarker(task.context);
  if (!marker || !task.missionId) return { applied: false };

  if (!['completed', 'failed', 'cancelled'].includes(task.status)) return { applied: false };

  const mission = await db.query.missions.findFirst({
    where: eq(missions.id, task.missionId),
    columns: { id: true, goalCriteria: true, goalCriteriaState: true },
  });
  const state = (mission?.goalCriteriaState ?? null) as GoalCriteriaState | null;
  if (!state) return { applied: false };

  const fromRequest = parseVerdicts(structuredOutput);
  const verdicts = fromRequest.length > 0
    ? fromRequest
    : parseVerdicts((task.result as Record<string, unknown> | null)?.structuredOutput);

  const currentCriteria = Array.isArray(mission?.goalCriteria)
    ? mission!.goalCriteria as Array<Record<string, unknown>>
    : [];

  let applied = false;

  marker.criterionIndices.forEach((index, i) => {
    const cs = state.criteria.find(c => c.index === index);
    if (!cs) return;

    // Identity check: the criteria array may have been edited while this task ran.
    // Writing a verdict onto a different criterion at the same index is a transplant.
    const askedFingerprint = marker.fingerprints?.[i] ?? '';
    const currentAtIndex = currentCriteria[index];
    const fingerprintMatches =
      askedFingerprint === '' ||
      cs.fingerprint === undefined ||
      cs.fingerprint === askedFingerprint;
    const typeStillValid = currentAtIndex?.type !== undefined;

    if (!typeStillValid || !fingerprintMatches) {
      console.warn(
        `[criteria-worker-eval] mission ${task.missionId} criterion ${index} changed while task ${task.id} ran — discarding its verdict`
      );
      cs.verdict = 'NOT_EVALUATED';
      cs.evidence = 'Criterion was edited while the evaluator ran — grading again on the next round';
      return;
    }

    const v = verdicts.find(x => x.index === index);
    if (!v) {
      // The task finished but returned nothing for this criterion — this is a
      // failure mode, not a pass. Name the task so an operator can inspect it.
      cs.verdict = 'NOT_EVALUATED';
      cs.evidence = `Worker evaluator task ${task.id.slice(0, 8)} ${task.status === 'failed' ? 'failed' : 'did not return a verdict for this criterion'}`;
      return;
    }

    cs.verdict = v.verdict;
    cs.evidence = v.evidence || `Graded ${v.verdict} by worker evaluator ${task.id.slice(0, 8)}`;
    cs.workerTaskId = task.id;
    if (v.evidenceRef) cs.evidenceRefs = [v.evidenceRef];
    applied = true;
  });

  const next: GoalCriteriaState = {
    ...state,
    evaluatedAt: new Date().toISOString(),
    overall: recalculateOverall(state.criteria),
    criteria: state.criteria,
  };

  await db
    .update(missions)
    .set({ goalCriteriaState: next as any, updatedAt: new Date() })
    .where(eq(missions.id, task.missionId));

  console.log(
    `[criteria-worker-eval] mission ${task.missionId}: applied ${verdicts.length} verdict(s) from ${task.id}; overall ${next.overall}`
  );

  // A criterion turning green is a completion trigger in its own right.
  const { completeMissionIfVerified } = await import('@/lib/mission-completion');
  await completeMissionIfVerified(task.missionId, {
    path: 'criteria_eval',
    predicate: `worker evaluator task ${task.id}`,
    evaluateCriteria: false,
  }).catch(e => console.error(`[criteria-worker-eval] completion attempt failed for ${task.missionId}:`, e));

  return { applied: applied || marker.criterionIndices.length > 0 };
}
