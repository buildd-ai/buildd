import { db } from '@buildd/core/db';
import { missions, tasks, workers, artifacts, missionNotes } from '@buildd/core/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { evaluateGoalCriteria, recalculateOverall, isDeliverableTask } from '@buildd/core/mission-helpers';
import type {
  GoalCriterion,
  GoalCriteriaState,
  CriterionVerdict,
  GoalCriteriaEvidenceRef,
  CriteriaReviewerReport,
} from '@buildd/shared';
import { inferenceCall, describeInferenceError, type InferenceError } from '@buildd/core/inference-client';
import { resolveProseCriterion, type ProseRunnerEvidence } from './mission-criteria-prose';
import { resolveWorkspaceCriteriaGrader } from './mission-criteria-strategy';
import { pickCriteriaGrader, type CriteriaGrader } from './mission-criteria-grader';
import { resolveCriteriaWorkerEval, type WorkerEvalCriterionInput } from './mission-criteria-worker-eval';
import { applyReviewerFindings } from './criteria-reviewer-findings';
import { fireGateEvent, GATE_SLUGS } from '@/lib/gate-ledger';

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
 * COMMAND_VERDICT_TTL_MS, and only prose grading is cached — for LLM_REVERIFY_MS,
 * because it costs tokens or an agent run.
 *
 * Prose (`description`) criteria have two graders, chosen per criterion
 * (criterion `grader` > workspace `gitConfig.criteriaGrader` > `auto`):
 * `api` — a batched `inferenceCall` on the team's API key, billed per token —
 * and `runner` — one read-only verification task per criterion
 * (`mission-criteria-prose.ts`), graded on the team's own runner credential, an
 * OAuth seat included. `auto` uses `api` when the inference client resolves a
 * key and `runner` otherwise.
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

type EvidenceTask = { id: string; title: string | null; summary: string | undefined; at: Date | null };
type EvidenceArtifact = { id: string; title: string | null; type: string; contentSnippet: string | null; at: Date | null };

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
/** `3d ago` / `today` — cheap enough that evidence never needs a raw ISO timestamp in-prompt. */
function relativeAge(at: Date | null): string {
  if (!at) return 'age unknown';
  const days = Math.floor((Date.now() - at.getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return '1d ago';
  return `${days}d ago`;
}

async function judgeWithLLM(
  inputs: LLMCriterionInput[],
  missionTitle: string,
  missionDescription: string | null,
  completedTasks: EvidenceTask[],
  evidenceArtifacts: EvidenceArtifact[],
  scope: { teamId: string; workspaceId?: string | null },
): Promise<{ verdicts: LLMCriterionVerdict[]; error?: InferenceError }> {
  // Newest first (see the sort at the call site) — the ordering itself is a
  // recency signal, reinforced by the explicit age label on each item.
  const taskEvidence = completedTasks.map(t =>
    `[task:${t.id.slice(0, 8)}] (${relativeAge(t.at)}) "${t.title ?? '(untitled)'}"${t.summary ? `\nSummary: ${t.summary}` : ' (no summary)'}`,
  ).join('\n\n');

  const artifactEvidence = evidenceArtifacts.map(a =>
    `[artifact:${a.id.slice(0, 8)}] (${relativeAge(a.at)}) "${a.title ?? '(untitled)'}" (${a.type})${a.contentSnippet ? `\nContent snippet:\n${a.contentSnippet}` : ''}`,
  ).join('\n\n');

  const criteriaList = inputs.map((c, i) => `${i + 1}. index=${c.index}: ${c.text}`).join('\n');
  const hasEvidence = completedTasks.length > 0 || evidenceArtifacts.length > 0;

  const systemPrompt = `You are evaluating whether a mission's completion criteria are met based on available evidence.
Be evidence-grounded: only return "pass" if evidence directly supports the criterion being satisfied.
Return "UNVERIFIED" when evidence is ambiguous or absent — not "fail".
Return "fail" only when evidence clearly contradicts the criterion.
Evidence is listed newest-first with its age. Nothing marks an older item as superseded, so when two
items address the same claim and disagree, trust the more recent one — an audit or gap report written
before a later item resolved it is not still true just because it exists.
Respond ONLY with a JSON object — no prose, no markdown fences.`;

  const userPrompt = `## Mission: ${missionTitle}
${missionDescription ? `Description: ${missionDescription}\n` : ''}

## Criteria to evaluate (${inputs.length}):
${criteriaList}

## Evidence (newest first)

### Completed tasks (${completedTasks.length}):
${taskEvidence || '(none)'}

### Artifacts (${evidenceArtifacts.length}):
${artifactEvidence || '(none)'}

${!hasEvidence ? '⚠️  No evidence available. Return UNVERIFIED for all criteria.\n' : ''}
## Instructions
For each criterion above, determine whether the evidence shows it is met, not met, or unverifiable.
Cite the specific evidence item (use the [task:XXXXXXXX] or [artifact:XXXXXXXX] ref from above).
When evidence conflicts, prefer the more recent item — check the age shown next to each one.

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
     * and runner-graded prose criteria (default true).
     * `false` makes this a read-only evaluation that spends no agent runs.
     */
    dispatchCommands?: boolean;
    /**
     * Allow dispatching the batched worker evaluator task for command criteria.
     * Defaults to `false` to guard against dispatch from the routine heartbeat LLM
     * path — the worker evaluator is intentionally TRIGGER-GATED to mission-complete
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
      // Option A': `all_prs_merged` needs the opt-in to know whether a merged
      // task PR reached trunk or only the integration branch. Absent, the
      // criterion keeps its pre-A' meaning — which for an opted-in mission is
      // a pass with nothing on the default branch.
      integrationBranchEnabled: true,
      status: true,
      // Reviewer findings accumulated on merged PRs — read before any evaluator
      // is dispatched (see the fold below).
      criteriaReviewerFindings: true,
    },
  });
  if (!mission) return null;

  const fireNotEvaluated = (index: number, reason: string, detail?: Record<string, unknown>) => {
    fireGateEvent({
      gate: GATE_SLUGS.CRITERIA_NOT_EVALUATED,
      surface: 'evaluateCriteriaNow',
      outcome: 'warned',
      reason,
      workspaceId: mission.workspaceId ?? null,
      missionId,
      callerOrigin: 'system',
      detail: { criterionIndex: index, ...detail },
    });
  };

  const criteria = Array.isArray(mission.goalCriteria) ? (mission.goalCriteria as GoalCriterion[]) : [];
  if (criteria.length === 0) return null;

  const priorState = (mission.goalCriteriaState ?? null) as GoalCriteriaState | null;
  const priorAgeMs = priorState?.evaluatedAt ? Date.now() - Date.parse(priorState.evaluatedAt) : Infinity;

  // ── Evidence assembly ──────────────────────────────────────────────────────
  const missionTasks = await db.query.tasks.findMany({
    where: eq(tasks.missionId, missionId),
    columns: {
      id: true, status: true, kind: true, title: true, mode: true,
      taskClass: true, creationSource: true, category: true, result: true, createdAt: true,
      // Attempt lineage: a closed PR followed by a merged retry PR in the same
      // chain is superseded without a manual record (pr-shipped.ts).
      parentTaskId: true,
    },
  });

  let missionWorkers: Array<{
    taskId: string | null;
    mergedAt: Date | null;
    prUrl: string | null;
    branch: string;
    prBaseRef: string | null;
    prNumber: number | null;
    prLifecycleStatus: string | null;
    supersededByPrNumber: number | null;
  }> = [];
  if (missionTasks.length > 0) {
    const taskIds = missionTasks.map(t => t.id);
    missionWorkers = await db.query.workers.findMany({
      where: inArray(workers.taskId, taskIds),
      // `prBaseRef` is what separates "merged into the mission's integration
      // branch" from "merged into trunk". Null is unknown, never trunk.
      // `prNumber` joins a stored reviewer finding to the PR it was made on.
      // `prLifecycleStatus` + `supersededByPrNumber` feed the shared shipped
      // predicate `canCompleteMission` uses, so the two cannot disagree.
      columns: {
        taskId: true, mergedAt: true, prUrl: true, branch: true, prBaseRef: true, prNumber: true,
        prLifecycleStatus: true, supersededByPrNumber: true,
      },
    });
  }

  const missionArtifacts = await db.query.artifacts.findMany({
    where: eq(artifacts.missionId, missionId),
    columns: { id: true, key: true, type: true, title: true, content: true, updatedAt: true },
  });

  // ── Mechanical evaluation (always re-run: it is one query, never a snapshot) ─
  const state = evaluateGoalCriteria(
    {
      id: mission.id,
      workingBranch: mission.workingBranch,
      integrationBranchEnabled: mission.integrationBranchEnabled,
    },
    criteria,
    {
      tasks: missionTasks,
      workers: missionWorkers.map(w => ({
        taskId: w.taskId,
        mergedAt: w.mergedAt,
        prUrl: w.prUrl,
        prNumber: w.prNumber,
        prLifecycleStatus: w.prLifecycleStatus,
        supersededByPrNumber: w.supersededByPrNumber,
        branchName: w.branch,
        prBaseRef: w.prBaseRef,
      })),
      artifacts: missionArtifacts.map(a => ({ key: a.key, type: a.type })),
      evaluatedBy: opts.evaluatedBy,
    }
  );

  // ── Reviewer findings: prose criteria already graded where the evidence was ─
  //
  // Runs BEFORE any evaluator is chosen, not as a fallback for one. A reviewer
  // read the actual diff; the standalone evaluator reads task summaries. When
  // the reviewer spoke to a criterion on a PR that merged, that reading wins and
  // no evaluator is dispatched for it at all — which is the whole point: the
  // criterion reaches a cited verdict without a second agent run that would have
  // had less to go on.
  //
  // Criteria no merged PR spoke to fall through untouched, and the evidence
  // assembly below runs for them exactly as before.
  const mergedPrNumbers = new Set(
    missionWorkers
      .filter(w => w.mergedAt != null && typeof w.prNumber === 'number')
      .map(w => w.prNumber as number),
  );
  const fold = applyReviewerFindings({
    criteria,
    state,
    reports: mission.criteriaReviewerFindings as CriteriaReviewerReport[] | null,
    mergedPrNumbers,
  });
  if (fold.decided.length > 0) {
    console.log(
      `[criteria-eval] mission ${missionId}: reviewer findings decided criteri${fold.decided.length === 1 ? 'on' : 'a'} [${fold.decided.join(', ')}]`,
    );
  }

  const canDispatch = opts.dispatchCommands !== false && opts.allowWorkerDispatch === true;
  const alreadyFailing = state.criteria.some(c => c.verdict === 'fail');

  // ── Command criteria: one batched worker task runs them ────────────────────
  //
  // TRIGGER-GATED: allowWorkerDispatch is only set from ensureCriteriaVerdict (the
  // completion gate) and the on-demand route. The routine heartbeat prepass calls
  // evaluateCriteriaNow with allowWorkerDispatch=false (the default) so it never
  // dispatches a worker evaluator task mid-planning-cycle.
  //
  // Command criteria are structurally unevaluable by an LLM call — the pure
  // evaluator cannot know whether a command exits 0 — so they always go here.
  // Prose criteria never do: they pick a grader per criterion below. (The old
  // per-workspace/team 'worker' strategy that batched prose here too is gone.)
  const workerBound = state.criteria.filter(
    cs => cs.type === 'command' && (cs.verdict === 'UNVERIFIED' || cs.verdict === 'NOT_EVALUATED')
  );

  if (workerBound.length > 0 && !alreadyFailing) {
    if (!canDispatch) {
      // Read-only evaluation pass — don't spend an agent run. Leave these
      // criteria at their current verdict rather than clearing them.
      for (const cs of workerBound) {
        if (cs.verdict === 'NOT_EVALUATED') {
          cs.evidence = 'Command criterion needs a dispatched worker task. This run does not dispatch evaluation tasks.';
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
          fireNotEvaluated(cs.index, 'evaluator_unavailable', { resolutionEvidence: resolution.evidence });
        }
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

  // ── Prose criteria: api grader or runner grader ────────────────────────────
  //
  // Each prose criterion has a grader (criterion > workspace gitConfig > auto):
  //   api    — one batched `inferenceCall` on the team's API key. With no key the
  //            criterion says so (NOT_EVALUATED) — it never switches to a runner.
  //   runner — one read-only verification task per criterion on the team's own
  //            runner credential (an OAuth seat included). No inference call.
  //   auto   — try api; when the inference client finds no path (no key, a
  //            provider that cannot serve inference, capability switched off),
  //            fall through to runner. The check is the inference client's own
  //            credential resolution, not a second lookup here.
  const inlineLlmEligible = state.criteria.filter(
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
        if (prior.workerTaskId) c.workerTaskId = prior.workerTaskId;
        if (prior.evaluatedAt) c.evaluatedAt = prior.evaluatedAt;
        carried.add(c.index);
      }
    }

    const toJudge = inlineLlmEligible.filter(c => !carried.has(c.index));

    const workspaceGrader = toJudge.length > 0 ? await resolveWorkspaceCriteriaGrader(mission.workspaceId) : null;
    const graderOf = (index: number): CriteriaGrader =>
      pickCriteriaGrader(criteria[index] as { grader?: unknown } | undefined, workspaceGrader);

    const apiBound = toJudge.filter(c => graderOf(c.index) !== 'runner');
    const runnerBound = toJudge.filter(c => graderOf(c.index) === 'runner');

    // Newest first. A grader has no other signal for which of two artifacts
    // addressing the same claim is current — an audit written before a fix
    // landed carries no marker saying a later item supersedes it. Ordering by
    // recency, plus the prompt instruction below, is the cheapest available
    // proxy: prefer what was produced most recently over what an old snapshot
    // still says.
    const completedTasks: EvidenceTask[] = missionTasks
      .filter(t => t.status === 'completed')
      .map(t => ({
        id: t.id,
        title: t.title,
        summary: (t.result as any)?.summary as string | undefined,
        at: t.createdAt ?? null,
      }))
      .sort((a, b) => (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0));

    const evidenceArtifacts: EvidenceArtifact[] = missionArtifacts
      .map(a => ({
        id: a.id,
        title: a.title,
        type: a.type,
        contentSnippet: a.content ? a.content.substring(0, ARTIFACT_CONTENT_LIMIT) : null,
        at: a.updatedAt ?? null,
      }))
      .sort((a, b) => (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0));

    // ── api grader ──
    if (apiBound.length > 0) {
      const judged = await judgeWithLLM(
        apiBound.map(c => ({ index: c.index, text: criterionText(criteria[c.index]) })),
        mission.title,
        mission.description ?? null,
        completedTasks,
        evidenceArtifacts,
        { teamId: mission.teamId, workspaceId: mission.workspaceId },
      );
      const inferenceError = judged.error;

      for (const lv of judged.verdicts) {
        const criterionState = state.criteria.find(c => c.index === lv.index);
        if (!criterionState) continue;
        criterionState.verdict = lv.verdict;
        if (lv.evidence) criterionState.evidence = lv.evidence;
        if (lv.evidenceRef) criterionState.evidenceRefs = [lv.evidenceRef];
      }

      if (!inferenceError) {
        for (const c of apiBound) {
          const cs = state.criteria.find(s => s.index === c.index);
          if (cs && cs.verdict === 'NOT_EVALUATED') {
            cs.evidence = 'The evaluator returned no verdict for this criterion';
            fireNotEvaluated(cs.index, 'evaluator_no_output');
          }
        }
      } else {
        // Three errors mean "this team has no inference path for grading", not
        // "a call failed": no key, a provider that cannot serve single-shot
        // calls, and the operator having switched this capability off. Under
        // `auto` those fall through to the runner grader — grading still happens,
        // on the team's seat, just asynchronously. An explicit `api` does not:
        // the owner asked for per-token grading, so say it cannot happen.
        //
        // Every other error is a real call that went wrong. Report it and let the
        // next evaluation round retry rather than spending an agent run on a blip.
        const NO_INFERENCE_PATH = ['missing_key', 'unsupported_provider', 'capability_disabled'];
        const noPath = NO_INFERENCE_PATH.includes(inferenceError.kind);
        for (const c of apiBound) {
          const cs = state.criteria.find(s => s.index === c.index);
          if (!cs) continue;
          if (noPath && graderOf(c.index) === 'auto') {
            runnerBound.push(c);
            continue;
          }
          cs.verdict = 'NOT_EVALUATED';
          cs.evidence = noPath
            ? `Not graded: grader is "api" but ${describeInferenceError(inferenceError)}. Connect an API key, or set grader "runner" (or "auto") to grade on a runner`
            : `Not graded: ${describeInferenceError(inferenceError)}`;
          fireNotEvaluated(cs.index, inferenceError.kind);
        }
      }
    }

    // ── runner grader: one verification task per criterion ──
    if (runnerBound.length > 0) {
      if (opts.dispatchCommands === false) {
        // Read-only evaluation: report what is missing without spending an agent run.
        for (const c of runnerBound) {
          c.verdict = 'NOT_EVALUATED';
          c.evidence = 'Prose criterion not graded: this run does not dispatch verification tasks';
          fireNotEvaluated(c.index, 'no_dispatch');
        }
      } else if (alreadyFailing) {
        // The fold is `fail` whatever the runner says, so grading now would buy a
        // verdict that cannot change the outcome. Re-graded once the failure clears.
        for (const c of runnerBound) {
          c.verdict = 'NOT_EVALUATED';
          c.evidence = 'Not graded: another criterion has already failed, so the mission cannot pass this round';
        }
      } else {
        const prByTask = new Map(missionWorkers.filter(w => w.taskId).map(w => [w.taskId as string, w]));
        const runnerEvidence: ProseRunnerEvidence = {
          deliverables: missionTasks.filter(t => isDeliverableTask(t)).map(t => {
            const w = prByTask.get(t.id);
            return {
              id: t.id,
              title: t.title,
              status: t.status,
              prUrl: w?.prUrl ?? null,
              prNumber: w?.prNumber ?? null,
              merged: w?.mergedAt != null,
            };
          }),
          artifacts: missionArtifacts.map(a => ({ id: a.id, title: a.title, type: a.type, key: a.key ?? null })),
        };

        // Independent per criterion: one criterion's missing runner or stuck
        // task never holds another's verdict.
        const resolutions = await Promise.all(runnerBound.map(c => resolveProseCriterion({
          missionId,
          criterionIndex: c.index,
          text: criterionText(criteria[c.index]),
          fingerprint: c.fingerprint ?? '',
          evidence: runnerEvidence,
        }).catch(e => ({ kind: 'unavailable' as const, evidence: `Runner grading failed to dispatch: ${e instanceof Error ? e.message : String(e)}` }))));

        runnerBound.forEach((c, i) => {
          const r = resolutions[i]!;
          if (r.kind === 'pending') {
            // PENDING, not NOT_EVALUATED: a verdict is genuinely in flight, and the
            // completion gate reports it as `criteria_pending`. Neither counts as a pass.
            c.verdict = 'PENDING';
            c.evidence = r.evidence;
            c.workerTaskId = r.taskId;
            if (r.awaitingRunner) {
              c.awaitingRunner = true;
              // The situation line names the criterion it is waiting on; a prose
              // criterion with no label would otherwise read as "description".
              if (!c.label) {
                const t = criterionText(criteria[c.index]).trim();
                c.label = t.length > 80 ? t.slice(0, 80) + '…' : t;
              }
            }
          } else if (r.kind === 'verdict') {
            c.verdict = r.verdict;
            c.evidence = r.evidence;
            c.workerTaskId = r.taskId;
            c.evaluatedAt = r.evaluatedAt;
            if (r.verdict === 'NOT_EVALUATED') fireNotEvaluated(c.index, 'evaluator_no_output', { taskId: r.taskId });
          } else {
            c.verdict = 'NOT_EVALUATED';
            c.evidence = r.evidence;
            fireNotEvaluated(c.index, 'evaluator_unavailable', { resolutionEvidence: r.evidence });
          }
        });
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
