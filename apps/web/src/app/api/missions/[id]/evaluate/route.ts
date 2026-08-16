import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { missions, tasks, workers, artifacts, missionNotes, workspaces } from '@buildd/core/db/schema';
import { eq, and, gte, count, inArray } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { resolveAccountTeamIds } from '@/lib/team-access';
import { evaluateGoalCriteria } from '@buildd/core/mission-helpers';
import type { GoalCriterion, GoalCriteriaState, GoalCriteriaEvidenceRef, CriterionVerdict } from '@buildd/shared';

const RATE_LIMIT_PER_HOUR = 6;
const LLM_MODEL = 'claude-haiku-4-5-20251001';
const LLM_MAX_TOKENS = 2048;
// Truncate artifact content to keep prompt manageable
const ARTIFACT_CONTENT_LIMIT = 3000;

async function hasMissionAccess(mission: { teamId: string; workspaceId: string | null }, teamIds: string[]): Promise<boolean> {
  if (teamIds.includes(mission.teamId)) return true;
  if (mission.workspaceId) {
    const ws = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, mission.workspaceId),
      columns: { accessMode: true },
    });
    if (ws?.accessMode === 'open') return true;
  }
  return false;
}

type EvidenceTask = { id: string; title: string | null; summary: string | undefined };
type EvidenceArtifact = { id: string; title: string | null; type: string; contentSnippet: string | null };

interface LLMCriterionInput {
  index: number;
  text: string;
}

interface LLMCriterionVerdict {
  index: number;
  verdict: CriterionVerdict;
  evidence: string;
  evidenceRef?: GoalCriteriaEvidenceRef;
}

/**
 * Determine the human-readable text for a criterion to pass to the LLM.
 */
function criterionText(criterion: GoalCriterion): string {
  if (criterion.type === 'description') return criterion.description;
  if (criterion.type === 'command') return criterion.label ?? criterion.command;
  return criterion.label ?? criterion.type;
}

/**
 * Returns true for criterion types that should be upgraded via LLM when UNVERIFIED.
 * Structural types (artifact_exists, no_open_tasks, all_prs_merged) are mechanical — LLM
 * can't override them. `metric` needs a data query. Unknown types (from future/older clients)
 * are LLM-eligible so evidence is surfaced rather than silently ignored.
 */
function isLlmEligible(type: string): boolean {
  return !['artifact_exists', 'no_open_tasks', 'all_prs_merged', 'metric'].includes(type);
}

/**
 * Call Claude to judge each LLM-eligible UNVERIFIED criterion against mission evidence.
 * Returns a verdict per criterion index. Falls back gracefully on API errors.
 */
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

  const criteriaList = inputs.map((c, i) =>
    `${i + 1}. index=${c.index}: ${c.text}`,
  ).join('\n');

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
        model: LLM_MODEL,
        max_tokens: LLM_MAX_TOKENS,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });
  } catch (err) {
    console.error('[evaluate/llm] fetch error:', err);
    return [];
  }

  if (!resp.ok) {
    const bodyText = await resp.text().catch(() => '');
    console.error(`[evaluate/llm] API error ${resp.status}: ${bodyText.substring(0, 200)}`);
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
    console.error('[evaluate/llm] parse error:', parseErr, '| raw:', text.substring(0, 200));
    return [];
  }
}

function recalculateOverall(criteria: GoalCriteriaState['criteria']): CriterionVerdict {
  const evaluated = criteria.filter(r => r.verdict !== 'NOT_EVALUATED');
  if (evaluated.length === 0) return 'UNVERIFIED';
  if (evaluated.some(r => r.verdict === 'fail')) return 'fail';
  if (evaluated.every(r => r.verdict === 'pass')) return 'pass';
  return 'UNVERIFIED';
}

/**
 * POST /api/missions/[id]/evaluate
 *
 * On-demand evaluation of a mission's goalCriteria.
 * Returns GoalCriteriaState with per-criterion verdicts.
 * Rate limited to 6 calls per mission per hour.
 *
 * Evidence assembly:
 * - Structural criteria (artifact_exists, no_open_tasks, all_prs_merged) are evaluated
 *   mechanically from DB state.
 * - Description/command/unknown criteria that remain UNVERIFIED after mechanical evaluation
 *   are upgraded via an LLM call that reads artifact titles+content and task summaries.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey);

  if (!user && !apiAccount) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (apiAccount && apiAccount.level !== 'admin') {
    return NextResponse.json({ error: 'Requires admin-level API key' }, { status: 403 });
  }

  try {
    const teamIds = await resolveAccountTeamIds(user, apiAccount);

    const mission = await db.query.missions.findFirst({
      where: eq(missions.id, id),
      columns: {
        id: true,
        teamId: true,
        workspaceId: true,
        title: true,
        description: true,
        goalCriteria: true,
        workingBranch: true,
        status: true,
      },
    });

    if (!mission || !(await hasMissionAccess(mission, teamIds))) {
      return NextResponse.json({ error: 'Mission not found' }, { status: 404 });
    }

    const criteria = (mission.goalCriteria as any[]) ?? [];
    if (criteria.length === 0) {
      return NextResponse.json({
        message: 'No goalCriteria set — nothing to evaluate',
        goalCriteriaState: null,
      });
    }

    // Rate limit: max RATE_LIMIT_PER_HOUR on-demand evaluations per mission per hour
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const [{ value: recentCount }] = await db
      .select({ value: count() })
      .from(missionNotes)
      .where(
        and(
          eq(missionNotes.missionId, id),
          eq(missionNotes.title, 'Goal criteria evaluated (on-demand)'),
          gte(missionNotes.createdAt, oneHourAgo),
        )
      );

    if (Number(recentCount) >= RATE_LIMIT_PER_HOUR) {
      return NextResponse.json(
        { error: `Rate limit: max ${RATE_LIMIT_PER_HOUR} on-demand evaluations per mission per hour` },
        { status: 429 }
      );
    }

    // ── Evidence assembly ──────────────────────────────────────────────────────

    // Tasks: include result (summary) for LLM evaluation
    const missionTasks = await db.query.tasks.findMany({
      where: eq(tasks.missionId, id),
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

    // Artifacts: load titles and content for LLM evaluation
    const missionArtifacts = await db.query.artifacts.findMany({
      where: eq(artifacts.missionId, id),
      columns: { id: true, key: true, type: true, title: true, content: true },
    });

    const evaluatedBy: 'auto' | 'manual' | 'mcp' = apiAccount ? 'mcp' : 'manual';

    // ── Mechanical evaluation ──────────────────────────────────────────────────

    const state = evaluateGoalCriteria(
      { id: mission.id, workingBranch: mission.workingBranch },
      criteria as any,
      {
        tasks: missionTasks,
        workers: missionWorkers.map(w => ({
          taskId: w.taskId,
          mergedAt: w.mergedAt,
          prUrl: w.prUrl,
          branchName: w.branch,
          // branchDeleted: not checked without GitHub API call — left undefined
        })),
        artifacts: missionArtifacts.map(a => ({ key: a.key, type: a.type })),
        evaluatedBy,
      }
    );

    // ── LLM evidence-based evaluation for UNVERIFIED criteria ─────────────────

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
          text: criterionText(criteria[c.index] as GoalCriterion),
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

      // Recalculate overall after LLM upgrades (NOT_EVALUATED excluded from calculation)
      (state as any).overall = recalculateOverall(state.criteria);
    }

    // ── Persist state ──────────────────────────────────────────────────────────

    const updates: Partial<typeof missions.$inferInsert> = {
      goalCriteriaState: state as any,
      updatedAt: new Date(),
    };

    if (state.overall === 'pass' && mission.status === 'active') {
      updates.status = 'completed';
    }

    await db.update(missions).set(updates).where(eq(missions.id, id));

    // Post a note summarising the result (also used for rate limiting)
    const failedCriteria = state.criteria.filter(c => c.verdict !== 'pass');
    const noteBody = failedCriteria.length > 0
      ? failedCriteria.map(c => `• [${c.verdict}] ${c.label ?? c.type}${c.evidence ? ': ' + c.evidence : ''}`).join('\n')
      : 'All criteria passed.';

    await db.insert(missionNotes).values({
      missionId: id,
      authorType: 'system',
      type: state.overall === 'pass' ? 'update' : 'warning',
      title: 'Goal criteria evaluated (on-demand)',
      body: `Overall: ${state.overall}\n\n${noteBody}`,
      status: 'open',
    }).catch(e => console.error('[evaluate] Failed to post note:', e));

    return NextResponse.json({ goalCriteriaState: state });
  } catch (error) {
    console.error('Evaluate mission criteria error:', error);
    return NextResponse.json({ error: 'Failed to evaluate goal criteria' }, { status: 500 });
  }
}

/**
 * GET /api/missions/[id]/evaluate
 *
 * Returns the last GoalCriteriaState without re-evaluating (get_criteria_state).
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey);

  if (!user && !apiAccount) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const teamIds = await resolveAccountTeamIds(user, apiAccount);

    const mission = await db.query.missions.findFirst({
      where: eq(missions.id, id),
      columns: { id: true, teamId: true, workspaceId: true, goalCriteria: true, goalCriteriaState: true },
    });

    if (!mission || !(await hasMissionAccess(mission, teamIds))) {
      return NextResponse.json({ error: 'Mission not found' }, { status: 404 });
    }

    return NextResponse.json({
      goalCriteria: mission.goalCriteria ?? null,
      goalCriteriaState: mission.goalCriteriaState ?? null,
    });
  } catch (error) {
    console.error('Get mission criteria state error:', error);
    return NextResponse.json({ error: 'Failed to get criteria state' }, { status: 500 });
  }
}
