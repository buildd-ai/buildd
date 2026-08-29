import { db } from '@buildd/core/db';
import { missions, tasks, workers, artifacts, missionNotes } from '@buildd/core/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { evaluateGoalCriteria } from '@buildd/core/mission-helpers';
import type { GoalCriterion, GoalCriteriaState, CriterionVerdict, GoalCriteriaEvidenceRef } from '@buildd/shared';
import { resolveTierEntrySync } from '@buildd/core/model-tier-registry';
import { countPendingTasksForMission } from './mission-release';

const LLM_MAX_TOKENS = 2048;
const ARTIFACT_CONTENT_LIMIT = 3000;

type EvidenceTask = { id: string; title: string | null; summary: string | undefined };
type EvidenceArtifact = { id: string; title: string | null; type: string; contentSnippet: string | null };

interface LLMCriterionInput { index: number; text: string }
interface LLMCriterionVerdict {
  index: number;
  verdict: CriterionVerdict;
  evidence: string;
  evidenceRef?: GoalCriteriaEvidenceRef;
}

function isLlmEligible(type: string): boolean {
  return !['artifact_exists', 'no_open_tasks', 'all_prs_merged', 'metric'].includes(type);
}

function criterionText(criterion: GoalCriterion): string {
  if (criterion.type === 'description') return criterion.description;
  if (criterion.type === 'command') return criterion.label ?? criterion.command;
  return criterion.label ?? criterion.type;
}

export function recalculateOverall(criteria: GoalCriteriaState['criteria']): CriterionVerdict {
  if (criteria.length === 0) return 'pass';
  if (criteria.some(r => r.verdict === 'fail')) return 'fail';
  // NOT_EVALUATED means "we could not check this" — that is not a pass
  if (criteria.some(r => r.verdict === 'NOT_EVALUATED')) return 'UNVERIFIED';
  if (criteria.every(r => r.verdict === 'pass')) return 'pass';
  return 'UNVERIFIED';
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
 * Auto-evaluate a mission's goalCriteria when all tasks have reached terminal state.
 *
 * Call this from post-completion hooks after a task finishes. It is idempotent —
 * it skips if there are still pending tasks, no criteria are set, autoVerify=false,
 * or an evaluation already exists.
 *
 * Uses evaluatedBy='auto' and a distinct note title so it is not counted against
 * the on-demand rate limit (which guards manual/MCP calls only).
 */
export async function autoEvaluateMissionOnCompletion(missionId: string): Promise<void> {
  const pending = await countPendingTasksForMission(missionId);
  if (pending > 0) return;

  const mission = await db.query.missions.findFirst({
    where: eq(missions.id, missionId),
    columns: {
      id: true,
      title: true,
      description: true,
      goalCriteria: true,
      goalCriteriaState: true,
      autoVerify: true,
      workingBranch: true,
      status: true,
    },
  });

  if (!mission) return;

  const criteria = Array.isArray(mission.goalCriteria) ? (mission.goalCriteria as GoalCriterion[]) : [];
  if (criteria.length === 0) return;

  if (mission.autoVerify === false) return;

  // Skip if state already exists — prevents double-evaluation on concurrent task completions
  if (mission.goalCriteriaState) return;

  // Evidence assembly
  const missionTasks = await db.query.tasks.findMany({
    where: eq(tasks.missionId, missionId),
    columns: { id: true, status: true, kind: true, title: true, mode: true, creationSource: true, category: true, result: true },
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

  // Mechanical evaluation
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
      evaluatedBy: 'auto',
    }
  );

  // LLM evidence-based evaluation for UNVERIFIED criteria
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  // Include NOT_EVALUATED (description) and UNVERIFIED (command/unknown) criteria for LLM
  const llmEligible = state.criteria.filter(
    c => (c.verdict === 'UNVERIFIED' || c.verdict === 'NOT_EVALUATED') && isLlmEligible(c.type)
  );

  if (llmEligible.length > 0) {
    if (anthropicApiKey) {
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

      const llmInputs: LLMCriterionInput[] = llmEligible.map(c => ({
        index: c.index,
        text: criterionText(criteria[c.index]),
      }));

      const llmVerdicts = await judgeWithLLM(
        llmInputs,
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
        if (lv.evidenceRef) (criterionState as any).evidenceRefs = [lv.evidenceRef];
      }

      // Any eligible criteria that the LLM didn't return a verdict for stay NOT_EVALUATED
      for (const c of llmEligible) {
        const cs = state.criteria.find(s => s.index === c.index);
        if (cs && cs.verdict === 'NOT_EVALUATED') {
          cs.evidence = 'LLM returned no verdict for this criterion';
        }
      }
    } else {
      // No API key — mark all LLM-eligible criteria as NOT_EVALUATED
      for (const c of llmEligible) {
        const cs = state.criteria.find(s => s.index === c.index);
        if (cs) {
          cs.verdict = 'NOT_EVALUATED';
          cs.evidence = 'LLM evaluator not configured';
        }
      }
    }

    (state as any).overall = recalculateOverall(state.criteria);
  }

  // Persist state
  const updates: Record<string, unknown> = { goalCriteriaState: state, updatedAt: new Date() };
  if (state.overall === 'pass' && mission.status === 'active') {
    updates.status = 'completed';
  }

  await db.update(missions).set(updates as any).where(eq(missions.id, missionId));

  // Post note for feed visibility (distinct title from on-demand so it doesn't count against rate limit)
  const failedCriteria = state.criteria.filter(c => c.verdict !== 'pass');
  const noteBody = failedCriteria.length > 0
    ? failedCriteria.map(c => `• [${c.verdict}] ${c.label ?? c.type}${c.evidence ? ': ' + c.evidence : ''}`).join('\n')
    : 'All criteria passed.';

  await db.insert(missionNotes).values({
    missionId,
    authorType: 'system',
    type: state.overall === 'pass' ? 'update' : 'warning',
    title: 'Goal criteria evaluated (on-completion)',
    body: `Overall: ${state.overall}\n\n${noteBody}`,
    status: 'open',
  } as any).catch(e => console.error('[criteria-eval] Failed to post note:', e));
}
