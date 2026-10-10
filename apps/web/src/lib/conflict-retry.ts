/**
 * Conflict-retry — auto-dispatch when a PR has merge conflicts.
 *
 * When a merge attempt fails because the PR has conflicts (dirty), instead of
 * surfacing a useless Retry button, buildd dispatches a same-branch needs-work
 * task so the original agent can resolve the conflicts in context.
 *
 * Doctrine (from PR #1123 / task 6cc036c3):
 *   - Do NOT create a separate integration task.
 *   - Flip the originating task back to needs-work on the same branch.
 *   - One retry task per (workspaceId, prNumber, headSha) — deduped.
 *   - One live fix attempt per PR (conflict, CI or review fix): they all push
 *     to the same branch.
 *
 * Guard:
 *   - Honors maxConflictIterations (default 3). On exhaustion, does NOT dispatch
 *     and returns { exhausted: true } — callers must escalate to human. The
 *     budget bounds attempts at ONE conflict: when the caller names the base
 *     tip, a conflict basis (head + base) no attempt has seen yet gets one
 *     more attempt past the cap. The base moving is what makes a new
 *     conflict, so this stays bounded by real merges, never by retries.
 *   - Controlled by workspace gitConfig.autoResolveMergeConflicts (default ON).
 */

import { OPEN_TASK_STATUSES, TERMINAL_TASK_STATUSES } from '@buildd/shared';
import { db } from '@buildd/core/db';
import { tasks, workers, workspaces, missionNotes } from '@buildd/core/db/schema';
import type { WorkspaceGitConfig } from '@buildd/core/db/schema';
import { eq, and, or, sql, inArray } from 'drizzle-orm';
import { findBlockingPr, isAdvisoryManifest, isDownstreamOf, partitionOverlapEdges, type SoftOverlapEdge } from '@buildd/core/path-overlap';
import { overlapTouchesSerializedSurface } from '@/lib/change-intent';
import { announceTaskCreated, wakeTask } from '@/lib/dispatch-authority';
import { runSupersessionPrecheck, DEFAULT_SUPERSESSION_DRIFT_RATIO } from '@/lib/supersession-check';
import { notifyTeamOf } from '@/lib/notify';
import { githubApi } from '@/lib/github';
import { refreshBehindPr, type RefreshOutcome } from '@/lib/base-refresh';
import type { SemanticAssessment } from '@/lib/semantic-refresh';
import type { BranchUpdateFailure } from '@/lib/pr-branch-update';
import { formatAttemptTitle } from '@/lib/task-title';
import { inheritAttemptIdentity } from '@/lib/attempt-identity';
import { lineageStamp } from '@/lib/attempt-lineage';
import { dependencyBotPushRefusal, isDependencyBotPrContext } from '@/lib/dependency-bot-pr';
import { GATE_SLUGS, fireGateEvent } from '@/lib/gate-ledger';
import { schedulePrScopeReconcile } from '@/lib/pr-scope-reconcile-trigger';
import { scheduleFailurePatternSentinel } from '@/lib/failure-pattern-sentinel-trigger';
import type { MigrationCollision } from '@/lib/migration-safety';
import { POLICY_DEFAULTS, policyValue } from '@/lib/policy-overrides';
import { classifyConflictFix, type ConflictRecoveryAction } from '@/lib/conflict-fix-liveness';
import { observeConflict, type ConflictSeen } from '@/lib/workflow/seam';
import { kernelDeliveryForPr } from '@/lib/workflow/authority';

/** Public default; read the live value with `policyValue('maxConflictIterations')`. */
export const DEFAULT_MAX_CONFLICT_ITERATIONS = POLICY_DEFAULTS.maxConflictIterations;

// ── Classification ────────────────────────────────────────────────────────────

export type MergeFailureClass = 'conflict' | 'retryable' | 'blocked';

/**
 * Classify a GitHub merge rejection by its error message / context.
 *
 * - 'conflict': PR has merge conflicts — NOT retryable as-is, needs rebase/merge.
 * - 'retryable': transient failure (network, unknown) — safe to retry the merge.
 * - 'blocked': branch protection, failing CI, review required — structurally
 *              blocked; retrying the same merge won't help.
 */
export function classifyMergeFailure(message: string): MergeFailureClass {
  const lower = message.toLowerCase();
  if (
    lower.includes('merge conflict') ||
    lower.includes('has merge conflicts') ||
    lower.includes('mergeable_state: dirty') ||
    lower.includes('needs rebase') ||
    lower.includes('unresolvable conflicts')
  ) {
    return 'conflict';
  }
  if (
    lower.includes('method not allowed') ||
    lower.includes('405') ||
    lower.includes('branch protection') ||
    lower.includes('required status') ||
    lower.includes('review required') ||
    lower.includes('cannot be merged')
  ) {
    return 'blocked';
  }
  return 'retryable';
}

/**
 * Returns true when workspace config allows auto-dispatch for merge conflicts.
 * Absent = true (default ON).
 */
export function isAutoResolveMergeConflictsEnabled(
  gitConfig: WorkspaceGitConfig | null | undefined,
): boolean {
  return gitConfig?.autoResolveMergeConflicts !== false;
}

// ── Cross-repo detection ──────────────────────────────────────────────────

/**
 * Check if a PR belongs to a different repo than the workspace.
 * Useful for detecting cross-repo PRs that need repo override in task context.
 *
 * Returns the PR's repo URL if different from workspace repo, or null otherwise.
 */
async function detectCrossRepoPr(
  installationId: number | null,
  repoFullName: string,
  prNumber: number,
  workspaceRepoUrl: string | null | undefined,
): Promise<string | null> {
  if (!installationId || !repoFullName) {
    return null;
  }

  try {
    const prData = await githubApi(installationId, `/repos/${repoFullName}/pulls/${prNumber}`);

    if (!prData?.head?.repo?.full_name) {
      return null;
    }

    const prRepoFullName = prData.head.repo.full_name;

    // Normalize both URLs for comparison
    const normalizeRepo = (url: string | null | undefined): string | null => {
      if (!url) return null;
      const match = url.match(/github\.com[:/](.+?)(\.git)?$/i) ||
                    url.match(/^([^/]+\/[^/]+)$/);
      return match ? match[1].toLowerCase() : null;
    };

    const normalizedWorkspaceRepo = normalizeRepo(workspaceRepoUrl);
    const normalizedPrRepo = prRepoFullName.toLowerCase();

    // If the PR repo differs from workspace repo, return the PR repo URL
    if (normalizedWorkspaceRepo !== normalizedPrRepo) {
      return `https://github.com/${prRepoFullName}.git`;
    }

    return null;
  } catch (err) {
    console.warn(
      `[conflict-retry] Failed to detect PR repo for #${prNumber} in ${repoFullName}:`,
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
}

// ── Retry task builder ────────────────────────────────────────────────────────

export interface ConflictRetryInput {
  originalTask: {
    id: string;
    title: string;
    description: string | null;
    workspaceId: string;
    context: Record<string, unknown> | null;
    missionId?: string | null;
    pathManifest?: string[] | null;
  };
  worker: {
    id: string;
    branch: string;
    prNumber: number;
  };
  /** Current head SHA of the PR — used for dedup key. */
  headSha: string;
  /** Repo "owner/name" string — for GitHub URLs in the description. */
  repoFullName: string;
  /** Override max iterations (default 3). */
  maxConflictIterations?: number;
  /**
   * When set, this retry is a migration-number-collision renumber, not a
   * generic merge conflict — there is no real git conflict, so "merge the
   * base in and resolve" would be wrong guidance. The task gets the
   * schema-change renumber recipe instead, while reusing the same
   * dedup/cap/dispatch machinery as a conflict retry.
   */
  migrationCollision?: MigrationCollision;
  /**
   * The PR mixes safe EXPAND and CONTRACT migrations: the task splits it in
   * two (additive half stays, destructive half moves to a follow-up PR).
   */
  migrationSplit?: { reason: string };
  /**
   * The open PR's actual head/base refs. When `headRef` differs from the
   * worker's own branch (e.g. the PR is a mission integration PR the retry is
   * bound to), `create_pr` will 409 on a fresh PR from the worker branch, so
   * the migration-collision brief says up front to push to `headRef` instead.
   */
  prRefs?: { headRef: string; baseRef: string | null } | null;
  /**
   * When set, the base merges in cleanly but both sides verifiably edit the
   * same symbol (conflict-aware-orchestration.md §4): the task is a semantic
   * conflict review — merge the base, then reconcile the named symbols on the
   * merits — reusing the same dedup/cap/dispatch machinery.
   */
  semanticConflict?: SemanticAssessment;
  /** The conflict basis (`conflictBasisKey`) this attempt repairs, stamped on its context. */
  conflictBasis?: string | null;
}

/** The conflict an attempt repairs: the PR head and the base tip it conflicts with. */
export function conflictBasisKey(headSha: string, baseSha: string): string {
  return `${headSha}:${baseSha}`;
}

export interface ConflictRetryTask {
  title: string;
  description: string;
  workspaceId: string;
  parentTaskId: string;
  missionId: string | null;
  creationSource: 'conflict';
  conflictRetryPrNumber: number;
  conflictRetryHeadSha: string;
  context: Record<string, unknown>;
  /** pathManifest inherited from the original task, or ['**'] when the task belongs to a mission. */
  pathManifest: string[] | null;
}

/**
 * Build a conflict-resolution retry task descriptor (pure, no DB).
 *
 * Returns null when retries are exhausted or disabled (maxConflictIterations === 0).
 */
export function buildConflictRetryTask(params: ConflictRetryInput & { prRepoUrl?: string | null }): ConflictRetryTask | null {
  const { originalTask, worker, headSha, repoFullName, maxConflictIterations, prRepoUrl, migrationCollision, migrationSplit, semanticConflict, prRefs, conflictBasis } = params;
  const ctx = originalTask.context || {};

  const currentIteration = typeof ctx.conflictIteration === 'number' ? ctx.conflictIteration : 0;
  const maxIterations = maxConflictIterations ?? (
    typeof ctx.maxConflictIterations === 'number' ? ctx.maxConflictIterations : policyValue('maxConflictIterations')
  );

  if (maxIterations <= 0 || currentIteration >= maxIterations) {
    return null;
  }

  const nextIteration = currentIteration + 1;

  // Inherit pathManifest from original task; fall back to ['**'] for mission tasks
  // to record "scope undeclared". The sentinel is advisory only — it does NOT
  // create dependsOn edges (see the auto-dependsOn block in dispatchConflictRetry).
  const pathManifest: string[] | null =
    originalTask.pathManifest && originalTask.pathManifest.length > 0
      ? originalTask.pathManifest
      : originalTask.missionId
        ? ['**']
        : null;

  return {
    title: formatAttemptTitle('builder', originalTask.title, {
      reason: migrationSplit ? 'split migrations' : migrationCollision ? 'migration collision' : semanticConflict ? 'semantic overlap' : 'after conflict',
      iteration: nextIteration,
    }),
    description: migrationSplit
      ? buildMigrationSplitDescription(originalTask, worker, repoFullName, nextIteration, maxIterations, migrationSplit.reason)
      : migrationCollision
      ? buildMigrationCollisionDescription(originalTask, worker, repoFullName, nextIteration, maxIterations, migrationCollision, prRefs ?? null)
      : semanticConflict
        ? buildSemanticConflictDescription(originalTask, worker, repoFullName, nextIteration, maxIterations, semanticConflict, prRefs ?? null)
        : buildConflictDescription(originalTask, worker, repoFullName, nextIteration, maxIterations, prRefs ?? null),
    workspaceId: originalTask.workspaceId,
    parentTaskId: originalTask.id,
    missionId: originalTask.missionId ?? null,
    creationSource: 'conflict',
    conflictRetryPrNumber: worker.prNumber,
    conflictRetryHeadSha: headSha,
    pathManifest,
    context: {
      // Branch continuity — agent starts from the conflicted branch
      baseBranch: worker.branch,
      resumeBranch: worker.branch,
      // Structured failure context
      failureContext: migrationSplit
        ? {
            summary: `PR #${worker.prNumber} mixes additive (EXPAND) and destructive (CONTRACT) migrations. Split it: keep the additive half here, move the destructive half to a follow-up PR.`,
            errorType: 'migration_split' as const,
            prNumber: worker.prNumber,
            headSha,
          }
        : migrationCollision
        ? {
            summary: migrationCollision.otherPrNumber == null
              ? `PR #${worker.prNumber}'s migration ${migrationCollision.file} is at or below ${migrationCollision.otherFile}, already on its base. Merge the base in and renumber past it.`
              : `PR #${worker.prNumber}'s migration ${migrationCollision.file} collides with open PR #${migrationCollision.otherPrNumber}'s migration ${migrationCollision.otherFile}. Renumber off the colliding slot.`,
            errorType: 'migration_collision' as const,
            prNumber: worker.prNumber,
            headSha,
          }
        : semanticConflict
          ? {
              summary: `PR #${worker.prNumber} and its base both edit ${semanticSymbols(semanticConflict).join(', ')}. Merge the base in and reconcile those symbols on the merits.`,
              errorType: 'semantic_conflict' as const,
              prNumber: worker.prNumber,
              headSha,
            }
          : {
              summary: `PR #${worker.prNumber} has merge conflicts with the base branch. Merge the base branch in and resolve on the merits.`,
              errorType: 'merge_conflict' as const,
              prNumber: worker.prNumber,
              headSha,
            },
      ...(semanticConflict
        ? {
            semanticConflict: {
              baseRef: semanticConflict.baseRef ?? null,
              baseSha: semanticConflict.baseSha ?? null,
              mergeBaseSha: semanticConflict.mergeBaseSha ?? null,
              evidence: semanticConflict.evidence ?? [],
            },
          }
        : {}),
      conflictIteration: nextIteration,
      maxConflictIterations: maxIterations,
      ...(conflictBasis ? { conflictBasis } : {}),
      prNumber: worker.prNumber,
      ...lineageStamp(originalTask, [worker.prNumber]),
      // Cross-repo override: when the PR is in a different repo than the task's workspace,
      // pass the PR repo URL so the worker resolver can find the correct directory.
      // This enables conflict-retry on cross-repo PRs (e.g., a dispatch PR in a buildd workspace).
      ...(prRepoUrl ? { prRepoUrl } : {}),
      ...(ctx.skillSlugs ? { skillSlugs: ctx.skillSlugs } : {}),
      ...(ctx.verificationCommand ? { verificationCommand: ctx.verificationCommand } : {}),
    },
  };
}

/**
 * The PR's head when it is not this worker's own branch (the retry is bound to
 * an existing PR, typically a mission integration PR). `create_pr` refuses a
 * second PR for that lineage with a 409, so briefs must name the real head.
 */
function boundHeadRef(worker: ConflictRetryInput['worker'], prRefs: ConflictRetryInput['prRefs']): string | null {
  return prRefs?.headRef && prRefs.headRef !== worker.branch ? prRefs.headRef : null;
}

function boundLineageNote(
  worker: ConflictRetryInput['worker'],
  prRefs: ConflictRetryInput['prRefs'],
  fixWhat: string,
): string {
  const boundHead = boundHeadRef(worker, prRefs);
  if (!boundHead) return '';
  return `\n\n**Bound PR lineage:** PR #${worker.prNumber} is open from \`${boundHead}\`${prRefs?.baseRef ? ` into \`${prRefs.baseRef}\`` : ''}, not from \`${worker.branch}\`. Do NOT open a new PR with \`create_pr\` — it will 409 as duplicate lineage. ${fixWhat} on \`${boundHead}\` and push there (fast-forward; fetch first), then \`create_pr\` only to record the existing PR if asked.`;
}

function buildConflictDescription(
  task: ConflictRetryInput['originalTask'],
  worker: ConflictRetryInput['worker'],
  repoFullName: string,
  iteration: number,
  maxIterations: number,
  prRefs: ConflictRetryInput['prRefs'] = null,
): string {
  const prUrl = `https://github.com/${repoFullName}/pull/${worker.prNumber}`;
  const boundHead = boundHeadRef(worker, prRefs);
  const pushStep = boundHead
    ? `Push the resolved merge to \`${boundHead}\` (the PR's head branch — fast-forward, do not force); PR #${worker.prNumber} will auto-update.`
    : `Push your resolved branch — the existing PR (#${worker.prNumber}) will auto-update.`;

  return `PR #${worker.prNumber} for "${task.title}" has merge conflicts with the base branch.${boundLineageNote(worker, prRefs, 'Resolve the conflicts')}

**Attempt ${iteration} of ${maxIterations}.**

## Instructions

1. You are on branch \`${worker.branch}\`. Your worktree is based on the previous attempt's work.
2. Fetch and merge the base branch to incorporate upstream changes:
   \`\`\`bash
   git fetch origin
   git merge origin/dev   # or origin/main — use the PR's actual base branch
   \`\`\`
3. Resolve all conflicts on the merits — keep both intents, do NOT use blanket \`--ours\` or \`--theirs\`.
   A conflict in a Drizzle \`meta/_journal.json\` or snapshot is a migration-index collision, not text to merge: resolve the rest, then regenerate this branch's migration at the next free index — \`bun run migrations:renumber --base=origin/<the PR base branch>\` where the repo defines it, otherwise take the base's journal and snapshots, delete this branch's migration and re-run \`drizzle-kit generate\`.
4. Run the test suite and verify correctness before pushing.
5. ${pushStep}

PR: ${prUrl}

${task.description ? `## Original Task Description\n\n${task.description}` : ''}`;
}

function semanticSymbols(a: SemanticAssessment): string[] {
  return (a.evidence ?? []).flatMap((e) => e.symbols);
}

function buildSemanticConflictDescription(
  task: ConflictRetryInput['originalTask'],
  worker: ConflictRetryInput['worker'],
  repoFullName: string,
  iteration: number,
  maxIterations: number,
  assessment: SemanticAssessment,
  prRefs: ConflictRetryInput['prRefs'] = null,
): string {
  const boundHead = boundHeadRef(worker, prRefs);
  const pushStep = boundHead
    ? `Push to \`${boundHead}\` (the PR's head branch — fast-forward, do not force); PR #${worker.prNumber} updates, and CI plus normal review decide the merge on the new head.`
    : `Push — the existing PR (#${worker.prNumber}) updates, and CI plus normal review decide the merge on the new head.`;
  const prUrl = `https://github.com/${repoFullName}/pull/${worker.prNumber}`;
  const base = assessment.baseRef ?? "the PR's base branch";
  const evidence = (assessment.evidence ?? [])
    .map((e) => `- \`${e.path}\`: ${e.symbols.map((s) => `\`${s}\``).join(', ')}`)
    .join('\n');

  return `PR #${worker.prNumber} for "${task.title}" is behind \`${base}\`, and while the base would merge in without a textual conflict, both sides edit the same symbols since their common ancestor${assessment.mergeBaseSha ? ` (\`${assessment.mergeBaseSha.slice(0, 12)}\`)` : ''}:

${evidence}

A clean git merge does not mean the two changes agree. This is a semantic conflict review.${boundLineageNote(worker, prRefs, 'Reconcile the symbols')}

**Attempt ${iteration} of ${maxIterations}.**

## Instructions

1. You are on branch \`${worker.branch}\`. Your worktree is based on the previous attempt's work.
2. Merge the PR's actual base in (a merge commit — the branch is shared, so do not rewrite its history):
   \`\`\`bash
   git fetch origin
   git merge origin/${assessment.baseRef ?? '<the PR base branch>'}
   \`\`\`
3. Read each symbol above as it now stands and reconcile both intents on the merits. If they already agree, say so in your summary and change nothing else.
4. Run the tests that cover those symbols before pushing.
5. ${pushStep}

PR: ${prUrl}

${task.description ? `## Original Task Description\n\n${task.description}` : ''}`;
}

function buildMigrationSplitDescription(
  task: ConflictRetryInput['originalTask'],
  worker: ConflictRetryInput['worker'],
  repoFullName: string,
  iteration: number,
  maxIterations: number,
  reason: string,
): string {
  const prUrl = `https://github.com/${repoFullName}/pull/${worker.prNumber}`;
  return `PR #${worker.prNumber} (${prUrl}) for "${task.title}" mixes additive (EXPAND) and destructive (CONTRACT) migrations, so it cannot land as one PR. ${reason}

**Attempt ${iteration} of ${maxIterations}.**

## Instructions

1. You are on branch \`${worker.branch}\`. Keep ONLY the additive (EXPAND) migration and the code that needs it on this branch; regenerate the migration if removing the destructive statements leaves it inconsistent (\`cd packages/core && bun db:generate\`).
2. Move the destructive (CONTRACT) statements out of this PR. Do not delete the intent: note it in the PR description as a follow-up that lands once nothing reads the old column/table.
3. Do not weaken any check, and do not add the destructive SQL back under another name.
4. Push to the existing branch; the PR is re-reviewed at the new head.`;
}

function buildMigrationCollisionDescription(
  task: ConflictRetryInput['originalTask'],
  worker: ConflictRetryInput['worker'],
  repoFullName: string,
  iteration: number,
  maxIterations: number,
  collision: MigrationCollision,
  prRefs: ConflictRetryInput['prRefs'] = null,
): string {
  // The PR's head is not this worker's branch: the retry is bound to an
  // existing PR (typically a mission integration PR). create_pr rejects a new
  // PR from the worker branch as duplicate lineage, so name the real target.
  const boundHead = boundHeadRef(worker, prRefs);
  const lineageNote = boundLineageNote(worker, prRefs, 'Fix the migration');
  const pushStep = boundHead
    ? `Push to \`${boundHead}\` (the PR's head branch — fast-forward, do not force), then request re-review so the collision flag clears.`
    : `Push to the existing branch, then request re-review so the collision flag clears.`;
  const prUrl = `https://github.com/${repoFullName}/pull/${worker.prNumber}`;
  // A slot already taken on the base itself (the base merged a migration with
  // this number after the branch forked) has no other PR to look at.
  const onBase = collision.against === 'base' || collision.otherPrNumber == null;
  const otherPrUrl = onBase ? null : `https://github.com/${repoFullName}/pull/${collision.otherPrNumber}`;
  const opening = onBase
    ? `PR #${worker.prNumber} for "${task.title}" adds \`${collision.file}\`, but its base already has \`${collision.otherFile}\` at or above that number — the base merged a migration after this branch forked. This is a mechanical renumber, not a decision.`
    : `PR #${worker.prNumber} for "${task.title}" has a migration-number collision with open PR #${collision.otherPrNumber} (${otherPrUrl}) — both minted the same slot: \`${collision.file}\` here vs \`${collision.otherFile}\` there. This is a mechanical fix, not a real merge conflict — do not just "merge the base in", the migration index namespace is invisible to git.`;
  const baseRef = prRefs?.baseRef ?? 'dev';
  // Regenerating against the base alone would mint an open PR's slot again,
  // so start past it until that PR lands.
  const otherIndex = Number(/^(\d{4,})_/.exec(collision.otherFile)?.[1]);
  const minIndex = !onBase && Number.isFinite(otherIndex) ? ` --min-index=${otherIndex + 1}` : '';

  return `${opening}${lineageNote}

**Attempt ${iteration} of ${maxIterations}.**

## Instructions

\`migrations:renumber\` does the whole renumber: it resets \`packages/core/drizzle/\` to the base's exact state and re-runs \`drizzle-kit generate\`, so this branch's schema change lands at the next free index with a fresh name, journal entry and snapshot. Do NOT hand-edit the journal, a snapshot or a migration's number.

1. You are on branch \`${worker.branch}\`. Your worktree is based on the previous attempt's work.
2. Merge the base branch in (do NOT rebase). Resolve any conflicts OUTSIDE \`packages/core/drizzle/\` on the merits; leave the drizzle ones, the next step resolves them:
   \`\`\`bash
   git fetch origin
   git merge origin/${baseRef}
   \`\`\`
3. Renumber:
   \`\`\`bash
   bun run migrations:renumber --base=origin/${baseRef}${minIndex}
   \`\`\`
   (No \`migrations:renumber\` script in this repo? Do it by hand the same way: \`git checkout origin/${baseRef} -- packages/core/drizzle\`, delete this branch's \`${collision.file}\`, then \`cd packages/core && bun db:generate\`.)
   Exit 0: staged and clean. Exit 3: the regenerated SQL differs from the SQL it replaced — read both; re-add any hand-written statement the old file had (via \`bun db:generate --custom\`, never by editing an existing file). Any other exit: read the message, it names what to fix.
4. Verify: \`bun run migrations:index-check --base=origin/${baseRef}\` passes and \`cd packages/core && bun db:generate\` reports no schema changes.
5. Commit (completing the merge) — change nothing else; this is a migration-file-only fix, same doctrine as any conflict-retry.
6. ${pushStep}

PR: ${prUrl}
${otherPrUrl ? `Colliding PR: ${otherPrUrl}` : `Colliding migration on the base: \`${collision.otherFile}\``}

${task.description ? `## Original Task Description\n\n${task.description}` : ''}`;
}

// ── DB dispatch ───────────────────────────────────────────────────────────────

/**
 * Free the (workspace, PR, head) dedupe key held by a conflict retry that has
 * already ended on this exact head. A retry that finished without pushing
 * leaves the head unchanged, so its row keeps owning the key forever. Every
 * later dispatch for that still-conflicting head then hits the unique index
 * and files nothing, while each caller reads that as "already handled". Only
 * a terminal row gives up its key, so a live retry still dedupes. The row
 * keeps `conflictRetryPrNumber` and `subjectHeadSha`, so attempt counts and
 * history are unchanged. Returns the released task id, or null.
 */
export async function releaseSpentConflictRetryKey(
  workspaceId: string,
  prNumber: number,
  headSha: string,
): Promise<string | null> {
  const [row] = await db
    .update(tasks)
    .set({ conflictRetryHeadSha: null })
    .where(and(
      eq(tasks.workspaceId, workspaceId),
      eq(tasks.conflictRetryPrNumber, prNumber),
      eq(tasks.conflictRetryHeadSha, headSha),
      inArray(tasks.status, [...TERMINAL_TASK_STATUSES]),
    ))
    .returning({ id: tasks.id });
  return row?.id ?? null;
}

export interface DispatchConflictRetryParams {
  /** ID of the worker whose PR has conflicts. */
  workerId: string;
  /** ID of the original task (from worker.taskId). */
  taskId: string;
  /** PR number (from worker.prNumber). */
  prNumber: number;
  /** Current head SHA of the PR — from GitHub API or worker.lastCommitSha. */
  headSha: string;
  /** Repo full name "owner/name" for description URLs. */
  repoFullName: string;
  /** Workspace ID. */
  workspaceId: string;
  /** PR's repo URL when it differs from workspace repo (cross-repo case). */
  prRepoUrl?: string | null;
  /**
   * The refusal was "behind base", not a conflict (see `isBehindBaseRefusal`).
   * Try GitHub's update-branch first; an agent is only dispatched if it fails.
   */
  behindOnly?: boolean;
  /**
   * This is a migration-number-collision renumber, not a real merge
   * conflict — see `ConflictRetryInput.migrationCollision`. Mutually
   * exclusive with `behindOnly` in practice (a caller with a collision never
   * also has a behind-base refusal for the same dispatch).
   */
  migrationCollision?: MigrationCollision;
  /**
   * A person chose this fix (the landing-alert tap). Like `apply-recommendation`
   * and `retry-ci`, a deliberate human action is not declined for a disabled
   * workspace flag or an exhausted automatic budget: it gets a fresh budget on
   * top of the attempts already spent.
   */
  humanInitiated?: boolean;
  /**
   * The base branch tip the conflict is against, when the caller read it. Keys
   * the attempt to its conflict basis (head + base) so a spent budget from an
   * earlier conflict does not strand this one. Omitted, the cap is absolute.
   */
  baseSha?: string | null;
}

export interface DispatchConflictRetryResult {
  dispatched: boolean;
  taskId?: string;
  /** True when iteration cap was reached — caller should escalate to human. */
  exhausted?: boolean;
  /** True when the feature is disabled on this workspace. */
  disabled?: boolean;
  /** True when the supersession precheck determined the change is already upstream. */
  superseded?: boolean;
  /** A conflict retry is already live on this PR; nothing new was filed. */
  inFlightTaskId?: string;
  /** The live conflict retry had stalled (S37). */
  remediationStalled?: boolean;
  /** What recovery did to it: re-dispatched, repaired (requeued), or nothing (throttled / worker silent). */
  remediationRecovery?: ConflictRecoveryAction;
  /** The PR that appears to have already landed the change, if identifiable. */
  successorPrNumber?: number | null;
  /** True when the base branch was force-pushed after the PR was opened. */
  baseRewritten?: boolean;
  /**
   * True when a behind-only PR was brought up to date by GitHub's
   * update-branch API. `dispatched` is also true (the PR is being handled),
   * but there is no task: the push re-runs CI and the merge retries on green.
   */
  branchUpdated?: boolean;
  /** The PR belongs to a dependency bot — nothing was pushed or filed. */
  dependencyBot?: boolean;
  /**
   * Behind-only refresh outcomes that are NOT conflicts (base-refresh.ts). None
   * spawns an agent. Deliberately distinct from `exhausted`, which callers
   * escalate as an exhausted conflict-fix budget.
   */
  /** The PR head moved since it was evaluated — re-read on the new head's event. */
  headChanged?: boolean;
  /** Another refresh holds this PR's single-flight lease. */
  refreshInFlight?: boolean;
  /** update-branch failed operationally; a later event or sweep retries (bounded). */
  refreshDeferred?: boolean;
  /**
   * The kernel's mechanical refresh is queued or running (it may already have
   * pushed): not a failure. Landing re-reads on the new head's event.
   */
  refreshQueued?: boolean;
  /** Operational failures hit their bound (or the kernel escalated the refresh); a diagnostic was posted. */
  refreshExhausted?: boolean;
  /** Set when the kernel's treadmill bound escalated: how many refreshes the base outran. */
  refreshTreadmill?: number;
  /**
   * S15, with `refreshExhausted`: the kernel read the base delta and the base keeps
   * changing what this PR changes (shared files, risky paths), not merely moving.
   */
  refreshUnsafe?: boolean;
  /**
   * S15 disjoint-delta rule: the PR is behind, but its approved head's base delta is
   * small, disjoint and risk-free, so the kernel neither refreshed nor escalated it.
   * The door lands it (T15 checks the rule again at merge time).
   */
  behindTolerated?: boolean;
  /** Legacy path: the classified update-branch failure. The kernel path has none. */
  refreshFailure?: BranchUpdateFailure | null;
  /** Why, in words: the raw GitHub error (legacy) or the kernel's escalation detail. */
  refreshReason?: string | null;
  /** Semantic clearance unknown; a later event or sweep rechecks (bounded). */
  semanticDeferred?: boolean;
  /** Semantic clearance could not be verified within the bound; a diagnostic was posted. */
  semanticUnverified?: boolean;
  /** GitHub said there is nothing to merge in: the "behind" reading was stale. Re-read. */
  alreadyUpToDate?: boolean;
  /**
   * The workflow kernel owns this PR (spec §6.7, T12): the legacy decision did
   * not run. `state` is the delivery's state after the kernel acted.
   */
  kernel?: { result: string; reason: string | null; state: string | null; attempt: ConflictSeen['attempt'] };
  /**
   * The PR was flagged as conflicting, but a merge against the current base
   * tip was clean: the flag was stale. No agent was filed; `branchUpdated` or
   * `alreadyUpToDate` says what was done instead.
   */
  conflictFalsePositive?: boolean;
}

/**
 * What a kernel T12 answer means to the conflict doors, in the shape they
 * already understand (exported for tests). The kernel did the work: a
 * mechanical refresh that landed reads as `branchUpdated`, an agent attempt
 * as `dispatched` with its task, a spent budget as `exhausted` (the kernel's
 * own effect escalated; the doors' escalation is idempotent per head).
 */
export function kernelConflictOutcome(seen: ConflictSeen): DispatchConflictRetryResult {
  const r = seen.result;
  const a = seen.attempt;
  const state = seen.after?.state ?? ('current' in r ? r.current?.state ?? null : null);
  const kernel = { result: r.result, reason: 'reason' in r ? (r.reason ?? null) : null, state, attempt: a };
  if (r.result === 'applied') {
    const to = r.decision.toState;
    if (to === 'ESCALATED') {
      const reason = r.decision.patch.stateReason;
      if (reason !== 'landing_needs_human') return { dispatched: false, exhausted: true, kernel };
      const notify = (r.decision.effects ?? []).find((e) => e.kind === 'notify');
      const detail = typeof notify?.payload?.detail === 'string' ? notify.payload.detail : null;
      const refreshes = r.decision.evidence?.refreshes;
      return {
        dispatched: false, refreshExhausted: true, kernel,
        refreshReason: detail ?? 'the kernel escalated the refresh to a person (landing_needs_human)',
        ...(typeof refreshes === 'number' ? { refreshTreadmill: refreshes } : {}),
        ...(r.decision.evidence?.cause === 'refresh_unsafe' ? { refreshUnsafe: true } : {}),
      };
    }
    if (a?.mode === 'agent') return { dispatched: true, ...(a.taskId ? { taskId: a.taskId } : {}), kernel };
    if (a?.mode === 'mechanical') {
      if (a.outcome === 'delivered') return { dispatched: true, branchUpdated: true, kernel };
      if (a.status === 'skipped') return { dispatched: false, alreadyUpToDate: true, kernel };
      if (a.status === 'queued') return { dispatched: false, refreshQueued: true, kernel };
      // The mechanical row ended failed: what followed (an agent, an escalation) is in `state`.
      if (state === 'ESCALATED') {
        return {
          dispatched: false, refreshExhausted: true, kernel,
          refreshReason: `the kernel's mechanical refresh ended failed and the delivery escalated (${seen.after?.stateReason ?? 'no reason recorded'})`,
        };
      }
    }
    // The inline drain moved the delivery on (an agent attempt now bound, or a fresh round).
    return { dispatched: state === 'REPAIRING', kernel };
  }
  if (r.reason === 'not_conflicting') return { dispatched: false, alreadyUpToDate: true, kernel };
  if (r.reason === 'behind_tolerated') return { dispatched: false, behindTolerated: true, kernel };
  if (r.reason === 'dependency_bot_pr') return { dispatched: false, dependencyBot: true, kernel };
  if (r.reason === 'head_not_current') return { dispatched: false, headChanged: true, kernel };
  if (r.reason === 'fix_in_flight') {
    return a?.mode === 'agent'
      ? { dispatched: false, ...(a.taskId ? { inFlightTaskId: a.taskId } : {}), kernel }
      : { dispatched: false, refreshInFlight: true, kernel };
  }
  return { dispatched: false, kernel };
}

/** The kernel door: T12 for a kernel-owned PR, null when legacy owns it. */
async function kernelConflictRetry(
  params: DispatchConflictRetryParams,
  workspace: { id: string; gitConfig: unknown; githubInstallation?: { installationId: number } | null },
): Promise<DispatchConflictRetryResult | null> {
  const installationId = workspace.githubInstallation?.installationId;
  if (!installationId) return null;
  if (!(await kernelDeliveryForPr(params.workspaceId, params.repoFullName, params.prNumber))) return null;
  // A conflict retry filed by the legacy path (before cutover) is legacy's to
  // finish or recover: one authority per remediation (S37).
  const legacyLive = await db.query.tasks.findFirst({
    where: and(
      eq(tasks.workspaceId, params.workspaceId),
      eq(tasks.conflictRetryPrNumber, params.prNumber),
      inArray(tasks.status, [...OPEN_TASK_STATUSES]),
      sql`${tasks.deliveryId} IS NULL`,
    ),
    columns: { id: true, deliveryId: true },
  });
  if (legacyLive) return null;
  const owner = await db.query.tasks.findFirst({ where: eq(tasks.id, params.taskId), columns: { context: true } });
  const disabled = !params.humanInitiated && !isAutoResolveMergeConflictsEnabled(workspace.gitConfig as WorkspaceGitConfig | null);
  const seen = await observeConflict({
    workspaceId: params.workspaceId,
    repoFullName: params.repoFullName,
    prNumber: params.prNumber,
    installationId,
    hint: params.behindOnly ? 'behind' : 'dirty',
    migrationCollision: params.migrationCollision ? { ...params.migrationCollision } : null,
    isDependencyBot: isDependencyBotPrContext(owner?.context),
    // Disabled stops agents, not the platform's own mechanical refresh.
    maxAgentAttempts: disabled ? 0 : policyValue('maxConflictIterations'),
    humanInitiated: params.humanInitiated,
    source: params.humanInitiated ? 'human:conflict' : 'door:conflict',
    maxBaseCommits: policyValue('treadmillMaxBaseCommits'),
  });
  if (!seen.handled) return null;
  const out = kernelConflictOutcome(seen);
  if (out.inFlightTaskId) {
    // S37: the kernel's live conflict fix is the canonical remediation. A stalled
    // one is re-woken or requeued in place (a task-row repair, not a decision).
    const row = await db.query.tasks.findFirst({
      where: eq(tasks.id, out.inFlightTaskId),
      columns: { id: true, status: true, createdAt: true, claimedAt: true, updatedAt: true, context: true },
    });
    if (row && (OPEN_TASK_STATUSES as readonly string[]).includes(row.status)) {
      const recovery = await recoverStalledConflictFix(row);
      if (recovery.stalled) return { ...out, remediationStalled: true, remediationRecovery: recovery.action };
    }
  }
  return out;
}

/** Reconcile inferred inverse waits on the canonical queued repair before waking it. */
async function reconcilePendingRepairEdges(
  row: Pick<typeof tasks.$inferSelect, 'id' | 'status' | 'taskClass' | 'conflictRetryPrNumber' | 'dependsOn' | 'pathDeclaration'>,
  workspaceId: string,
  subjectTaskId: string,
) {
  if (row.status !== 'pending' || row.taskClass !== 'attempt' || row.conflictRetryPrNumber == null) return;
  const deps = row.dependsOn ?? [];
  if (!deps.length) return;
  const decl = row.pathDeclaration;
  // Tagged rows preserve every caller edge. The legacy conflict dispatcher
  // copied no caller edges, so untagged pre-v2 attempts have only inferred ones.
  const inferred = new Set(decl?.inferredDependsOn ?? (decl?.overlapPolicy == null ? deps : []));
  if (!inferred.size) return;
  const subject = await db.query.tasks.findFirst({ where: eq(tasks.id, subjectTaskId), columns: { pathManifest: true } });
  if (!subject) return;
  const candidates = await db.query.tasks.findMany({
    where: and(eq(tasks.workspaceId, workspaceId), inArray(tasks.status, [...OPEN_TASK_STATUSES])),
    columns: { id: true, status: true, pathManifest: true, dependsOn: true },
  });
  const graph = new Map(candidates.map(t => [t.id, t.dependsOn]));
  const remove = new Set(candidates.filter(t => inferred.has(t.id) && (
    isDownstreamOf(t.id, subjectTaskId, graph) || (t.status === 'pending' &&
      findBlockingPr(t.pathManifest ?? [], [{ pathManifest: subject.pathManifest, prNumber: row.conflictRetryPrNumber }]))
  )).map(t => t.id));
  if (!remove.size) return;
  await db.update(tasks).set({
    dependsOn: deps.filter(id => !remove.has(id)),
    ...(decl ? { pathDeclaration: { ...decl,
      ...(decl.inferredDependsOn ? { inferredDependsOn: decl.inferredDependsOn.filter(id => !remove.has(id)) } : {}),
      ...(decl.softOverlaps ? { softOverlaps: decl.softOverlaps.filter(e => !remove.has(e.taskId)) } : {}),
    } } : {}),
  }).where(and(eq(tasks.id, row.id), eq(tasks.status, 'pending'),
    // A concurrent claim, declaration or dependency edit wins over this read.
    sql`${tasks.dependsOn} = ${JSON.stringify(deps)}::jsonb`,
    sql`${tasks.pathDeclaration} IS NOT DISTINCT FROM ${decl ? JSON.stringify(decl) : null}::jsonb`,
  ));
}

// ── S37: an existing conflict fix is recovered, not duplicated ──────────────

export {
  STALE_PENDING_CONFLICT_FIX_MS, SILENT_CONFLICT_FIX_MS, CONFLICT_RECOVERY_THROTTLE_MS, classifyConflictFix,
  type ConflictRecoveryAction, type ConflictFixLiveness,
} from '@/lib/conflict-fix-liveness';

/**
 * Recover a stalled live conflict fix in place. Compare-and-set on the row's
 * `updatedAt`, recording `context.conflictRecovery`, so concurrent callers
 * (a sweep, a webhook, a human click) apply at most one recovery per window
 * and never file a second task.
 */
export async function recoverStalledConflictFix(row: {
  id: string; status: string; createdAt?: Date | string | null; claimedAt?: Date | string | null; updatedAt?: Date | string | null; context?: unknown;
}, now: number = Date.now()): Promise<{ stalled: boolean; action: ConflictRecoveryAction }> {
  const ctx = (row.context ?? {}) as Record<string, unknown>;
  const last = (ctx.conflictRecovery as { at?: string } | undefined)?.at ?? null;
  let workerStatus: string | null = null;
  let workerUpdatedAt: Date | null = null;
  if (row.status !== 'pending') {
    const w = await db.query.workers.findFirst({
      where: eq(workers.taskId, row.id),
      columns: { status: true, updatedAt: true },
      orderBy: (wk, { desc }) => [desc(wk.createdAt)],
    }).catch(() => null);
    workerStatus = (w?.status as string | undefined) ?? null;
    workerUpdatedAt = (w?.updatedAt as Date | undefined) ?? null;
  }
  const verdict = classifyConflictFix({ status: row.status, createdAt: row.createdAt ?? null, claimedAt: row.claimedAt, workerStatus, workerUpdatedAt, lastRecoveryAt: last }, now);
  if (!verdict.stalled || verdict.action === 'none') return { stalled: verdict.stalled, action: 'none' };
  const nextCtx = { ...ctx, conflictRecovery: { at: new Date(now).toISOString(), action: verdict.action, reason: verdict.reason } };
  const set: Record<string, unknown> = { context: nextCtx, updatedAt: new Date(now) };
  if (verdict.action === 'repair') { set.status = 'pending'; set.claimedAt = null; }
  const won = await db.update(tasks).set(set as never)
    // CAS on the recovery marker itself (not updated_at: Postgres keeps
    // microseconds a JS Date drops), so exactly one concurrent caller wins.
    .where(and(eq(tasks.id, row.id), eq(tasks.status, row.status as never),
      sql`coalesce(${tasks.context}->'conflictRecovery'->>'at', '') = ${last ?? ''}`))
    .returning({ id: tasks.id });
  if (!won || won.length === 0) return { stalled: true, action: 'none' };
  await wakeTask(row.id, 'conflict.retry');
  return { stalled: true, action: verdict.action };
}

/**
 * Fetch task + workspace, then build, insert, and dispatch a conflict-resolution retry.
 *
 * Deduped by (workspaceId, prNumber, headSha) via the conflictRetryEventIdx
 * unique index — safe to call concurrently; second caller gets dispatched=false.
 */
export async function dispatchConflictRetry(
  params: DispatchConflictRetryParams,
): Promise<DispatchConflictRetryResult> {
  const { workerId, taskId, prNumber, headSha, repoFullName, workspaceId, migrationCollision } = params;

  // Fetch workspace (needed for autoResolveMergeConflicts flag + announceTaskCreated)
  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId),
    with: { githubInstallation: true },
  });
  if (!workspace) {
    console.warn(`[conflict-retry] workspace ${workspaceId} not found — skipping dispatch`);
    return { dispatched: false };
  }

  // The workflow kernel owns the conflict family for its PRs (spec §6.7): the
  // legacy decision below (counter, key release, stalled-fix recovery, the
  // behind-only refresh) runs only for PRs it does not own.
  const kernel = await kernelConflictRetry(params, workspace as never);
  if (kernel) return kernel;

  if (!params.humanInitiated && !isAutoResolveMergeConflictsEnabled(workspace.gitConfig)) {
    return { dispatched: false, disabled: true };
  }

  // One live fix attempt per PR, whatever the head. The unique index keys on
  // (PR, head SHA), but the retry itself pushes to the PR — a new head, so a
  // new key — and a merge attempt against that head used to file a second
  // retry onto the branch the first was still working. A live CI or review
  // fix pushes to the same branch, so it counts too (its agent merges the base
  // as part of its own push). Checked before the behind-only update too:
  // moving the branch under a working agent races its push.
  const liveRetry = await db.query.tasks.findFirst({
    where: and(
      eq(tasks.workspaceId, workspaceId),
      or(
        eq(tasks.conflictRetryPrNumber, prNumber),
        eq(tasks.ciRetryPrNumber, prNumber),
        eq(tasks.reviewerRetryPrNumber, prNumber),
      ),
      inArray(tasks.status, ['pending', 'assigned', 'in_progress']),
    ),
    columns: { id: true, conflictRetryHeadSha: true, status: true, conflictRetryPrNumber: true, createdAt: true, claimedAt: true, updatedAt: true, context: true, taskClass: true, dependsOn: true, pathDeclaration: true },
  });
  if (liveRetry) {
    // S37: an existing remediation is the canonical one. A stalled one is
    // re-dispatched or repaired, never shadowed by a second fix task.
    await reconcilePendingRepairEdges(liveRetry, workspaceId, taskId);
    const recovery = await recoverStalledConflictFix(liveRetry);
    console.log(
      `[conflict-retry] PR #${prNumber} already has live fix attempt ${liveRetry.id} — not filing another` +
        (recovery.action !== 'none' ? ` (stalled: ${recovery.action})` : ''),
    );
    // A conflict repair that is still waiting to start is woken, not doubled:
    // a lost wake must not leave the one repair sitting in the queue. (A
    // stalled one was already woken by its recovery above.)
    if (recovery.action === 'none' && liveRetry.status === 'pending' && liveRetry.conflictRetryPrNumber === prNumber) {
      await wakeTask(liveRetry.id, 'conflict.retry');
    }
    return {
      dispatched: false,
      inFlightTaskId: liveRetry.id,
      ...(recovery.stalled ? { remediationStalled: true, remediationRecovery: recovery.action } : {}),
    };
  }

  // Fetch the original task — before the behind-only update, whose target
  // branch it may rule out (below).
  const task = await db.query.tasks.findFirst({
    where: eq(tasks.id, taskId),
    columns: { id: true, title: true, description: true, workspaceId: true, context: true, missionId: true, parentTaskId: true, pathManifest: true },
  });
  if (!task) {
    console.warn(`[conflict-retry] task ${taskId} not found — skipping dispatch`);
    return { dispatched: false };
  }

  // A dependency-bot PR's branch belongs to the bot: both the update-branch
  // below and a conflict agent would commit to it, and Renovate/Dependabot
  // stop rebasing a branch someone else has touched. Their own rebase is the
  // fix for "behind" and "conflicting" alike.
  if (isDependencyBotPrContext(task.context)) {
    const reason = dependencyBotPushRefusal(prNumber);
    console.log(`[conflict-retry] ${reason}`);
    fireGateEvent({
      gate: GATE_SLUGS.DEPENDENCY_BOT_PR,
      surface: 'conflict-retry',
      outcome: 'rejected',
      reason,
      workspaceId,
      taskId,
      workerId,
      callerOrigin: 'system',
      detail: { prNumber, headSha, behindOnly: params.behindOnly ?? false, stage: 'conflict_retry' },
    });
    return { dispatched: false, dependencyBot: true };
  }

  // Behind but not conflicting: GitHub can merge the base in server-side —
  // no agent needed. The new head must earn its own CI; a PR approved before
  // this push keeps its approval only when the diff is unchanged
  // (approval-carry-forward.ts). Only a verified textual conflict, or (opted
  // in) a verified same-symbol edit, falls through to an agent; operational
  // failures, a moved head and unknown symbol coverage never do.
  const behindInstallationId = workspace.githubInstallation?.installationId ?? null;
  const refreshParams = behindInstallationId
    ? {
        installationId: behindInstallationId,
        repoFullName,
        prNumber,
        headSha,
        workspaceId,
        taskId,
        workerId,
        missionId: task.missionId ?? null,
        gitConfig: workspace.gitConfig as WorkspaceGitConfig | null,
      }
    : null;
  let semanticConflict: SemanticAssessment | undefined;

  // Claimed conflict: `mergeable: dirty` is a hint, never the verdict. GitHub
  // computes it lazily, so right after the base moves it is often stale, and
  // most PRs it flags merge cleanly. Before an agent is filed, the same
  // update-branch merge is attempted against the CURRENT base tip — GitHub's
  // own server-side merge is the merge-tree check. Clean: the branch is
  // updated mechanically and no agent runs. Only a definitive clean answer
  // skips the agent; a real conflict, a moved head, an operational failure or
  // any error falls through to today's dispatch, never a silent drop. A
  // migration-number collision is invisible to git, so it is not re-checked.
  if (refreshParams && !params.behindOnly && !migrationCollision) {
    const recheck: RefreshOutcome | null = await refreshBehindPr(refreshParams).catch((err) => {
      console.warn(`[conflict-retry] conflict recheck failed for PR #${prNumber} — dispatching as before:`, err);
      return null;
    });
    if (recheck?.kind === 'updated' || recheck?.kind === 'up_to_date') {
      console.log(`[conflict-retry] PR #${prNumber} flagged as conflicting but merges cleanly with its base (${recheck.kind}) — no agent dispatched`);
      fireGateEvent({
        gate: GATE_SLUGS.BASE_REFRESH,
        surface: 'conflict-retry',
        outcome: 'warned',
        reason: 'conflict_false_positive',
        workspaceId,
        missionId: task.missionId ?? null,
        taskId,
        workerId,
        callerOrigin: 'system',
        detail: { prNumber, headSha, repoFullName, recheck: recheck.kind, stage: 'conflict_recheck' },
      });
      return recheck.kind === 'updated'
        ? { dispatched: true, branchUpdated: true, conflictFalsePositive: true }
        : { dispatched: false, alreadyUpToDate: true, conflictFalsePositive: true };
    }
    if (recheck?.kind === 'semantic_conflict') semanticConflict = recheck.assessment;
    else if (recheck?.kind !== 'conflict') {
      console.warn(`[conflict-retry] conflict recheck for PR #${prNumber} was inconclusive (${recheck?.kind ?? 'no answer'}) — dispatching as before`);
    }
  }

  if (params.behindOnly && refreshParams) {
    const refresh = await refreshBehindPr(refreshParams);
    switch (refresh.kind) {
      case 'updated':
        console.log(`[conflict-retry] PR #${prNumber} was behind its base — updated via GitHub, no agent dispatched`);
        return { dispatched: true, branchUpdated: true };
      case 'conflict':
        console.warn(`[conflict-retry] update-branch hit a merge conflict on PR #${prNumber}, dispatching an agent: ${refresh.reason}`);
        break;
      case 'semantic_conflict':
        console.warn(`[conflict-retry] PR #${prNumber} and its base edit the same symbols, dispatching a semantic review: ${refresh.assessment.reason}`);
        semanticConflict = refresh.assessment;
        break;
      case 'head_changed':
        return { dispatched: false, headChanged: true };
      case 'up_to_date':
        return { dispatched: false, alreadyUpToDate: true };
      case 'in_flight':
        return { dispatched: false, refreshInFlight: true };
      case 'deferred':
        console.warn(`[conflict-retry] update-branch ${refresh.failure} on PR #${prNumber} (attempt ${refresh.attempts}) — deferred, no agent: ${refresh.reason}`);
        return { dispatched: false, refreshDeferred: true, refreshFailure: refresh.failure, refreshReason: refresh.reason };
      case 'exhausted':
        return { dispatched: false, refreshExhausted: true, refreshFailure: refresh.failure, refreshReason: refresh.reason };
      case 'semantic_deferred':
        return { dispatched: false, semanticDeferred: true };
      case 'semantic_unverified':
        return { dispatched: false, semanticUnverified: true };
    }
  }

  // Fetch the worker for branch info and recorded diff stats
  const worker = await db.query.workers.findFirst({
    where: eq(workers.id, workerId),
    columns: { id: true, branch: true, prNumber: true, filesChanged: true, linesAdded: true, linesRemoved: true, prOpenedBaseSha: true },
  });
  if (!worker || !worker.branch) {
    console.warn(`[conflict-retry] worker ${workerId} not found or has no branch — skipping dispatch`);
    return { dispatched: false };
  }

  // ── Supersession precheck ─────────────────────────────────────────────────
  // Run before building the retry task. If the PR's changes are already upstream,
  // halt the chain and escalate rather than burning an attempt.
  const installationId = workspace.githubInstallation?.installationId ?? null;
  if (installationId) {
    const precheck = await runSupersessionPrecheck({
      installationId,
      repoFullName,
      prNumber,
      recordedStats: {
        filesChanged: worker.filesChanged ?? 0,
        linesAdded: worker.linesAdded ?? 0,
        linesRemoved: worker.linesRemoved ?? 0,
      },
      driftRatioThreshold:
        (workspace.gitConfig as WorkspaceGitConfig | null)?.supersessionDriftRatioThreshold
        ?? DEFAULT_SUPERSESSION_DRIFT_RATIO,
      workspaceId,
      taskId,
      prOpenedBaseSha: worker.prOpenedBaseSha ?? null,
    }).catch(err => {
      console.warn(`[conflict-retry] supersession precheck failed for PR #${prNumber} (non-fatal):`, err);
      return null;
    });

    if (precheck?.superseded) {
      console.log(
        `[conflict-retry] supersession detected for PR #${prNumber} (signals: ${precheck.signals.join(', ')},` +
        ` driftLines: ${precheck.driftRatioLines?.toFixed(1)}x,` +
        ` successor: ${precheck.successorPrNumber ?? 'unknown'}) — halting retry chain`,
      );
      await escalateSupersession(
        taskId,
        repoFullName,
        prNumber,
        precheck.successorPrNumber ?? null,
      ).catch(err =>
        console.error(`[conflict-retry] escalateSupersession failed for PR #${prNumber}:`, err),
      );
      return {
        dispatched: false,
        superseded: true,
        successorPrNumber: precheck.successorPrNumber,
      };
    }

    if (precheck?.baseRewritten && worker.prOpenedBaseSha) {
      console.log(
        `[conflict-retry] base history rewrite detected for PR #${prNumber}` +
        ` (old SHA: ${worker.prOpenedBaseSha.slice(0, 12)},` +
        ` new tip: ${precheck.currentBaseSha?.slice(0, 12) ?? 'unknown'}) — halting retry chain`,
      );
      await escalateBaseRewrite(
        taskId,
        repoFullName,
        prNumber,
        worker.prOpenedBaseSha,
        precheck.currentBaseSha,
      ).catch(err =>
        console.error(`[conflict-retry] escalateBaseRewrite failed for PR #${prNumber}:`, err),
      );
      return {
        dispatched: false,
        baseRewritten: true,
      };
    }
  }

  // Detect cross-repo PRs: when the PR's repo differs from the workspace repo,
  // pass the PR repo URL so the worker can resolve to the correct directory.
  let prRepoUrl: string | null = null;
  if (installationId) {
    prRepoUrl = await detectCrossRepoPr(
      installationId,
      repoFullName,
      prNumber,
      workspace.repo,
    ).catch(err => {
      console.warn(`[conflict-retry] cross-repo detection failed (non-fatal):`, err);
      return null;
    });
  }

  let prRefs: ConflictRetryInput['prRefs'] = null;
  if (migrationCollision && installationId) {
    prRefs = await githubApi(installationId, `/repos/${repoFullName}/pulls/${prNumber}`)
      .then(pr => (pr?.head?.ref ? { headRef: String(pr.head.ref), baseRef: pr.base?.ref ? String(pr.base.ref) : null } : null))
      .catch(() => null);
  }

  const basis = params.baseSha ? conflictBasisKey(headSha, params.baseSha) : null;
  const buildRetry = (maxConflictIterations?: number) => buildConflictRetryTask({
    originalTask: {
      id: task.id,
      title: task.title,
      description: task.description,
      workspaceId: task.workspaceId,
      context: (task.context as Record<string, unknown>) || null,
      missionId: task.missionId,
      pathManifest: task.pathManifest as string[] | null,
    },
    worker: { id: worker.id, branch: worker.branch, prNumber },
    headSha,
    repoFullName,
    prRepoUrl,
    migrationCollision,
    prRefs,
    semanticConflict,
    conflictBasis: basis,
    ...(maxConflictIterations !== undefined ? { maxConflictIterations } : {}),
  });
  const spentIterations =
    typeof (task.context as Record<string, unknown> | null)?.conflictIteration === 'number'
      ? ((task.context as Record<string, unknown>).conflictIteration as number)
      : 0;

  let retryTask = buildRetry(params.humanInitiated ? spentIterations + policyValue('maxConflictIterations') : undefined);

  // The cap counts attempts at earlier conflicts too. A basis no attempt has
  // seen (the base moved, or the head did) is a new conflict and gets one
  // attempt; the same basis twice is a person's.
  if (!retryTask && basis && !params.humanInitiated && policyValue('maxConflictIterations') > 0) {
    const attempted = await db.query.tasks.findFirst({
      where: and(
        eq(tasks.workspaceId, workspaceId),
        eq(tasks.conflictRetryPrNumber, prNumber),
        sql`${tasks.context}->>'conflictBasis' = ${basis}`,
      ),
      columns: { id: true, subjectHeadSha: true },
    });
    if (!attempted) {
      console.log(`[conflict-retry] PR #${prNumber} budget spent on earlier conflicts; new basis ${basis.slice(0, 7)} gets one attempt`);
      retryTask = buildRetry(spentIterations + 1);
    }
  }

  if (!retryTask) {
    console.log(`[conflict-retry] iteration cap reached for PR #${prNumber} — escalate to human`);
    return { dispatched: false, exhausted: true };
  }

  // Path-overlap serialization — same rule as POST /api/tasks (partitionOverlapEdges):
  // only a same-file, migration or serialized-surface overlap becomes a stored
  // dependsOn edge (which blocks until the upstream is completed AND merged);
  // a prefix-only overlap is soft evidence on pathDeclaration.softOverlaps,
  // decided at claim time. A repo-wide sentinel ('**') on either side produces
  // nothing. Keeping this identical to the tasks route is deliberate — the two
  // paths must not drift.
  const resolvedDependsOn: string[] = [];
  let softOverlaps: SoftOverlapEdge[] = [];
  if (
    retryTask.pathManifest &&
    retryTask.pathManifest.length > 0 &&
    !isAdvisoryManifest(retryTask.pathManifest)
  ) {
    // Not filtered to tasks with a pathManifest (unlike the tasks-route query this
    // otherwise mirrors): a candidate can be downstream of taskId through an
    // intermediate task that declares no manifest at all, and isDownstreamOf needs
    // every live dependsOn edge in the workspace to walk that chain.
    const inFlightTasks = await db.query.tasks.findMany({
      where: and(
        eq(tasks.workspaceId, workspaceId),
        inArray(tasks.status, ['pending', 'assigned', 'in_progress']),
      ),
      columns: { id: true, pathManifest: true, subjectPrNumber: true, conflictRetryPrNumber: true, dependsOn: true, status: true },
    });
    const dependsOnById = new Map<string, readonly string[] | null | undefined>(
      inFlightTasks.map((t) => [t.id, t.dependsOn as string[] | null]),
    );
    const byId = new Map(inFlightTasks.map(t => [t.id, t]));
    const gitConfig = workspace.gitConfig ?? null;
    const split = partitionOverlapEdges(
      retryTask.pathManifest,
      inFlightTasks.map(t => ({ id: t.id, pathManifest: t.pathManifest as string[] | null })),
      {
        skip: (id) => {
          const t = byId.get(id)!;
          // This attempt must run before its own PR can merge. Depending on that
          // PR's task (or another attempt on it) makes the repair unclaimable.
          if (t.id === taskId || t.subjectPrNumber === prNumber || t.conflictRetryPrNumber === prNumber) return true;
          // t is already waiting (directly or transitively) on the task this repair
          // exists to unblock — an edge (hard or soft) repair→t would make the
          // repair wait on something that is itself waiting on the repair's own
          // subject, a structural deadlock rather than real serialization.
          if (isDownstreamOf(t.id, taskId, dependsOnById)) return true;
          // Pending work with no stored edge can still wait on this PR through
          // the claim route's open-PR backstop. Reuse that exact predicate before
          // storing either a hard edge or soft evidence in the reverse direction.
          // Already-admitted work can finish without this PR landing, so keep its
          // genuine migration / serialized-surface ordering.
          return t.status === 'pending' && !!findBlockingPr(t.pathManifest ?? [], [
            { pathManifest: task.pathManifest as string[] | null, prNumber },
          ]);
        },
        isSerialized: (paths, kind) => overlapTouchesSerializedSurface(paths, gitConfig, kind),
      },
    );
    resolvedDependsOn.push(...split.hard);
    softOverlaps = split.soft;
  }

  // An attempt inherits the backend, role, routing kind and phase (Rule P1-7)
  // of the task it re-attempts.
  const identity = await inheritAttemptIdentity(retryTask.parentTaskId);

  const insertRetry = () => db
    .insert(tasks)
    .values({
      workspaceId: retryTask.workspaceId,
      title: retryTask.title,
      description: retryTask.description,
      parentTaskId: retryTask.parentTaskId,
      missionId: retryTask.missionId,
      ...identity,
      context: retryTask.context,
      creationSource: retryTask.creationSource,
      taskClass: 'attempt',
      conflictRetryPrNumber: retryTask.conflictRetryPrNumber,
      conflictRetryHeadSha: retryTask.conflictRetryHeadSha,
      status: 'pending',
      priority: 8,
      subjectKind: 'pull_request',
      subjectPrNumber: prNumber,
      subjectHeadSha: headSha,
      subjectBranch: worker.branch,
      subjectDedupeScope: 'active',
      pathManifest: retryTask.pathManifest,
      ...(resolvedDependsOn.length > 0 ? { dependsOn: resolvedDependsOn } : {}),
      // Provenance for the inferred edges (all of this attempt's are inferred)
      // and the soft evidence the claim route decides on.
      ...(retryTask.pathManifest && retryTask.pathManifest.length > 0 ? {
        pathDeclaration: {
          declared: retryTask.pathManifest,
          source: 'creation' as const,
          snapshotAt: new Date().toISOString(),
          ...(resolvedDependsOn.length > 0 ? { inferredDependsOn: [...resolvedDependsOn] } : {}),
          overlapPolicy: 'v2' as const,
          ...(softOverlaps.length > 0 ? { softOverlaps } : {}),
        },
      } : {}),
    })
    .onConflictDoNothing()
    .returning();

  let [newTask] = await insertRetry();
  // The key may be held by an earlier retry that ended on this same head
  // without pushing. The conflict is still there, so file the next attempt.
  // The iteration cap above still bounds how many attempts can run.
  if (!newTask && await releaseSpentConflictRetryKey(workspaceId, prNumber, headSha)) {
    [newTask] = await insertRetry();
  }

  if (!newTask) {
    // Hit the unique index — a concurrent caller filed the retry for this head
    return { dispatched: false };
  }

  await announceTaskCreated(newTask, workspace);
  await wakeTask(newTask.id, 'conflict.retry');
  console.log(
    `[conflict-retry] dispatched task ${newTask.id} for PR #${prNumber}@${headSha.slice(0, 7)} (iteration ${retryTask.context.conflictIteration}/${retryTask.context.maxConflictIterations})`,
  );
  // The retry inherited the original's concrete manifest; narrow it to the PR's
  // actual diff at this head so it does not defer on unrelated leases. A
  // sentinel ('**') retry is left alone — planScopeNarrowing never touches '**'
  // and never adds diff paths, so it stays scope-undeclared.
  if (installationId) {
    schedulePrScopeReconcile({ workspaceId, installationId, repoFullName, prNumber, expectedHeadSha: headSha });
  }

  // Bounded, deferred — a new conflict-retry child is exactly what the
  // retry-fork / lineage rules watch for.
  scheduleFailurePatternSentinel(workspaceId);

  return { dispatched: true, taskId: newTask.id };
}

// ── Supersession escalation ───────────────────────────────────────────────────

/**
 * Emit escalation when the supersession precheck determines this PR's changes
 * have already landed in base via a different route.
 *
 * Idempotent: CAS on tasks.context.supersessionEscalatedPrNumber — fires at
 * most once per (taskId, prNumber).
 *
 * Exported from conflict-retry (not auto-merge) to avoid a circular dependency:
 * auto-merge → conflict-retry → auto-merge.
 */
export async function escalateSupersession(
  taskId: string,
  repoFullName: string,
  prNumber: number,
  successorPrNumber: number | null,
): Promise<void> {
  const task = await db.query.tasks.findFirst({
    where: eq(tasks.id, taskId),
    columns: { id: true, missionId: true, title: true, context: true },
  });
  if (!task) return;

  // Atomic dedup: only one escalation per (taskId, prNumber)
  const [claimed] = await db
    .update(tasks)
    .set({
      context: sql`COALESCE(context, '{}'::jsonb) || jsonb_build_object('supersessionEscalatedPrNumber', ${prNumber}::int)`,
    })
    .where(
      and(
        eq(tasks.id, taskId),
        or(
          sql`context IS NULL`,
          sql`context->>'supersessionEscalatedPrNumber' IS NULL`,
        ),
      ),
    )
    .returning({ id: tasks.id });

  if (!claimed) {
    console.log(`[supersession] escalation already fired for task ${taskId} PR #${prNumber}`);
    return;
  }

  const prUrl = `https://github.com/${repoFullName}/pull/${prNumber}`;
  const taskUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? 'https://buildd.dev'}/app/tasks/${taskId}`;
  const successorClause = successorPrNumber
    ? ` PR #${prNumber}'s fix appears to have landed via PR #${successorPrNumber}.`
    : '';

  if (task.missionId) {
    const successorNote = successorPrNumber
      ? `\n\nPR #${successorPrNumber} appears to have already landed the same change.`
      : '';
    await db.insert(missionNotes).values({
      missionId: task.missionId,
      taskId: task.id,
      authorType: 'system',
      type: 'reviewer_escalated',
      title: `PR #${prNumber} — SUPERSEDED · close?`,
      body: `The conflict-retry precheck detected that this PR's changes are already present in the base branch.${successorNote}\n\nChoose one:\n- **Close PR** — the change landed elsewhere; this PR is no longer needed\n- **Reopen investigation** — re-read the diff and re-dispatch if the change is genuinely different\n\nPR: ${prUrl}`,
      status: 'open',
    });
  }

  void notifyTeamOf({ taskId: task.id }, 'needsAttention', {
    title: `PR #${prNumber}: SUPERSEDED · close?`,
    message: `${task.title}\nChanges appear to already be in base.${successorClause}\nClose or re-investigate.`,
    url: taskUrl,
    urlTitle: 'View task',
    priority: 0,
  });

  console.log(`[supersession] escalated PR #${prNumber} for task ${taskId}${successorPrNumber ? ` (successor: #${successorPrNumber})` : ''}`);
}

/**
 * Escalate when the base branch was force-pushed after the PR was opened.
 *
 * Per-PR escalation (not workspace-level): the precheck runs per-PR in the
 * conflict-retry flow, and the recommended action (cherry-pick specific commits)
 * is PR-specific. Deduped at the task level by baseRewriteEscalatedPrNumber in
 * task.context — a second conflict-retry attempt will not send a second notice.
 *
 * Blast radius note: a single force-push orphans every open PR at once. If N
 * PRs are in conflict-retry simultaneously, N escalations fire. Each names the
 * correct old/new SHAs and recommends cherry-pick for that specific PR — a
 * workspace-level notice would lose that per-PR precision without reducing noise
 * meaningfully, since each PR still needs individual cherry-pick action.
 */
export async function escalateBaseRewrite(
  taskId: string,
  repoFullName: string,
  prNumber: number,
  prOpenedBaseSha: string,
  currentBaseSha: string | undefined,
): Promise<void> {
  const task = await db.query.tasks.findFirst({
    where: eq(tasks.id, taskId),
    columns: { id: true, missionId: true, title: true, context: true },
  });
  if (!task) return;

  // Atomic dedup: only one escalation per (taskId, prNumber)
  const [claimed] = await db
    .update(tasks)
    .set({
      context: sql`COALESCE(context, '{}'::jsonb) || jsonb_build_object('baseRewriteEscalatedPrNumber', ${prNumber}::int)`,
    })
    .where(
      and(
        eq(tasks.id, taskId),
        or(
          sql`context IS NULL`,
          sql`context->>'baseRewriteEscalatedPrNumber' IS NULL`,
        ),
      ),
    )
    .returning({ id: tasks.id });

  if (!claimed) {
    console.log(`[base-rewrite] escalation already fired for task ${taskId} PR #${prNumber}`);
    return;
  }

  const prUrl = `https://github.com/${repoFullName}/pull/${prNumber}`;
  const taskUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? 'https://buildd.dev'}/app/tasks/${taskId}`;
  const oldSha = prOpenedBaseSha.slice(0, 12);
  const newSha = currentBaseSha ? currentBaseSha.slice(0, 12) : 'unknown';
  const shaLine = currentBaseSha
    ? `Old base SHA: \`${oldSha}\`  →  New tip: \`${newSha}\``
    : `Recorded base SHA: \`${oldSha}\` is no longer an ancestor of the base branch.`;

  if (task.missionId) {
    await db.insert(missionNotes).values({
      missionId: task.missionId,
      taskId: task.id,
      authorType: 'system',
      type: 'reviewer_escalated',
      title: `PR #${prNumber} — BASE REWRITTEN · cherry-pick?`,
      body: `The base branch was force-pushed after this PR was opened. The PR diff is now inflated by re-attributed commits that were already merged into the base before the force push.\n\n${shaLine}\n\n**Recommended action**: cherry-pick only the agent's own commit(s) onto a fresh branch cut from the current base — do NOT rebase the full PR, which would carry the re-attributed commits along.\n\nPR: ${prUrl}`,
      status: 'open',
    });
  }

  void notifyTeamOf({ taskId: task.id }, 'needsAttention', {
    title: `PR #${prNumber}: BASE REWRITTEN · cherry-pick?`,
    message: `${task.title}\nBase branch force-pushed (${oldSha}→${newSha}). Cherry-pick own commits onto fresh base.`,
    url: taskUrl,
    urlTitle: 'View task',
    priority: 0,
  });

  console.log(`[base-rewrite] escalated PR #${prNumber} for task ${taskId} (old: ${oldSha}, new: ${newSha})`);
}
