import { db } from '@buildd/core/db';
import { missions, tasks, workers, artifacts, missionNotes } from '@buildd/core/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { evaluateGoalCriteria, recalculateOverall } from '@buildd/core/mission-helpers';
import type { GoalCriterion, GoalCriteriaState, CriterionVerdict, GoalCriteriaEvidenceRef } from '@buildd/shared';
import { inferenceCall, describeInferenceError, type InferenceError } from '@buildd/core/inference-client';
import { resolveCommandCriterion } from './mission-criteria-verify';
import { resolveProseCriteria } from './mission-criteria-prose';
import { resolveEvaluationStrategy } from './mission-criteria-strategy';
import { resolveCriteriaWorkerEval, type WorkerEvalCriterionInput } from './mission-criteria-worker-eval';

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

/**
 * Grade prose criteria in one batched inference call.
 *
 * Batched on purpose: the judge sees task summaries and artifact snippets with no
 * repo access, so a second call would see the same evidence and buy nothing but
 * N× cost and latency. The provider, model and credential all come from the
 * team's tier registry via `inferenceCall` — this function no longer knows what
 * an API key is, which is what lets a team route judgments through OpenRouter by
 * editing a tier row.
 */
async function judgeWithLLM(
  inputs: LLMCriterionInput[],
  missionTitle: string,
  missionDescription: string | null,
  completedTasks: EvidenceTask[],
  evidenceArtifacts: EvidenceArtifact[],
  scope: { teamId: string; workspaceId?: string | null },
): Promise<{ verdicts: LLMCriterionVerdict[]; error?: InferenceError }> {
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

  const result = await inferenceCall<LLMCriterionVerdict[]>({
    capability: 'criteria_grading',
    tier: 'budget',
    teamId: scope.teamId,
    workspaceId: scope.workspaceId,
    system: systemPrompt,
    user: userPrompt,
    maxTokens: LLM_MAX_TOKENS,
    timeoutMs: LLM_TIMEOUT_MS,
    validate: (parsed: unknown) => {
      const verdicts = (parsed as { verdicts?: unknown }).verdicts;
      if (!Array.isArray(verdicts)) return null;
      return verdicts.map((v: any) => ({
        index: v.index as number,
        // An unrecognised verdict string is not a pass.
        verdict: (['pass', 'fail', 'UNVERIFIED'].includes(v.verdict) ? v.verdict : 'UNVERIFIED') as CriterionVerdict,
        evidence: typeof v.evidence === 'string' ? v.evidence : '',
        ...(v.evidenceRef && typeof v.evidenceRef === 'object'
          ? { evidenceRef: v.evidenceRef as GoalCriteriaEvidenceRef }
          : {}),
      }));
    },
  });

  if (!result.ok) return { verdicts: [], error: result.error };
  return { verdicts: result.data };
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
    /**
     * Dispatch verification tasks for criteria that need one — `command` criteria
     * and, when no API key is present in this process, prose criteria (default true).
     * `false` makes this a read-only evaluation that spends no agent runs.
     */
    dispatchCommands?: boolean;
    /**
     * Allow dispatching a worker evaluator task (the batched 'worker' strategy).
     * Defaults to `false` to guard against dispatch from the routine heartbeat LLM
     * path — the worker strategy is intentionally TRIGGER-GATED to mission-complete
     * evaluation only. Pass `true` only from `ensureCriteriaVerdict` (which is called
     * from the completion gate) and the on-demand evaluate route.
     */
    allowWorkerDispatch?: boolean;
  },
): Promise<GoalCriteriaState | null> {
  const mission = await db.query.missions.findFirst({
    where: eq(missions.id, missionId),
    columns: {
      id: true,
      title: true,
      description: true,
      // teamId/workspaceId scope the inference call: they select the tier registry
      // row (provider + model) and the credential.
      teamId: true,
      workspaceId: true,
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

  // ── Resolve evaluation strategy ────────────────────────────────────────────
  // workspace-override → team-default → 'inline'
  const strategy = await resolveEvaluationStrategy(mission.teamId, mission.workspaceId);
  const canDispatch = opts.dispatchCommands !== false && opts.allowWorkerDispatch === true;
  const alreadyFailing = state.criteria.some(c => c.verdict === 'fail');

  // ── Worker strategy: one batched task evaluates all LLM-eligible + command criteria ─
  //
  // TRIGGER-GATED: allowWorkerDispatch is only set from ensureCriteriaVerdict (the
  // completion gate) and the on-demand route. The routine heartbeat prepass calls
  // evaluateCriteriaNow with allowWorkerDispatch=false (the default) so it never
  // dispatches a worker evaluator task mid-planning-cycle.
  //
  // Command criteria ALSO route here regardless of configured strategy, since they
  // are structurally unevaluable by an inline LLM call — the pure evaluator cannot
  // know whether a command exits 0.
  const commandCriteria = state.criteria.filter(
    cs => cs.type === 'command' && (cs.verdict === 'UNVERIFIED' || cs.verdict === 'NOT_EVALUATED')
  );
  const llmEligible = state.criteria.filter(
    c => (c.verdict === 'UNVERIFIED' || c.verdict === 'NOT_EVALUATED') && isLlmEligible(c.type)
  );

  // Criteria destined for the worker evaluator: all LLM-eligible (when strategy='worker')
  // and all command criteria (always). Under 'inline' strategy, command criteria are the
  // only ones that cannot be graded inline.
  const workerBound = strategy === 'worker'
    ? [...llmEligible, ...commandCriteria].filter((cs, i, arr) => arr.findIndex(x => x.index === cs.index) === i)
    : commandCriteria;

  if (workerBound.length > 0 && !alreadyFailing) {
    if (!canDispatch) {
      // Read-only evaluation pass — don't spend an agent run. Leave these
      // criteria at their current verdict rather than clearing them.
      for (const cs of workerBound) {
        if (cs.verdict === 'NOT_EVALUATED') {
          cs.evidence = 'Command criterion requires worker task dispatch — this run does not dispatch evaluation tasks';
        }
      }
    } else {
      const workerInputs: WorkerEvalCriterionInput[] = workerBound.map(cs => {
        const criterion = criteria[cs.index];
        return {
          index: cs.index,
          type: cs.type,
          text: criterionText(criterion ?? { type: cs.type as any, label: cs.label }),
          ...(criterion?.type === 'command' ? { command: criterion.command } : {}),
          fingerprint: cs.fingerprint,
        };
      });

      const resolution = await resolveCriteriaWorkerEval({ missionId, criteria: workerInputs });

      if (resolution.kind === 'pending') {
        for (const cs of workerBound) {
          cs.verdict = 'PENDING';
          cs.evidence = resolution.evidence;
          cs.workerTaskId = resolution.taskId;
        }
      } else {
        // Worker eval unavailable (no workspace, no runner, etc.) — mark
        // all workerBound criteria as NOT_EVALUATED with the resolver reason.
        for (const cs of workerBound) {
          cs.verdict = 'NOT_EVALUATED';
          cs.evidence = resolution.evidence;
        }
      }
    }
  }

  if (alreadyFailing) {
    for (const cs of state.criteria) {
      if ((cs.type === 'command' || (strategy === 'worker' && isLlmEligible(cs.type))) && cs.verdict === 'NOT_EVALUATED') {
        cs.evidence = 'Not run: another criterion has already failed, so the mission cannot pass this round';
      }
    }
  }

  // ── LLM grading for prose criteria (inline strategy only) ──────────────────
  //
  // When strategy='worker', prose criteria were already routed to the worker
  // evaluator above. This block only runs for strategy='inline'.
  const inlineLlmEligible = strategy === 'worker'
    ? []
    : state.criteria.filter(
        c => (c.verdict === 'UNVERIFIED' || c.verdict === 'NOT_EVALUATED') && isLlmEligible(c.type)
      );

  if (inlineLlmEligible.length > 0) {
    // Carry forward a recent LLM verdict rather than paying for it again — but
    // ONLY onto the same criterion. Matching on array index alone would transplant
    // a verdict: delete criterion 0 and yesterday's `pass` becomes the cached
    // answer for whatever moved into slot 0, which is a false completion produced
    // by the cache. Identity is the fingerprint.
    const carried = new Set<number>();
    if (priorAgeMs < LLM_REVERIFY_MS) {
      for (const c of inlineLlmEligible) {
        const prior = priorState?.criteria.find(p => p.index === c.index);
        if (!prior || prior.verdict === 'NOT_EVALUATED' || prior.verdict === 'PENDING') continue;
        if (!prior.fingerprint || !c.fingerprint || prior.fingerprint !== c.fingerprint) continue;
        c.verdict = prior.verdict;
        c.evidence = prior.evidence;
        if (prior.evidenceRefs) c.evidenceRefs = prior.evidenceRefs;
        carried.add(c.index);
      }
    }

    const toJudge = inlineLlmEligible.filter(c => !carried.has(c.index));

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

    // Two ways to grade prose, tried in this order.
    //
    // 1. An inference call, when the team has an inference key. Seconds, cents,
    //    and the provider/model come from their tier registry — so pointing the
    //    budget tier at OpenRouter routes judgments there with no change here.
    // 2. A dispatched agent run, when there is no key. Slower, but it uses the
    //    OAuth subscription the team already pays for, which is the only credential
    //    most teams have. An inference call structurally cannot use a subscription
    //    seat (see inference-client's docstring), so this is not a fallback for a
    //    flaky key — it is the path for teams that never had one.
    let inferenceError: InferenceError | undefined;

    if (toJudge.length > 0) {
      const judged = await judgeWithLLM(
        toJudge.map(c => ({ index: c.index, text: criterionText(criteria[c.index]) })),
        mission.title,
        mission.description ?? null,
        completedTasks,
        evidenceArtifacts,
        { teamId: mission.teamId, workspaceId: mission.workspaceId },
      );
      inferenceError = judged.error;

      for (const lv of judged.verdicts) {
        const criterionState = state.criteria.find(c => c.index === lv.index);
        if (!criterionState) continue;
        criterionState.verdict = lv.verdict;
        if (lv.evidence) criterionState.evidence = lv.evidence;
        if (lv.evidenceRef) criterionState.evidenceRefs = [lv.evidenceRef];
      }

      if (!inferenceError) {
        for (const c of toJudge) {
          const cs = state.criteria.find(s => s.index === c.index);
          if (cs && cs.verdict === 'NOT_EVALUATED') {
            cs.evidence = 'The evaluator returned no verdict for this criterion';
          }
        }
      }
    }

    // Three errors mean "this team has no inference path for grading", not "a call
    // failed": no key, a provider that cannot serve single-shot calls, and the
    // operator having switched this capability off on purpose. All three fall
    // through to a dispatched agent run, which is the point of that path —
    // grading still happens, on the subscription seat, just slower.
    //
    // Every other error is a real call that went wrong. Report it and let the next
    // evaluation round retry rather than spending an agent run on a blip.
    const NO_INFERENCE_PATH = ['missing_key', 'unsupported_provider', 'capability_disabled'];
    const needsDispatch = toJudge.length > 0 && !!inferenceError && NO_INFERENCE_PATH.includes(inferenceError.kind);

    if (toJudge.length > 0 && inferenceError && !needsDispatch) {
      for (const c of toJudge) {
        const cs = state.criteria.find(s => s.index === c.index);
        if (cs) {
          cs.verdict = 'NOT_EVALUATED';
          cs.evidence = `Not graded: ${describeInferenceError(inferenceError)}`;
        }
      }
    } else if (needsDispatch) {
      const proseInputs = toJudge.map(c => ({
        index: c.index,
        text: criterionText(criteria[c.index]),
        fingerprint: c.fingerprint,
      }));

      const setAll = (verdict: CriterionVerdict, evidence: string, taskId?: string) => {
        for (const c of toJudge) {
          const cs = state.criteria.find(s => s.index === c.index);
          if (!cs) continue;
          cs.verdict = verdict;
          cs.evidence = evidence;
          if (taskId) cs.workerTaskId = taskId;
        }
      };

      if (opts.dispatchCommands === false) {
        // Read-only evaluation: report what is missing without spending an agent run.
        setAll('NOT_EVALUATED', 'Prose criteria not graded: this run does not dispatch evaluation tasks');
      } else if (alreadyFailing) {
        // The fold is `fail` whatever the model says, so grading now would buy a
        // verdict that cannot change the outcome. Re-graded once the failure clears.
        setAll('NOT_EVALUATED', 'Not graded: another criterion has already failed, so the mission cannot pass this round');
      } else {
        const resolution = await resolveProseCriteria({
          missionId,
          criteria: proseInputs,
          evidence: { tasks: completedTasks, artifacts: evidenceArtifacts },
        });

        if (resolution.kind === 'pending') {
          // PENDING, not NOT_EVALUATED: a verdict is genuinely in flight, and
          // `handleProseEvalOutcome` will replace it when the evaluator reports.
          setAll('PENDING', resolution.evidence, resolution.taskId);
        } else {
          setAll('NOT_EVALUATED', resolution.evidence);
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
  return evaluateCriteriaNow(missionId, {
    evaluatedBy: 'auto',
    noteTitle: ON_COMPLETION_NOTE_TITLE,
    // This is the completion gate — worker dispatch is appropriate here.
    allowWorkerDispatch: true,
  });
}
