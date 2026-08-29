import { db } from '@buildd/core/db';
import { missions, tasks, workers, artifacts, missionNotes } from '@buildd/core/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { evaluateGoalCriteria, recalculateOverall } from '@buildd/core/mission-helpers';
import type { GoalCriterion, GoalCriteriaState, CriterionVerdict, GoalCriteriaEvidenceRef } from '@buildd/shared';
import { resolveTierEntrySync } from '@buildd/core/model-tier-registry';
import { resolveCommandCriterion } from './mission-criteria-verify';

/**
 * Producer of goal-criteria verdicts.
 *
 * This module answers "what is the verdict?" and never "is the mission done?" —
 * that decision belongs to `mission-completion.ts`, which calls
 * `ensureCriteriaVerdict` when a verdict is owed. Keeping the producer out of the
 * completion business is what breaks the old deadlock: the evaluator used to
 * refuse to run while pending tasks remained, while the completion path was not
 * required to have a verdict at all, so the one function that could have produced
 * verdicts only spoke when they no longer mattered.
 *
 * Freshness, not one-shot. The previous implementation skipped whenever
 * `goalCriteriaState` existed, which made every verdict a permanent snapshot: a
 * mission that passed in June still read `pass` today even if the behaviour had
 * since regressed. Mechanical criteria are now re-checked on every request (they
 * are a DB query), command criteria are re-run once their last run ages past
 * COMMAND_VERDICT_TTL_MS, and only LLM grading is cached — for LLM_REVERIFY_MS,
 * because it costs tokens.
 */

/** Re-exported so callers have one import site for the folding rule. */
export { recalculateOverall } from '@buildd/core/mission-helpers';

const LLM_MAX_TOKENS = 2048;
const LLM_TIMEOUT_MS = 20_000;
const ARTIFACT_CONTENT_LIMIT = 3000;

/** How long an LLM-graded verdict is reused before the model is asked again. */
export const LLM_REVERIFY_MS = 30 * 60 * 1000;

/** Floor between two automatic evaluations of the same mission. */
export const AUTO_EVAL_DEBOUNCE_MS = 30 * 1000;

export const ON_COMPLETION_NOTE_TITLE = 'Goal criteria evaluated (on-completion)';
export const ON_DEMAND_NOTE_TITLE = 'Goal criteria evaluated (on-demand)';

type EvidenceTask = { id: string; title: string | null; summary: string | undefined };
type EvidenceArtifact = { id: string; title: string | null; type: string; contentSnippet: string | null };

interface LLMCriterionInput { index: number; text: string }
interface LLMCriterionVerdict {
  index: number;
  verdict: CriterionVerdict;
  evidence: string;
  evidenceRef?: GoalCriteriaEvidenceRef;
}

/**
 * Criterion types whose verdict may be produced by an LLM reading evidence.
 *
 * `command` is deliberately excluded: a model cannot know whether `bun test`
 * exits 0, and asking it to guess is how a prose verdict ends up standing in for
 * a mechanical one. Structural types are decided from DB state, and `metric`
 * needs the (unimplemented) metric-query registry.
 */
export function isLlmEligible(type: string): boolean {
  return !['artifact_exists', 'no_open_tasks', 'all_prs_merged', 'metric', 'command'].includes(type);
}

export function criterionText(criterion: GoalCriterion): string {
  if (criterion.type === 'description') return criterion.description;
  if (criterion.type === 'command') return criterion.label ?? criterion.command;
  return criterion.label ?? criterion.type;
}

async function judgeWithLLM(
  inputs: LLMCriterionInput[],
  missionTitle: string,
  missionDescription: string | null,
  completedTasks: EvidenceTask[],
  evidenceArtifacts: EvidenceArtifact[],
  anthropicApiKey: string,
): Promise<LLMCriterionVerdict[]> {
  const taskEvidence = completedTasks.map(t =>
    `[task:${t.id.slice(0, 8)}] "${t.title ?? '(untitled)'}"${t.summary ? `\nSummary: ${t.summary}` : ' (no summary)'}`,
  ).join('\n\n');

  const artifactEvidence = evidenceArtifacts.map(a =>
    `[artifact:${a.id.slice(0, 8)}] "${a.title ?? '(untitled)'}" (${a.type})${a.contentSnippet ? `\nContent snippet:\n${a.contentSnippet}` : ''}`,
  ).join('\n\n');

  const criteriaList = inputs.map((c, i) => `${i + 1}. index=${c.index}: ${c.text}`).join('\n');
  const hasEvidence = completedTasks.length > 0 || evidenceArtifacts.length > 0;

  const systemPrompt = `You are evaluating whether a mission's completion criteria are met based on available evidence.
Be evidence-grounded: only return "pass" if evidence directly supports the criterion being satisfied.
Return "UNVERIFIED" when evidence is ambiguous or absent — not "fail".
Return "fail" only when evidence clearly contradicts the criterion.
Respond ONLY with a JSON object — no prose, no markdown fences.`;

  const userPrompt = `## Mission: ${missionTitle}
${missionDescription ? `Description: ${missionDescription}\n` : ''}

## Criteria to evaluate (${inputs.length}):
${criteriaList}

## Evidence

### Completed tasks (${completedTasks.length}):
${taskEvidence || '(none)'}

### Artifacts (${evidenceArtifacts.length}):
${artifactEvidence || '(none)'}

${!hasEvidence ? '⚠️  No evidence available. Return UNVERIFIED for all criteria.\n' : ''}
## Instructions
For each criterion above, determine whether the evidence shows it is met, not met, or unverifiable.
Cite the specific evidence item (use the [task:XXXXXXXX] or [artifact:XXXXXXXX] ref from above).

Respond with exactly this JSON shape:
{
  "verdicts": [
    {
      "index": <criterion index number>,
      "verdict": "pass" | "fail" | "UNVERIFIED",
      "evidence": "<one sentence citing specific evidence, or 'No relevant evidence found'>",
      "evidenceRef": { "type": "artifact" | "task", "id": "<full UUID>", "title": "<title>" } | null
    }
  ]
}`;

  let resp: Response;
  try {
    resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicApiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: resolveTierEntrySync('budget').model,
        max_tokens: LLM_MAX_TOKENS,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
      // This call sits inside the worker-completion request and the cron tick. An
      // unbounded fetch to a degraded provider would hang both.
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });
  } catch (err) {
    console.error('[criteria-eval/llm] fetch error:', err);
    return [];
  }

  if (!resp.ok) {
    const bodyText = await resp.text().catch(() => '');
    console.error(`[criteria-eval/llm] API error ${resp.status}: ${bodyText.substring(0, 200)}`);
    return [];
  }

  const data = await resp.json() as { content?: Array<{ type: string; text?: string }> };
  const text = data.content?.find(b => b.type === 'text')?.text ?? '';

  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch?.[0]) throw new Error('no JSON found');
    const parsed = JSON.parse(jsonMatch[0]) as { verdicts?: unknown[] };
    if (!Array.isArray(parsed.verdicts)) throw new Error('missing verdicts array');

    return (parsed.verdicts as any[]).map(v => ({
      index: v.index as number,
      verdict: (['pass', 'fail', 'UNVERIFIED'].includes(v.verdict) ? v.verdict : 'UNVERIFIED') as CriterionVerdict,
      evidence: typeof v.evidence === 'string' ? v.evidence : '',
      ...(v.evidenceRef && typeof v.evidenceRef === 'object' && v.evidenceRef !== null
        ? { evidenceRef: v.evidenceRef as GoalCriteriaEvidenceRef }
        : {}),
    }));
  } catch (parseErr) {
    console.error('[criteria-eval/llm] parse error:', parseErr, '| raw:', text.substring(0, 200));
    return [];
  }
}

/**
 * Evaluate every criterion now and persist the result. One implementation,
 * shared by the automatic path (`ensureCriteriaVerdict`) and the on-demand
 * route, so the two can never disagree about what a criterion means.
 *
 * Never writes `missions.status` — completion is `mission-completion.ts`'s job.
 */
export async function evaluateCriteriaNow(
  missionId: string,
  opts: {
    evaluatedBy: 'auto' | 'manual' | 'mcp';
    /** Title of the summary note; the on-demand route's rate limit counts these. */
    noteTitle?: string;
    /** Dispatch verification tasks for `command` criteria (default true). */
    dispatchCommands?: boolean;
  },
): Promise<GoalCriteriaState | null> {
  const mission = await db.query.missions.findFirst({
    where: eq(missions.id, missionId),
    columns: {
      id: true,
      title: true,
      description: true,
      goalCriteria: true,
      goalCriteriaState: true,
      workingBranch: true,
      status: true,
    },
  });
  if (!mission) return null;

  const criteria = Array.isArray(mission.goalCriteria) ? (mission.goalCriteria as GoalCriterion[]) : [];
  if (criteria.length === 0) return null;

  const priorState = (mission.goalCriteriaState ?? null) as GoalCriteriaState | null;
  const priorAgeMs = priorState?.evaluatedAt ? Date.now() - Date.parse(priorState.evaluatedAt) : Infinity;

  // ── Evidence assembly ──────────────────────────────────────────────────────
  const missionTasks = await db.query.tasks.findMany({
    where: eq(tasks.missionId, missionId),
    columns: {
      id: true, status: true, kind: true, title: true, mode: true,
      taskClass: true, creationSource: true, category: true, result: true,
    },
  });

  let missionWorkers: Array<{ taskId: string | null; mergedAt: Date | null; prUrl: string | null; branch: string }> = [];
  if (missionTasks.length > 0) {
    const taskIds = missionTasks.map(t => t.id);
    missionWorkers = await db.query.workers.findMany({
      where: inArray(workers.taskId, taskIds),
      columns: { taskId: true, mergedAt: true, prUrl: true, branch: true },
    });
  }

  const missionArtifacts = await db.query.artifacts.findMany({
    where: eq(artifacts.missionId, missionId),
    columns: { id: true, key: true, type: true, title: true, content: true },
  });

  // ── Mechanical evaluation (always re-run: it is one query, never a snapshot) ─
  const state = evaluateGoalCriteria(
    { id: mission.id, workingBranch: mission.workingBranch },
    criteria,
    {
      tasks: missionTasks,
      workers: missionWorkers.map(w => ({
        taskId: w.taskId,
        mergedAt: w.mergedAt,
        prUrl: w.prUrl,
        branchName: w.branch,
      })),
      artifacts: missionArtifacts.map(a => ({ key: a.key, type: a.type })),
      evaluatedBy: opts.evaluatedBy,
    }
  );

  // ── Command criteria: run the command, don't ask a model ────────────────────
  //
  // Skipped entirely when a mechanical criterion has already failed: the fold is
  // `fail` whatever the command returns, so dispatching a worker task per
  // evaluation round would burn real agent runs to learn nothing. The command is
  // re-run once the failing criterion clears.
  const alreadyFailing = state.criteria.some(c => c.verdict === 'fail');
  if (opts.dispatchCommands !== false && !alreadyFailing) {
    for (const cs of state.criteria) {
      if (cs.type !== 'command') continue;
      const criterion = criteria[cs.index];
      if (!criterion || criterion.type !== 'command') continue;

      const resolution = await resolveCommandCriterion({
        missionId,
        criterionIndex: cs.index,
        command: criterion.command,
        label: criterion.label,
      });

      if (resolution.kind === 'verdict') {
        cs.verdict = resolution.verdict;
        cs.evidence = resolution.evidence;
        cs.workerTaskId = resolution.taskId;
      } else if (resolution.kind === 'pending') {
        cs.verdict = 'PENDING';
        cs.evidence = resolution.evidence;
        cs.workerTaskId = resolution.taskId;
      } else {
        cs.verdict = 'NOT_EVALUATED';
        cs.evidence = resolution.evidence;
      }
    }
  }

  if (alreadyFailing) {
    for (const cs of state.criteria) {
      if (cs.type === 'command' && cs.verdict === 'NOT_EVALUATED') {
        cs.evidence = 'Not run: another criterion has already failed, so the mission cannot pass this round';
      }
    }
  }

  // ── LLM grading for prose criteria only ────────────────────────────────────
  const llmEligible = state.criteria.filter(
    c => (c.verdict === 'UNVERIFIED' || c.verdict === 'NOT_EVALUATED') && isLlmEligible(c.type)
  );

  if (llmEligible.length > 0) {
    // Carry forward a recent LLM verdict rather than paying for it again — but
    // ONLY onto the same criterion. Matching on array index alone would transplant
    // a verdict: delete criterion 0 and yesterday's `pass` becomes the cached
    // answer for whatever moved into slot 0, which is a false completion produced
    // by the cache. Identity is the fingerprint.
    const carried = new Set<number>();
    if (priorAgeMs < LLM_REVERIFY_MS) {
      for (const c of llmEligible) {
        const prior = priorState?.criteria.find(p => p.index === c.index);
        if (!prior || prior.verdict === 'NOT_EVALUATED' || prior.verdict === 'PENDING') continue;
        if (!prior.fingerprint || !c.fingerprint || prior.fingerprint !== c.fingerprint) continue;
        c.verdict = prior.verdict;
        c.evidence = prior.evidence;
        if (prior.evidenceRefs) c.evidenceRefs = prior.evidenceRefs;
        carried.add(c.index);
      }
    }

    const toJudge = llmEligible.filter(c => !carried.has(c.index));
    const anthropicApiKey = process.env.ANTHROPIC_API_KEY;

    if (toJudge.length > 0 && anthropicApiKey) {
      const completedTasks: EvidenceTask[] = missionTasks
        .filter(t => t.status === 'completed')
        .map(t => ({
          id: t.id,
          title: t.title,
          summary: (t.result as any)?.summary as string | undefined,
        }));

      const evidenceArtifacts: EvidenceArtifact[] = missionArtifacts.map(a => ({
        id: a.id,
        title: a.title,
        type: a.type,
        contentSnippet: a.content ? a.content.substring(0, ARTIFACT_CONTENT_LIMIT) : null,
      }));

      const llmVerdicts = await judgeWithLLM(
        toJudge.map(c => ({ index: c.index, text: criterionText(criteria[c.index]) })),
        mission.title,
        mission.description ?? null,
        completedTasks,
        evidenceArtifacts,
        anthropicApiKey,
      );

      for (const lv of llmVerdicts) {
        const criterionState = state.criteria.find(c => c.index === lv.index);
        if (!criterionState) continue;
        criterionState.verdict = lv.verdict;
        if (lv.evidence) criterionState.evidence = lv.evidence;
        if (lv.evidenceRef) criterionState.evidenceRefs = [lv.evidenceRef];
      }

      for (const c of toJudge) {
        const cs = state.criteria.find(s => s.index === c.index);
        if (cs && cs.verdict === 'NOT_EVALUATED') {
          cs.evidence = 'LLM returned no verdict for this criterion';
        }
      }
    } else if (toJudge.length > 0) {
      // No API key. Say so plainly and leave the criterion unevaluated — an
      // unreachable evaluator is never a pass. Prefer a `command` criterion:
      // its verdict does not depend on a model being reachable.
      for (const c of toJudge) {
        const cs = state.criteria.find(s => s.index === c.index);
        if (cs) {
          cs.verdict = 'NOT_EVALUATED';
          cs.evidence = 'LLM evaluator not configured (no ANTHROPIC_API_KEY) — prose criteria cannot be graded';
        }
      }
    }
  }

  state.overall = recalculateOverall(state.criteria);

  await db
    .update(missions)
    .set({ goalCriteriaState: state as any, updatedAt: new Date() })
    .where(eq(missions.id, missionId));

  // Post a note when the verdict changed, or on every explicit (human/MCP) run.
  // Automatic re-evaluation is frequent; an unchanged verdict is not news.
  const changed = priorState?.overall !== state.overall;
  if (changed || opts.evaluatedBy !== 'auto') {
    const failedCriteria = state.criteria.filter(c => c.verdict !== 'pass');
    const noteBody = failedCriteria.length > 0
      ? failedCriteria.map(c => `• [${c.verdict}] ${c.label ?? c.type}${c.evidence ? ': ' + c.evidence : ''}`).join('\n')
      : 'All criteria passed.';

    await db.insert(missionNotes).values({
      missionId,
      authorType: 'system',
      type: state.overall === 'pass' ? 'update' : 'warning',
      title: opts.noteTitle ?? ON_COMPLETION_NOTE_TITLE,
      body: `Overall: ${state.overall}\n\n${noteBody}`,
      status: 'open',
    } as any).catch(e => console.error('[criteria-eval] Failed to post note:', e));
  }

  return state;
}

/**
 * Return a verdict for a mission's criteria, producing one if none is current.
 *
 * Called by `canCompleteMission` at the moment a verdict is owed — all
 * deliverables terminal, criteria stated. This is the pull that replaced the old
 * push: nothing has to remember to evaluate, and nothing can complete a mission
 * by virtue of the evaluator having stayed silent.
 *
 * Returns the stored state (possibly null) without evaluating when:
 * - another evaluation landed within AUTO_EVAL_DEBOUNCE_MS (concurrent task
 *   completions all reach here at once), or
 * - `autoVerify` is false, which is the mission owner asking for on-demand
 *   verification only. The mission then stays awaiting verification until
 *   someone runs it — which is the honest outcome of that setting, not a pass.
 */
export async function ensureCriteriaVerdict(
  missionId: string,
  opts: { trigger?: string; force?: boolean } = {},
): Promise<GoalCriteriaState | null> {
  const mission = await db.query.missions.findFirst({
    where: eq(missions.id, missionId),
    columns: { id: true, goalCriteria: true, goalCriteriaState: true, autoVerify: true },
  });
  if (!mission) return null;

  const criteria = Array.isArray(mission.goalCriteria) ? (mission.goalCriteria as GoalCriterion[]) : [];
  if (criteria.length === 0) return null;

  const stored = (mission.goalCriteriaState ?? null) as GoalCriteriaState | null;

  if (!opts.force) {
    if (stored?.evaluatedAt && Date.now() - Date.parse(stored.evaluatedAt) < AUTO_EVAL_DEBOUNCE_MS) {
      return stored;
    }
    if (mission.autoVerify === false) {
      console.log(`[criteria-eval] mission ${missionId}: autoVerify=false — verdict must be requested on demand`);
      return stored;
    }
  }

  console.log(`[criteria-eval] mission ${missionId}: evaluating ${criteria.length} criteria (trigger: ${opts.trigger ?? 'unknown'})`);
  return evaluateCriteriaNow(missionId, { evaluatedBy: 'auto', noteTitle: ON_COMPLETION_NOTE_TITLE });
}
