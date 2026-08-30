import { db } from '@buildd/core/db';
import { missions, tasks, workspaces, secrets } from '@buildd/core/db/schema';
import { eq, and, or, desc, sql } from 'drizzle-orm';
import { recalculateOverall } from '@buildd/core/mission-helpers';
import type { GoalCriteriaState, CriterionVerdict } from '@buildd/shared';
import { dispatchNewTask } from '@/lib/task-dispatch';

/**
 * `description` (prose) goal criteria: graded by a dispatched agent.
 *
 * The original prose evaluator called the Anthropic Messages API inline from the
 * web app, keyed on `process.env.ANTHROPIC_API_KEY`. That key is not set in
 * production and — for a team whose Claude access is an OAuth subscription
 * rather than a metered API key — cannot be. The result was that every prose
 * criterion reported `NOT_EVALUATED: LLM evaluator not configured (no
 * ANTHROPIC_API_KEY)`, naming an env var no operator could usefully set, and no
 * mission with a prose criterion could ever reach a verdict.
 *
 * This module removes the env-var dependency the same way
 * `mission-criteria-verify.ts` removed it for `command` criteria: dispatch a
 * task. A runner claims it with whatever backend credential the team has
 * connected (OAuth token, API key, Codex — the claim route already resolves and
 * fails over between them), grades the criteria against the embedded evidence,
 * and returns verdicts as structured output.
 *
 * Flow:
 *   1. `resolveProseCriteria` finds an in-flight evaluator task or dispatches
 *      one, and reports `pending`. The caller marks those criteria PENDING.
 *   2. `handleProseEvalOutcome` — called from the worker-completion hooks — reads
 *      `criteriaVerdicts` off the structured output, writes them onto the
 *      criteria, re-folds `overall`, and re-attempts completion.
 *
 * What this does NOT change: a prose verdict is still a model's judgment, which
 * is why `command` remains the criterion type to prefer. The difference is only
 * that the judgment now happens where the credentials are.
 */

/** Context marker on a prose-eval task, read back on completion. */
export interface ProseEvalContext {
  missionId: string;
  /** Criterion indices this task was asked to grade. */
  criterionIndices: number[];
  /**
   * Criterion fingerprints, parallel to `criterionIndices`. Checked on write-back:
   * an index alone is a position, and positions get reused when criteria are edited.
   */
  fingerprints: string[];
}

/**
 * How long a prose grading run stays authoritative.
 *
 * Also the loop guard: a run that finished without usable verdicts is not retried
 * until this elapses, so a mission whose evaluator keeps coming back empty costs
 * one agent run per TTL rather than one per evaluation round.
 */
export const PROSE_VERDICT_TTL_MS = 30 * 60 * 1000;

const EVAL_TASK_TITLE_PREFIX = 'Grade goal criteria:';

/** Backend credentials a runner can actually grade with. */
const AGENT_BACKEND_PURPOSES = ['oauth_token', 'anthropic_api_key', 'claude_credential', 'codex_credential'] as const;

/** JSON Schema handed to the SDK's outputFormat so verdicts return machine-readable. */
export const PROSE_EVAL_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['criteriaVerdicts'],
  properties: {
    criteriaVerdicts: {
      type: 'array',
      description: 'One entry per criterion you were asked to grade',
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
            description: 'pass = evidence supports it, fail = evidence contradicts it, UNVERIFIED = evidence insufficient',
          },
          evidence: {
            type: 'string',
            description: 'One sentence citing the specific [task:…] or [artifact:…] ref that justifies the verdict',
          },
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
} as const;

export interface ProseCriterionInput {
  index: number;
  text: string;
  fingerprint?: string;
}

export interface ProseEvidence {
  tasks: Array<{ id: string; title: string | null; summary: string | undefined }>;
  artifacts: Array<{ id: string; title: string | null; type: string; contentSnippet: string | null }>;
}

export type ProseCriteriaResolution =
  | { kind: 'pending'; taskId: string; evidence: string }
  | { kind: 'unavailable'; evidence: string };

/**
 * In-flight or recently-terminal prose-eval task for this mission, if any.
 *
 * Matched on the marker in SQL rather than by scanning recent bookkeeping rows: a
 * heartbeat mission writes a bookkeeping planning row every cycle, so any fixed
 * window eventually contains nothing but heartbeat rows and the dedupe goes dead
 * — which would dispatch a duplicate evaluator on every evaluation round.
 */
async function findProseEvalTask(missionId: string) {
  const rows = await db.query.tasks.findMany({
    where: and(
      eq(tasks.missionId, missionId),
      sql`${tasks.context} -> 'criteriaProseEval' ->> 'missionId' = ${missionId}`,
    ),
    columns: { id: true, status: true, context: true, result: true, updatedAt: true },
    orderBy: [desc(tasks.createdAt)],
    limit: 5,
  });
  // Re-check in JS so a mocked or loose `where` can never widen the match.
  return rows.find(r => readMarker(r.context)?.missionId === missionId) ?? null;
}

function readMarker(context: unknown): ProseEvalContext | null {
  const marker = (context as Record<string, unknown> | null)?.criteriaProseEval as ProseEvalContext | undefined;
  if (!marker || typeof marker.missionId !== 'string' || !Array.isArray(marker.criterionIndices)) return null;
  return marker;
}

/** True when this task is a prose criteria evaluator task (cheap context check). */
export function isProseEvalTask(context: unknown): boolean {
  return readMarker(context) !== null;
}

function sameQuestion(marker: ProseEvalContext, criteria: ProseCriterionInput[]): boolean {
  if (marker.criterionIndices.length !== criteria.length) return false;
  const asked = marker.criterionIndices.map((idx, i) => `${idx}:${marker.fingerprints?.[i] ?? ''}`).sort();
  const want = criteria.map(c => `${c.index}:${c.fingerprint ?? ''}`).sort();
  return asked.every((v, i) => v === want[i]);
}

function returnedVerdicts(result: unknown): boolean {
  const structured = (result as Record<string, unknown> | null)?.structuredOutput;
  return parseVerdicts(structured).length > 0;
}

/**
 * True when the team has a credential a runner could grade with.
 *
 * Cheap pre-check with one purpose: when the answer is no, the criterion says so
 * and names the screen that fixes it, instead of dispatching a task that no
 * runner can ever claim and reporting a stall thirty minutes later.
 */
async function hasAgentBackendCredential(teamId: string | null): Promise<boolean> {
  if (!teamId) return false;
  const row = await db.query.secrets.findFirst({
    where: and(
      eq(secrets.teamId, teamId),
      or(...AGENT_BACKEND_PURPOSES.map(p => eq(secrets.purpose, p))),
    ),
    columns: { id: true },
  });
  return !!row;
}

/**
 * Ensure a mission's prose criteria have, or are about to have, a real verdict.
 *
 * Returns `pending` when a grading run is in flight or has just been dispatched,
 * and `unavailable` when there is nowhere to run one — which correctly leaves the
 * criteria unevaluated rather than passing them by default.
 */
export async function resolveProseCriteria(opts: {
  missionId: string;
  criteria: ProseCriterionInput[];
  evidence: ProseEvidence;
  now?: number;
}): Promise<ProseCriteriaResolution> {
  const { missionId, criteria, evidence } = opts;
  const now = opts.now ?? Date.now();

  if (criteria.length === 0) {
    return { kind: 'unavailable', evidence: 'No prose criteria to grade' };
  }

  const mission = await db.query.missions.findFirst({
    where: eq(missions.id, missionId),
    columns: { id: true, title: true, description: true, teamId: true, workspaceId: true },
  });
  if (!mission) return { kind: 'unavailable', evidence: `Mission ${missionId} not found` };

  if (!mission.workspaceId) {
    return {
      kind: 'unavailable',
      evidence: 'Prose criteria cannot be graded: mission has no workspace (nowhere to run an evaluator)',
    };
  }

  if (!(await hasAgentBackendCredential(mission.teamId))) {
    return {
      kind: 'unavailable',
      evidence: 'Prose criteria cannot be graded: no agent backend credential is connected — connect one in Settings → Agent Backends',
    };
  }

  const existing = await findProseEvalTask(missionId);
  if (existing) {
    const marker = readMarker(existing.context)!;
    const terminal = ['completed', 'failed', 'cancelled'].includes(existing.status);

    if (!terminal) {
      const waitedMs = now - new Date(existing.updatedAt).getTime();
      const stalled = waitedMs > 2 * PROSE_VERDICT_TTL_MS;
      return {
        kind: 'pending',
        taskId: existing.id,
        evidence: stalled
          ? `Evaluator task ${existing.id.slice(0, 8)} has been ${existing.status} for ${Math.round(waitedMs / 60000)}m — no runner has claimed it`
          : `Evaluator task ${existing.id.slice(0, 8)} is ${existing.status} — grading in progress`,
      };
    }

    const age = now - new Date(existing.updatedAt).getTime();
    if (sameQuestion(marker, criteria) && age < PROSE_VERDICT_TTL_MS && !returnedVerdicts(existing.result)) {
      // The run finished and produced nothing usable. Re-dispatching now would
      // spend a real agent run on the same empty answer every evaluation round.
      return {
        kind: 'unavailable',
        evidence: `Evaluator task ${existing.id.slice(0, 8)} finished without returning verdicts — will retry after ${Math.round(PROSE_VERDICT_TTL_MS / 60000)}m`,
      };
    }
    // Stale, the criteria changed, or the verdicts have since gone stale — grade again.
  }

  const dispatched = await dispatchProseEvalTask({ mission, criteria, evidence });
  if (!dispatched.ok) return { kind: 'unavailable', evidence: dispatched.reason };
  return {
    kind: 'pending',
    taskId: dispatched.taskId,
    evidence: `Evaluator task ${dispatched.taskId.slice(0, 8)} dispatched — grading ${criteria.length} criteri${criteria.length === 1 ? 'on' : 'a'}`,
  };
}

function buildEvaluatorPrompt(
  mission: { title: string; description: string | null },
  criteria: ProseCriterionInput[],
  evidence: ProseEvidence,
): string {
  const taskEvidence = evidence.tasks.map(t =>
    `[task:${t.id.slice(0, 8)}] "${t.title ?? '(untitled)'}"${t.summary ? `\nSummary: ${t.summary}` : ' (no summary)'}`,
  ).join('\n\n');

  const artifactEvidence = evidence.artifacts.map(a =>
    `[artifact:${a.id.slice(0, 8)}] "${a.title ?? '(untitled)'}" (${a.type})${a.contentSnippet ? `\nContent:\n${a.contentSnippet}` : ''}`,
  ).join('\n\n');

  const hasEvidence = evidence.tasks.length > 0 || evidence.artifacts.length > 0;
  const criteriaList = criteria.map(c => `- index=${c.index}: ${c.text}`).join('\n');

  return `## Goal criteria grading

Mission: **${mission.title}**
${mission.description ? `\n${mission.description}\n` : ''}
You are grading this mission's prose criteria against the evidence below. This is
a read-only judgment task: do NOT change code, do NOT open a PR, do NOT create
tasks, do NOT fix anything you notice. Read the evidence, decide, return verdicts.

### Criteria to grade (${criteria.length})
${criteriaList}

### Evidence — completed tasks (${evidence.tasks.length})
${taskEvidence || '(none)'}

### Evidence — artifacts (${evidence.artifacts.length})
${artifactEvidence || '(none)'}
${hasEvidence ? '' : '\n⚠️ There is no evidence to read. Return UNVERIFIED for every criterion.\n'}
### How to grade
- \`pass\` — the evidence directly supports the criterion being satisfied.
- \`fail\` — the evidence directly contradicts it.
- \`UNVERIFIED\` — the evidence is absent, ambiguous, or insufficient. This is the
  honest answer far more often than \`pass\`; a criterion you cannot check from the
  evidence above is not satisfied, and guessing \`pass\` completes a mission that
  nobody verified.

You may read the repository to check a claim. You may not act on what you find.

### Output
Return one entry per criterion via your outputSchema, using the SAME \`index\`
values listed above, each citing the specific [task:…] or [artifact:…] ref that
justifies it. Keep your turn short.`;
}

/**
 * Create + dispatch the prose grading task.
 *
 * Fails cleanly (never throws) rather than letting a dispatch problem surface as
 * a 500 on the operator's "Run verification" button.
 */
async function dispatchProseEvalTask(opts: {
  mission: { id: string; title: string; description: string | null; workspaceId: string | null };
  criteria: ProseCriterionInput[];
  evidence: ProseEvidence;
}): Promise<{ ok: true; taskId: string } | { ok: false; reason: string }> {
  const { mission, criteria, evidence } = opts;
  if (!mission.workspaceId) return { ok: false, reason: 'Prose criteria cannot be graded: mission has no workspace' };

  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, mission.workspaceId),
  });
  if (!workspace) return { ok: false, reason: 'Prose criteria cannot be graded: workspace not found' };

  const evalContext: ProseEvalContext = {
    missionId: mission.id,
    criterionIndices: criteria.map(c => c.index),
    fingerprints: criteria.map(c => c.fingerprint ?? ''),
  };

  const title = `${EVAL_TASK_TITLE_PREFIX} ${mission.title}`.slice(0, 200);
  const description = buildEvaluatorPrompt(mission, criteria, evidence);

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
      // Bookkeeping: an evaluator counted as a deliverable would keep the
      // mission's pending count above zero and block the completion its own
      // verdict gates — the criterion would block on itself.
      taskClass: 'bookkeeping',
      creationSource: 'orchestrator',
      outputRequirement: 'none',
      tier: 'budget',
      outputSchema: PROSE_EVAL_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
      context: {
        criteriaProseEval: evalContext,
        // Opt out of the mission-task auto-retry: one honest grading run, and a
        // silent second attempt would only delay the verdict.
        retryCount: 1,
      },
    } as any)
    .returning({ id: tasks.id });

  if (!task) return { ok: false, reason: 'Prose evaluator task insert returned no row' };

  await dispatchNewTask(
    { id: task.id, title, description: null, workspaceId: mission.workspaceId, mode: 'execution', priority: 2, missionId: mission.id },
    workspace as any,
  ).catch(e => console.error(`[criteria-prose] dispatch failed for task ${task.id}:`, e));

  console.log(
    `[criteria-prose] mission ${mission.id}: dispatched ${task.id} to grade criteria [${evalContext.criterionIndices.join(', ')}]`
  );
  return { ok: true, taskId: task.id };
}

interface ParsedVerdict {
  index: number;
  verdict: CriterionVerdict;
  evidence: string;
}

function parseVerdicts(structuredOutput: unknown): ParsedVerdict[] {
  if (!structuredOutput || typeof structuredOutput !== 'object') return [];
  const raw = (structuredOutput as Record<string, unknown>).criteriaVerdicts;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((v: any) => {
    if (!v || typeof v.index !== 'number') return [];
    // An unrecognised verdict string is not a pass. Coerce, never trust.
    const verdict = (['pass', 'fail', 'UNVERIFIED'].includes(v.verdict) ? v.verdict : 'UNVERIFIED') as CriterionVerdict;
    return [{ index: v.index, verdict, evidence: typeof v.evidence === 'string' ? v.evidence : '' }];
  });
}

/**
 * Hand a finished prose-eval task's verdicts back to the criteria they answer.
 *
 * Called from the worker-completion hooks for any task carrying a
 * `criteriaProseEval` marker. Writes the verdicts onto the mission's stored
 * criteria state, re-folds `overall`, then re-attempts completion — so a
 * criterion turning green is itself a completion trigger.
 *
 * Every criterion in the marker leaves this function with a non-PENDING verdict,
 * including the ones the evaluator ignored: a criterion left PENDING with no task
 * in flight holds the mission open with nothing remaining that could resolve it.
 */
export async function handleProseEvalOutcome(
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

  // Not terminal yet (e.g. requeued for another attempt) — the verdict is still owed.
  if (!['completed', 'failed', 'cancelled'].includes(task.status)) return { applied: false };

  const mission = await db.query.missions.findFirst({
    where: eq(missions.id, task.missionId),
    columns: { id: true, goalCriteria: true, goalCriteriaState: true },
  });
  const state = (mission?.goalCriteriaState ?? null) as GoalCriteriaState | null;
  if (!state) return { applied: false };

  // Structured output arrives on the completion request; fall back to whatever the
  // completion route persisted onto the task result.
  const fromRequest = parseVerdicts(structuredOutput);
  const verdicts = fromRequest.length > 0
    ? fromRequest
    : parseVerdicts((task.result as Record<string, unknown> | null)?.structuredOutput);

  if (verdicts.length === 0) {
    console.warn(`[criteria-prose] task ${task.id} finished (${task.status}) with no usable criteriaVerdicts`);
  }

  const currentCriteria = Array.isArray(mission?.goalCriteria)
    ? mission!.goalCriteria as Array<Record<string, unknown>>
    : [];

  let applied = false;

  marker.criterionIndices.forEach((index, i) => {
    const cs = state.criteria.find(c => c.index === index);
    if (!cs) return;

    // Identity check. The criteria array may have been edited while this task was
    // in flight, in which case index `n` now points at a different claim and
    // writing this verdict onto it would be a verdict transplant.
    const askedFingerprint = marker.fingerprints?.[i] ?? '';
    const stillTheSame =
      currentCriteria[index]?.type === 'description' &&
      (askedFingerprint === '' || cs.fingerprint === undefined || cs.fingerprint === askedFingerprint);

    if (!stillTheSame) {
      console.warn(
        `[criteria-prose] mission ${task.missionId} criterion ${index} changed while task ${task.id} ran — discarding its verdict`
      );
      cs.verdict = 'NOT_EVALUATED';
      cs.evidence = 'Criterion was edited while the evaluator ran — grading again on the next round';
      return;
    }

    const v = verdicts.find(x => x.index === index);
    if (!v) {
      cs.verdict = 'NOT_EVALUATED';
      cs.evidence = `Evaluator task ${task.id.slice(0, 8)} did not return a verdict for this criterion`;
      return;
    }

    cs.verdict = v.verdict;
    cs.evidence = v.evidence || `Graded ${v.verdict} by evaluator task ${task.id.slice(0, 8)}`;
    cs.workerTaskId = task.id;
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
    `[criteria-prose] mission ${task.missionId}: applied ${verdicts.length} verdict(s) from ${task.id}; overall ${next.overall}`
  );

  // A criterion turning green is a completion trigger in its own right. Reuse the
  // verdict just written — re-evaluating here would re-dispatch the evaluator we
  // are currently hearing back from.
  const { completeMissionIfVerified } = await import('@/lib/mission-completion');
  await completeMissionIfVerified(task.missionId, {
    path: 'criteria_eval',
    predicate: `prose evaluator task ${task.id}`,
    evaluateCriteria: false,
  }).catch(e => console.error(`[criteria-prose] completion attempt failed for ${task.missionId}:`, e));

  // A failed evaluator that returned nothing still resolved the criteria — off
  // PENDING and onto NOT_EVALUATED — which is a state change worth reporting.
  return { applied: applied || marker.criterionIndices.length > 0 };
}
