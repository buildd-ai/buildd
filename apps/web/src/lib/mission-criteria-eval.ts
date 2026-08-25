import { db } from '@buildd/core/db';
import { missions, tasks, workers, artifacts, missionNotes, secrets, workspaces } from '@buildd/core/db/schema';
import { eq, inArray, or, isNull, and } from 'drizzle-orm';
import { evaluateGoalCriteria } from '@buildd/core/mission-helpers';
import type { GoalCriterion, GoalCriteriaState, CriterionVerdict, GoalCriteriaEvidenceRef } from '@buildd/shared';
import { resolveTierEntrySync } from '@buildd/core/model-tier-registry';
import { countPendingTasksForMission } from './mission-release';
import { dispatchNewTask } from './task-dispatch';

const LLM_MAX_TOKENS = 2048;
const ARTIFACT_CONTENT_LIMIT = 3000;

type EvidenceTask = { id: string; title: string | null; summary: string | undefined };
type EvidenceArtifact = { id: string; title: string | null; type: string; contentSnippet: string | null };

export interface LLMCriterionInput { index: number; text: string }
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

function recalculateOverall(criteria: GoalCriteriaState['criteria']): CriterionVerdict {
  if (criteria.length === 0) return 'pass';
  if (criteria.some(r => r.verdict === 'fail')) return 'fail';
  // NOT_EVALUATED / PENDING means "we could not check this yet" — not a pass
  if (criteria.some(r => r.verdict === 'NOT_EVALUATED' || r.verdict === 'PENDING')) return 'UNVERIFIED';
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

// ── OAuth credential check ─────────────────────────────────────────────────────

/**
 * Returns true when the team has a stored Claude OAuth credential (claude_credential
 * or oauth_token purpose) that workers can use to call the Anthropic API through
 * the existing broker. Checks team-wide rows first, then workspace-scoped rows.
 */
export async function hasTeamOAuthCredential(teamId: string): Promise<boolean> {
  const row = await db.query.secrets.findFirst({
    where: and(
      eq(secrets.teamId, teamId),
      or(
        eq(secrets.purpose, 'claude_credential'),
        eq(secrets.purpose, 'oauth_token'),
      ),
    ),
    columns: { id: true },
  });
  return !!row;
}

// ── Context hash for result caching ───────────────────────────────────────────

/**
 * Build a stable string fingerprint of the evaluation inputs. When this hash
 * matches the one stored in goalCriteriaState.contextHash, the inputs have not
 * changed and re-dispatching would produce the same result — skip it.
 */
export function buildContextHash(
  criteria: GoalCriterion[],
  completedTasks: EvidenceTask[],
  evidenceArtifacts: EvidenceArtifact[],
): string {
  const parts = [
    criteria.map(c => criterionText(c)).sort().join('|'),
    completedTasks.map(t => `${t.id}:${t.summary ?? ''}`).sort().join('|'),
    evidenceArtifacts.map(a => `${a.id}:${a.contentSnippet ?? ''}`).sort().join('|'),
  ];
  // Simple deterministic hash — not cryptographic, just stable enough to detect
  // re-evaluation with identical inputs.
  let h = 0;
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) {
      h = (Math.imul(31, h) + part.charCodeAt(i)) | 0;
    }
    h = (Math.imul(31, h) + 124) | 0; // separator
  }
  return (h >>> 0).toString(16);
}

// ── Evaluator task dispatch ───────────────────────────────────────────────────

function buildEvaluatorPrompt(
  mission: { title: string; description: string | null },
  llmInputs: LLMCriterionInput[],
  completedTasks: EvidenceTask[],
  evidenceArtifacts: EvidenceArtifact[],
): string {
  const taskEvidence = completedTasks.map(t =>
    `[task:${t.id.slice(0, 8)}] "${t.title ?? '(untitled)'}"${t.summary ? `\nSummary: ${t.summary}` : ' (no summary)'}`,
  ).join('\n\n');

  const artifactEvidence = evidenceArtifacts.map(a =>
    `[artifact:${a.id.slice(0, 8)}] "${a.title ?? '(untitled)'}" (${a.type})${a.contentSnippet ? `\nContent:\n${a.contentSnippet}` : ''}`,
  ).join('\n\n');

  const hasEvidence = completedTasks.length > 0 || evidenceArtifacts.length > 0;
  const criteriaList = llmInputs.map((c, i) => `${i + 1}. index=${c.index}: ${c.text}`).join('\n');

  return `You are a mission criteria evaluator. Your ONLY job is to evaluate the criteria below and complete this task with structured verdicts.

## Mission: ${mission.title}
${mission.description ? `Description: ${mission.description}\n` : ''}

## Criteria to evaluate (${llmInputs.length}):
${criteriaList}

## Evidence

### Completed tasks (${completedTasks.length}):
${taskEvidence || '(none)'}

### Artifacts (${evidenceArtifacts.length}):
${artifactEvidence || '(none)'}

${!hasEvidence ? '⚠️  No evidence available. Return UNVERIFIED for all criteria.\n' : ''}
## Instructions
Evaluate each criterion against the evidence above:
- "pass": evidence directly supports the criterion being satisfied
- "UNVERIFIED": evidence is ambiguous, absent, or insufficient
- "fail": evidence clearly contradicts the criterion

Cite specific evidence using the [task:XXXXXXXX] or [artifact:XXXXXXXX] refs above.

When done, call complete_task immediately with:
{
  "criteriaVerdicts": [
    {
      "index": <criterion index from the list above>,
      "verdict": "pass" | "fail" | "UNVERIFIED",
      "evidence": "<one sentence citing specific evidence>"
    }
  ]
}

Do NOT create any tasks, open any PRs, or take any other actions. Evaluate and complete.`;
}

/**
 * Dispatch a system-class criteria evaluator task for a mission's prose criteria.
 *
 * Returns the new task ID on success, null if the workspace could not be found.
 * The task is created with taskClass='system' so it is excluded from all mission
 * progress counts and the no_open_tasks criterion.
 */
export async function dispatchProseEvaluator(
  mission: {
    id: string;
    title: string;
    description: string | null;
    workspaceId: string | null;
  },
  llmInputs: LLMCriterionInput[],
  completedTasks: EvidenceTask[],
  evidenceArtifacts: EvidenceArtifact[],
  criteriaIndices: number[],
): Promise<string | null> {
  if (!mission.workspaceId) return null;

  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, mission.workspaceId),
  });
  if (!workspace) return null;

  const description = buildEvaluatorPrompt(mission, llmInputs, completedTasks, evidenceArtifacts);

  const [newTask] = await db.insert(tasks).values({
    workspaceId: mission.workspaceId,
    missionId: mission.id,
    title: `[criteria-eval] ${mission.title}`,
    description,
    status: 'pending' as const,
    taskClass: 'system' as const,
    tier: 'budget',
    maxTurns: 3,
    priority: 5,
    creationSource: 'api',
    context: {
      evaluatorForMissionId: mission.id,
      criteriaIndices,
    },
  } as any).returning({ id: tasks.id });

  if (!newTask) return null;

  await dispatchNewTask(
    {
      id: newTask.id,
      title: `[criteria-eval] ${mission.title}`,
      description,
      workspaceId: mission.workspaceId,
      missionId: mission.id,
    },
    workspace,
  );

  return newTask.id;
}

// ── Outcome handler (called from worker completion runStep) ────────────────────

/**
 * Called when a system-class [criteria-eval] task completes. Reads the
 * criteriaVerdicts from the worker's structuredOutput and writes the final
 * goalCriteriaState back to the mission.
 *
 * Guards: the state must be in PENDING overall (or have PENDING criteria) —
 * if something else already wrote a final verdict, we skip.
 */
export async function handleCriteriaEvalOutcome(
  missionId: string,
  structuredOutput: unknown,
): Promise<void> {
  const verdicts = parseCriteriaVerdicts(structuredOutput);
  if (!verdicts.length) {
    console.warn(`[criteria-eval] Task for mission ${missionId} completed without valid criteriaVerdicts`);
    return;
  }

  const mission = await db.query.missions.findFirst({
    where: eq(missions.id, missionId),
    columns: {
      id: true,
      title: true,
      goalCriteria: true,
      goalCriteriaState: true,
      status: true,
    },
  });

  if (!mission || !mission.goalCriteriaState) {
    console.warn(`[criteria-eval] Mission ${missionId} not found or has no pending state`);
    return;
  }

  const state = mission.goalCriteriaState as GoalCriteriaState;

  // Only proceed if the state has PENDING criteria — prevents overwriting a final verdict
  const hasPending = state.criteria.some(c => c.verdict === 'PENDING');
  if (!hasPending) {
    console.log(`[criteria-eval] Mission ${missionId} already has final state — skipping evaluator outcome`);
    return;
  }

  // Apply the verdicts from the worker
  for (const v of verdicts) {
    const cs = state.criteria.find(c => c.index === v.index);
    if (!cs) continue;
    if (cs.verdict !== 'PENDING') continue; // only upgrade PENDING slots
    cs.verdict = v.verdict;
    if (v.evidence) cs.evidence = v.evidence;
  }

  // Any criteria still PENDING (worker didn't return a verdict for them) → UNVERIFIED
  for (const cs of state.criteria) {
    if (cs.verdict === 'PENDING') {
      cs.verdict = 'UNVERIFIED';
      cs.evidence = 'Evaluator did not return a verdict for this criterion';
    }
  }

  (state as any).overall = recalculateOverall(state.criteria);
  state.evaluatedAt = new Date().toISOString();

  const updates: Record<string, unknown> = { goalCriteriaState: state, updatedAt: new Date() };
  if (state.overall === 'pass' && mission.status === 'active') {
    updates.status = 'completed';
  }

  await db.update(missions).set(updates as any).where(eq(missions.id, missionId));

  const failedCriteria = state.criteria.filter(c => c.verdict !== 'pass');
  const noteBody = failedCriteria.length > 0
    ? failedCriteria.map(c => `• [${c.verdict}] ${c.label ?? c.type}${c.evidence ? ': ' + c.evidence : ''}`).join('\n')
    : 'All criteria passed.';

  await db.insert(missionNotes).values({
    missionId,
    authorType: 'system',
    type: state.overall === 'pass' ? 'update' : 'warning',
    title: 'Goal criteria evaluated (dispatch)',
    body: `Overall: ${state.overall}\n\n${noteBody}`,
    status: 'open',
  } as any).catch(e => console.error('[criteria-eval] Failed to post note:', e));
}

interface ParsedVerdict {
  index: number;
  verdict: CriterionVerdict;
  evidence: string;
}

function parseCriteriaVerdicts(structuredOutput: unknown): ParsedVerdict[] {
  if (!structuredOutput || typeof structuredOutput !== 'object') return [];
  const out = structuredOutput as Record<string, unknown>;
  if (!Array.isArray(out.criteriaVerdicts)) return [];
  return (out.criteriaVerdicts as any[]).flatMap(v => {
    if (typeof v.index !== 'number') return [];
    const verdict = (['pass', 'fail', 'UNVERIFIED'].includes(v.verdict) ? v.verdict : 'UNVERIFIED') as CriterionVerdict;
    return [{ index: v.index as number, verdict, evidence: typeof v.evidence === 'string' ? v.evidence : '' }];
  });
}

// ── autoEvaluateMissionOnCompletion ───────────────────────────────────────────

/**
 * Auto-evaluate a mission's goalCriteria when all tasks have reached terminal state.
 *
 * Call this from post-completion hooks after a task finishes. It is idempotent —
 * it skips if there are still pending tasks, no criteria are set, autoVerify=false,
 * or an evaluation already exists with final (non-PENDING) verdicts.
 *
 * For prose (description) criteria:
 * - When ANTHROPIC_API_KEY is set, evaluates inline via direct API call.
 * - When OAuth credentials are available for the team (no API key), dispatches
 *   a system-class evaluator task and sets PENDING verdicts — the evaluator task
 *   writes the final verdict on completion via handleCriteriaEvalOutcome.
 * - Falls back to NOT_EVALUATED when neither credential path is available.
 *
 * Uses evaluatedBy='auto' and a distinct note title so it does not count against
 * the on-demand rate limit (which guards manual/MCP calls only).
 */
export async function autoEvaluateMissionOnCompletion(missionId: string): Promise<void> {
  const pending = await countPendingTasksForMission(missionId);
  if (pending > 0) return;

  const mission = await db.query.missions.findFirst({
    where: eq(missions.id, missionId),
    columns: {
      id: true,
      teamId: true,
      workspaceId: true,
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

  // Skip if a final (non-PENDING) evaluation already exists
  if (mission.goalCriteriaState) {
    const existing = mission.goalCriteriaState as GoalCriteriaState;
    const hasPending = existing.criteria.some(c => c.verdict === 'PENDING');
    if (!hasPending) return;
    // If we have PENDING criteria from a prior dispatch, don't re-dispatch
    return;
  }

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

  // LLM-eligible criteria (description type, etc.)
  const llmEligible = state.criteria.filter(
    c => (c.verdict === 'UNVERIFIED' || c.verdict === 'NOT_EVALUATED') && isLlmEligible(c.type)
  );

  if (llmEligible.length > 0) {
    const anthropicApiKey = process.env.ANTHROPIC_API_KEY;

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

    if (anthropicApiKey) {
      // Inline evaluation via direct Anthropic API call
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

      for (const c of llmEligible) {
        const cs = state.criteria.find(s => s.index === c.index);
        if (cs && cs.verdict === 'NOT_EVALUATED') {
          cs.evidence = 'LLM returned no verdict for this criterion';
        }
      }
    } else if (await hasTeamOAuthCredential(mission.teamId)) {
      // OAuth-based dispatch: create a system evaluator task and set PENDING state.
      // The evaluator task writes the final verdict via handleCriteriaEvalOutcome.
      const contextHash = buildContextHash(criteria, completedTasks, evidenceArtifacts);

      const llmInputs: LLMCriterionInput[] = llmEligible.map(c => ({
        index: c.index,
        text: criterionText(criteria[c.index]),
      }));

      const evaluatorTaskId = await dispatchProseEvaluator(
        {
          id: mission.id,
          title: mission.title,
          description: mission.description ?? null,
          workspaceId: mission.workspaceId,
        },
        llmInputs,
        completedTasks,
        evidenceArtifacts,
        llmEligible.map(c => c.index),
      );

      if (evaluatorTaskId) {
        // Mark description criteria as PENDING; mechanical criteria keep their verdicts
        for (const c of llmEligible) {
          const cs = state.criteria.find(s => s.index === c.index);
          if (cs) {
            cs.verdict = 'PENDING';
            cs.evidence = 'Evaluation dispatched — evaluator task running';
            (cs as any).evaluatorTaskId = evaluatorTaskId;
          }
        }
        (state as any).contextHash = contextHash;
      } else {
        // Dispatch failed (no workspace?) — fall through to NOT_EVALUATED
        for (const c of llmEligible) {
          const cs = state.criteria.find(s => s.index === c.index);
          if (cs) {
            cs.verdict = 'NOT_EVALUATED';
            cs.evidence = 'Evaluator dispatch failed — no workspace configured';
          }
        }
      }
    } else {
      // No API key and no OAuth — mark as NOT_EVALUATED (inconclusive, not failure)
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

  // Only post a note when we have a final verdict (not pending dispatch)
  const hasPendingDispatch = state.criteria.some(c => c.verdict === 'PENDING');
  if (!hasPendingDispatch) {
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
  } else {
    await db.insert(missionNotes).values({
      missionId,
      authorType: 'system',
      type: 'update',
      title: 'Goal criteria evaluation dispatched',
      body: `Prose criteria are being evaluated asynchronously by a system task. Overall will update when complete.`,
      status: 'open',
    } as any).catch(e => console.error('[criteria-eval] Failed to post dispatch note:', e));
  }
}
