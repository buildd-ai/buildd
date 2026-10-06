/**
 * CI Retry — Ralph Loop Integration
 *
 * Builds retry task data when a CI check suite fails on a buildd worker's PR.
 * The retry task inherits branch context and failure metadata so the next
 * agent attempt picks up the previous attempt's branch and fixes the failure.
 *
 * Triggered in real time by the GitHub `check_suite` failure webhook (no cron),
 * and dispatched to a connected runner via pusher.
 */

import { isOpenTaskStatus } from '@buildd/shared';
import { formatAttemptTitle } from '@/lib/task-title';
import { lineageStamp } from '@/lib/attempt-lineage';
import { MODEL_REJECTION_CONTEXT_KEY } from '@/lib/worker-exit-taxonomy';
import { POLICY_DEFAULTS, policyValue } from '@/lib/policy-overrides';

/**
 * Default CI fix attempts per PR when the workspace sets no gitConfig.maxCiRetries.
 * Public default; read the live value with `policyValue('maxCiRetries')`.
 */
export const DEFAULT_MAX_CI_RETRIES = POLICY_DEFAULTS.maxCiRetries;

export interface CIRetryParams {
  originalTask: {
    id: string;
    title: string;
    description: string | null;
    workspaceId: string;
    context: Record<string, unknown> | null;
    missionId?: string | null;
  };
  worker: {
    id: string;
    branch: string;
    prNumber: number | null;
  };
  failureContext: string;
  repoFullName: string;
  /** GitHub Actions run id/url for the failed run. */
  ciRunId?: number | null;
  ciRunUrl?: string | null;
  /**
   * Id of the job that actually failed, when the webhook resolved one. Lets the
   * instruction point straight at a log that returns content instead of making
   * the agent list jobs first.
   */
  ciFailedJobId?: number | null;
  /** Workspace-level max CI retries (from gitConfig.maxCiRetries). Overrides task-level maxIterations. 0 disables. */
  workspaceMaxCiRetries?: number;
  /**
   * True when the failing head SHA was pushed by someone other than the buildd worker
   * (a human, a GitHub Action, etc.). The retry task is still created so the PR gets
   * fixed, but the attempt counter is NOT incremented — the agent's budget is preserved.
   */
  foreignHeadSha?: boolean;
  /** Login/name of the non-worker commit author, recorded for forensics. */
  foreignCommitAuthor?: string;
  /**
   * The PR's actual head/base. When the head is not `worker.branch` the retry
   * is bound to an existing PR (typically a mission integration PR), and
   * `create_pr` rejects a fresh PR from the worker branch as duplicate lineage.
   */
  prRefs?: { headRef: string; baseRef: string | null } | null;
}

export interface CIRetryTask {
  title: string;
  description: string;
  workspaceId: string;
  parentTaskId: string;
  creationSource: 'webhook';
  taskClass: 'attempt';
  missionId: string | null;
  context: Record<string, unknown>;
}

/** A fix attempt already filed against a PR — the columns `summarizePrFixAttempts` reads. */
export interface PrFixAttemptRow {
  id: string;
  status: string;
  creationSource: string | null;
  outputRequirement?: string | null;
  ciRetryPrNumber: number | null;
  context: unknown;
  createdAt: Date | string;
}

/**
 * What the fix attempts already filed for one PR say about the next CI failure.
 *
 * - `inFlight`: a fix attempt (CI retry, review fix, conflict fix) that is still
 *   pending or running. It will push again, so a new CI retry would stack on it.
 * - `ciRetriesUsed`: agent-authored CI retries the automatic loop has filed
 *   since the last manual "Fix CI" click (which grants a fresh budget). Foreign
 *   pushes and drift-diagnose tasks never count.
 *
 * The budget is counted from the rows rather than from the owner task's
 * `context.iteration`: once the PR's root task and its attempts are all
 * completed, which of them the owner lookup returns is arbitrary, and the root
 * task never carries an iteration at all.
 */
export function summarizePrFixAttempts(
  rows: PrFixAttemptRow[],
  prNumber: number,
): { inFlight: PrFixAttemptRow | null; ciRetriesUsed: number } {
  const time = (r: PrFixAttemptRow) => new Date(r.createdAt).getTime();
  const inFlight = rows.find((r) => isOpenTaskStatus(r.status)) ?? null;

  const ciRows = rows.filter((r) => r.ciRetryPrNumber === prNumber);
  const lastManual = ciRows
    .filter((r) => r.creationSource === 'dashboard')
    .reduce((max, r) => Math.max(max, time(r)), Number.NEGATIVE_INFINITY);

  const ciRetriesUsed = ciRows.filter((r) => {
    if (r.creationSource !== 'webhook') return false;
    if (r.outputRequirement === 'artifact_required') return false;
    const ctx = (r.context && typeof r.context === 'object' ? r.context : {}) as Record<string, unknown>;
    if (ctx.foreign_head_sha === true) return false;
    // The CLI refused the model before the agent took a turn: the PR was never attempted.
    if (ctx[MODEL_REJECTION_CONTEXT_KEY]) return false;
    return time(r) > lastManual;
  }).length;

  return { inFlight, ciRetriesUsed };
}

/**
 * Build a retry task from a CI failure event.
 *
 * Returns null when retries are exhausted or disabled (maxCiRetries === 0),
 * which prevents infinite retry loops.
 */
export function buildCIRetryTask(params: CIRetryParams): CIRetryTask | null {
  const { originalTask, worker, failureContext, repoFullName, ciRunId, ciRunUrl, ciFailedJobId, workspaceMaxCiRetries, foreignHeadSha, foreignCommitAuthor, prRefs } = params;
  const ctx = originalTask.context || {};

  const currentIteration = typeof ctx.iteration === 'number' ? ctx.iteration : 0;
  // Priority: workspace gitConfig.maxCiRetries > task context.maxIterations > policy default.
  // maxCiRetries === 0 explicitly disables CI retries for the workspace.
  const maxIterations = workspaceMaxCiRetries ?? (typeof ctx.maxIterations === 'number' ? ctx.maxIterations : policyValue('maxCiRetries'));

  // Honor the "retries disabled" switch regardless of commit authorship.
  if (maxIterations <= 0) {
    return null;
  }

  // Foreign commits (non-worker pushes) do NOT consume a retry attempt.
  // Worker commits do consume one and must respect the exhaustion cap.
  if (!foreignHeadSha && currentIteration >= maxIterations) {
    return null;
  }

  // Foreign commits keep the same iteration so the agent's budget is preserved.
  const nextIteration = foreignHeadSha ? currentIteration : currentIteration + 1;

  // Display number always advances for readability (title and description).
  // context.iteration tracks actual agent-authored attempts.
  const displayIteration = currentIteration + 1;

  return {
    title: formatAttemptTitle('builder', originalTask.title, { reason: 'after CI', iteration: displayIteration }),
    description: buildRetryDescription(originalTask, failureContext, repoFullName, displayIteration, maxIterations, ciRunId ?? null, ciRunUrl ?? null, foreignHeadSha, foreignCommitAuthor, nextIteration >= maxIterations, ciFailedJobId ?? null, worker.prNumber ?? null, prRefs?.headRef && prRefs.headRef !== worker.branch ? { head: prRefs.headRef, base: prRefs.baseRef, workerBranch: worker.branch } : null),
    workspaceId: originalTask.workspaceId,
    parentTaskId: originalTask.id,
    creationSource: 'webhook',
    taskClass: 'attempt' as const,
    // Inherit missionId so the retry stays attached to the mission loop.
    missionId: originalTask.missionId ?? null,
    context: {
      // Branch continuity — the new worker's worktree starts from the previous
      // attempt's branch, so fixes land on the same PR.
      baseBranch: worker.branch,
      // Explicit continuity marker (same value; preferred over baseBranch going forward)
      resumeBranch: worker.branch,
      // Copy lastCommitSha from parent context if captured by failure-capture path
      ...(typeof ctx.lastCommitSha === 'string' ? { lastCommitSha: ctx.lastCommitSha } : {}),
      // Structured failure context (replaces bare string going forward)
      failureContext: {
        summary: failureContext,
        errorType: 'ci_failure' as const,
        ...(typeof ctx.lastCommitSha === 'string' ? { commitSha: ctx.lastCommitSha } : {}),
      },
      // Chain identity: the root task and every PR number seen so far.
      ...lineageStamp(originalTask, [worker.prNumber]),
      // Retry metadata
      iteration: nextIteration,
      maxIterations,
      // CI run reference for on-demand log pulls
      ...(ciRunId ? { ciRunId } : {}),
      ...(ciRunUrl ? { ciRunUrl } : {}),
      // Preserve verification command if set
      ...(ctx.verificationCommand ? { verificationCommand: ctx.verificationCommand } : {}),
      // PR reference
      ...(worker.prNumber ? { prNumber: worker.prNumber } : {}),
      // Skill slugs (preserve from original)
      ...(ctx.skillSlugs ? { skillSlugs: ctx.skillSlugs } : {}),
      // Provenance — records that this retry was triggered by a non-worker commit.
      // Lets mission timeline / forensics distinguish 'agent attempt N of M' from
      // 'someone else pushed; no attempt consumed'.
      ...(foreignHeadSha ? {
        foreign_head_sha: true,
        ...(foreignCommitAuthor ? { foreignCommitAuthor } : {}),
      } : {}),
    },
  };
}

function buildRetryDescription(
  task: CIRetryParams['originalTask'],
  failureContext: string,
  repoFullName: string,
  iteration: number,
  maxIterations: number,
  ciRunId: number | null,
  ciRunUrl: string | null,
  foreignHeadSha?: boolean,
  foreignCommitAuthor?: string,
  isFinalAttempt?: boolean,
  ciFailedJobId?: number | null,
  prNumber?: number | null,
  bound: { head: string; base: string | null; workerBranch: string } | null = null,
): string {
  // `gh run view <id> --log-failed` returns EMPTY output and exit 0 — it is not
  // a retention problem, the command simply does not produce the failed-step
  // output it advertises. It used to be the only instruction here, so an agent
  // followed it, got nothing, and reconstructed the failure by hand. Point at
  // the jobs-logs API, which returns the log.
  const logCommand = ciFailedJobId
    ? `gh api --allow-escape-sequences /repos/${repoFullName}/actions/jobs/${ciFailedJobId}/logs`
    : `# find the failing job, then read its log\ngh api /repos/${repoFullName}/actions/runs/${ciRunId}/jobs \\\n  -q '.jobs[] | select(.conclusion=="failure") | .id'\ngh api --allow-escape-sequences /repos/${repoFullName}/actions/jobs/<JOB_ID>/logs`;

  const logSection = ciRunId
    ? `## Pull the failing log

\`\`\`bash
${logCommand}
\`\`\`
The log is long. Strip the timestamp prefix and read the tail, or pull just the
test digest:
\`\`\`bash
gh api --allow-escape-sequences /repos/${repoFullName}/actions/jobs/${ciFailedJobId ?? '<JOB_ID>'}/logs \\
  | sed 's/^[0-9T:.-]*Z //' | awk '/unit test files? failed:/,/Full output/'
\`\`\`${ciRunUrl ? `\nRun: ${ciRunUrl}` : ''}
`
    : '';

  // Bound PR: the head is not the worker's branch, so create_pr from the
  // worker branch 409s as duplicate lineage. Name the real push target.
  const boundNote = bound
    ? `**Bound PR lineage:** PR #${prNumber} is open from \`${bound.head}\`${bound.base ? ` into \`${bound.base}\`` : ''}, not from \`${bound.workerBranch}\`. Do NOT open a new task-branch PR with \`create_pr\` — it will 409 as duplicate lineage, even if the task description below says to open one. Push your fix to \`${bound.head}\` (fast-forward; fetch first, never force), then call \`create_pr\` only to record the existing PR if asked.\n\n`
    : '';

  const prChecksCommand = prNumber ? `gh pr checks ${prNumber}` : 'gh pr checks';

  const foreignNote = foreignHeadSha
    ? `> **Note:** This CI failure was triggered by a commit from ${foreignCommitAuthor ? `@${foreignCommitAuthor}` : 'an external contributor'}, not the buildd agent. Your retry budget is **not consumed** by this attempt.\n\n`
    : '';

  // On the last attempt the next reader is a human, not another agent. Ask for
  // the handoff explicitly — Home's blocked card leads with this text, and
  // without it the human inherits a red PR and no advice.
  const handoffSection = isFinalAttempt
    ? `
## If you cannot get CI green

This is the **final attempt** — no further retry will be dispatched, and a human
picks this up next. Do not fail silently:

- Call \`complete_task\` with \`nextSuggestion\` set to the specific next action a
  human should take (root cause if you found it, what you ruled out, and the
  concrete fix or decision needed). One or two sentences.
- Report the failure through \`error\` as usual — \`nextSuggestion\` is the handoff,
  not a substitute for it.
`
    : '';

  return `CI checks failed on the PR for "${task.title}" (${repoFullName}).

**Attempt ${iteration} of ${maxIterations}.**

${foreignNote}${boundNote}## What failed

\`\`\`
${failureContext}
\`\`\`

${logSection}## Instructions

1. Check out the existing branch — your worktree is based on the previous attempt's work
2. ${ciRunId ? 'Pull the failing logs with the command above and read them carefully' : 'Read the failure summary above carefully'}
3. Fix the failing tests/build/lint issues
4. Run the verification command locally before completing
5. Push your fixes to ${bound ? `\`${bound.head}\`` : 'the existing branch'} (the PR will auto-update)
6. Confirm the PR's own checks are green: \`${prChecksCommand}\`. A local run, or a
   type check of one file, is not enough: it does not run the checks that gate
   the merge. Wait for the checks to finish. Report SUCCESS only when every
   gating check passes. If any check is still red or failing, do not report
   SUCCESS: say which check and why through \`error\`, or fix it.

${handoffSection}${task.description ? `## Original Task Description\n\n${task.description}` : ''}`;
}
