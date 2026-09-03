/**
 * Reviewer machinery — Phase 2 of the merge policy primitive.
 *
 * Covers:
 *   BT-5  createReviewerTask() — spawns reviewer task on PR open with agent-review policy
 *   BT-6  ReviewerTaskOutput schema + context injection
 *   BT-10 preflightEscalationCheck() — short-circuits reviewer dispatch for schema/deny-path PRs
 *
 * The reviewer task's outcome is handled in apps/web/src/app/api/workers/[id]/route.ts (BT-7/8/9).
 */

import { db } from '@buildd/core/db';
import { tasks, workers, missionNotes, artifacts } from '@buildd/core/db/schema';
import { eq, and, inArray, desc } from 'drizzle-orm';
import type { MergePolicy } from '@buildd/shared';
import type { MigrationSafety } from '@/lib/migration-safety';
import { isAdvisoryManifest } from '@buildd/core/path-overlap';
import { reviewerTitle } from './task-title';
import type { WorkspacePolicyConfig } from './workspace-policy';
import {
  resolveEffectivePolicyForPR,
  findUncoveredRiskPaths,
  buildPolicyClassPaths,
} from './workspace-policy';
import { LIVE_WORKER_STATUSES } from './task-presentation';
import { appendPrActivity } from './pr-activity-comment';

// ── Output schema ────────────────────────────────────────────────────────────

export interface ReviewerTaskOutput {
  verdict: 'approve' | 'request-changes' | 'escalate';
  confidence: number;
  summary: string;
  feedback?: string;
  escalationReason?: string;
  /**
   * What the human should actually do next. Requested on escalate because the
   * escalation lands on someone's Home queue as a decision they did not make —
   * a reason without a next step makes it a chore.
   */
  recommendation?: string;
}

export const REVIEWER_TASK_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['verdict', 'confidence', 'summary'],
  properties: {
    verdict: {
      type: 'string',
      enum: ['approve', 'request-changes', 'escalate'],
      description: 'The review verdict',
    },
    confidence: {
      type: 'number',
      minimum: 0,
      maximum: 1,
      description: 'Reviewer confidence score 0–1',
    },
    summary: {
      type: 'string',
      description: 'One-sentence summary of the review decision',
    },
    feedback: {
      type: 'string',
      description: 'Specific, actionable feedback (for request-changes only)',
    },
    escalationReason: {
      type: 'string',
      description: 'Why this PR needs human review (for escalate only)',
    },
    recommendation: {
      type: 'string',
      description:
        'The concrete next action the human should take (for escalate only) — one or two sentences, e.g. what to verify, what decision is needed, what you already ruled out',
    },
  },
  additionalProperties: false,
} as const;

// ── Schema-touching path patterns ────────────────────────────────────────────

export function isSchemaTouchingFile(filename: string): boolean {
  // Generated SQL migration under any package's drizzle directory.
  if (/(?:^|\/)drizzle\/\d{4}_[^/]+\.sql$/.test(filename)) return true;
  // packages/core/db/schema.ts — exact match
  if (filename === 'packages/core/db/schema.ts') return true;
  return false;
}

// ── Pre-flight escalation check ───────────────────────────────────────────────

/**
 * BT-10: Check PR files before spawning a reviewer task.
 * Returns shouldEscalate=true when:
 *   - PR touches schema migration files (drizzle/*.sql, packages/core/db/schema.ts)
 *   - PR touches any of policy.agentReview.escalateToPaths
 *   - PR matches a risk class with action='human' in policyConfig (when set)
 *
 * This is a fail-safe on top of the reviewer agent's own escalation logic.
 */
export function preflightEscalationCheck(
  prFiles: Array<{ filename: string }>,
  policy: MergePolicy,
  migrationSafety?: MigrationSafety,
  policyConfig?: WorkspacePolicyConfig,
): { shouldEscalate: true; reason: string } | { shouldEscalate: false } {
  // The inspector loads the complete paginated file list, so honor an unsafe
  // result even if GitHub's initial files response was truncated.
  if (migrationSafety && !migrationSafety.safe) {
    return { shouldEscalate: true, reason: migrationSafety.reason };
  }
  if (prFiles.some((file) => isSchemaTouchingFile(file.filename))) {
    if (!migrationSafety) {
      return { shouldEscalate: true, reason: 'could not inspect generated SQL migration' };
    }
  }

  // Semantic risk-class check (policyConfig supersedes escalateToPaths)
  if (policyConfig) {
    const fileNames = prFiles.map((f) => f.filename);
    const match = resolveEffectivePolicyForPR(policyConfig, fileNames);
    if (match?.action === 'human') {
      return {
        shouldEscalate: true,
        reason: `PR touches ${match.matchedClass.replace(/_/g, ' ')} (${match.matchedFile}) — ${policyConfig.preset} policy requires human review`,
      };
    }
    // agent-review is handled by the caller (reviewer task creation), not preflight
    return { shouldEscalate: false };
  }

  // Legacy: policy deny-path check
  const escalateToPaths = policy.agentReview?.escalateToPaths ?? [];
  if (escalateToPaths.length > 0) {
    for (const f of prFiles) {
      const hit = escalateToPaths.find((p) => f.filename.startsWith(p));
      if (hit) {
        return {
          shouldEscalate: true,
          reason: `PR touches escalation path: ${f.filename} (matched ${hit})`,
        };
      }
    }
  }

  return { shouldEscalate: false };
}

// ── Reviewer task creation ────────────────────────────────────────────────────

export interface CreateReviewerTaskParams {
  workspaceId: string;
  originalTaskId: string;
  originalTask: {
    title: string;
    description: string | null;
    backend: 'claude' | 'codex';
    missionId: string | null;
    pathManifest?: string[] | null;
    iteration?: number | null;
    maxIterations?: number | null;
  };
  worker: {
    branch: string;
  };
  prNumber: number;
  prUrl: string;
  headSha: string;
  reviewerRole: string;
  installationId: number;
  repoFullName: string;
  /** When set, the reviewer context uses intent sentences instead of raw glob lists. */
  policyConfig?: WorkspacePolicyConfig;
  /**
   * Where to push this review's outcome, for a requester waiting in code.
   * Stored on the reviewer task so whichever handler reaches the terminal
   * point can deliver it (see `deliverPrReviewCallback`).
   */
  reviewCallback?: { url: string; on: 'verdict' | 'merge' };
}

/**
 * BT-5: Create a reviewer task for an agent-review policy PR.
 *
 * Fetches PR diff + task artifacts and builds a rich CLAUDE.md context
 * so the reviewer agent can make an informed judgment without extra tool calls.
 */
export async function createReviewerTask(
  params: CreateReviewerTaskParams,
): Promise<{ id: string } | null> {
  const {
    workspaceId,
    originalTaskId,
    originalTask,
    worker,
    prNumber,
    prUrl,
    headSha,
    reviewerRole,
    installationId,
    repoFullName,
  } = params;

  // Build reviewer context description
  const diffContext = await buildReviewerContext({
    originalTaskId,
    originalTask,
    prNumber,
    prUrl,
    headSha,
    installationId,
    repoFullName,
    policyConfig: params.policyConfig,
  });

  const title = reviewerTitle(prNumber, originalTask.title);

  const [reviewerTask] = await db
    .insert(tasks)
    .values({
      workspaceId,
      title,
      description: diffContext,
      category: 'review',
      roleSlug: reviewerRole,
      // Keep reviews on the same provider as the task that produced the PR.
      // Falling back to the DB's Claude default can strand reviews when Claude's
      // OAuth budget is exhausted even though the original ran on Codex.
      backend: originalTask.backend,
      outputSchema: REVIEWER_TASK_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
      missionId: originalTask.missionId,
      parentTaskId: originalTaskId,
      taskClass: 'attempt',
      context: {
        reviewerFor: originalTaskId,
        prNumber,
        prUrl,
        headSha,
        originalTaskId,
        workerBranch: worker.branch,
        repoFullName,
        installationId,
        // iteration tracking for request-changes retry cap (stored in context, not a column)
        iteration: originalTask.iteration ?? 0,
        maxIterations: originalTask.maxIterations ?? 3,
        ...(params.reviewCallback ? { reviewCallback: params.reviewCallback } : {}),
      },
      release: 'false', // reviewer tasks never trigger releases
      priority: 8,      // reviewer tasks are high priority
      status: 'pending',
      creationSource: 'webhook',
    })
    .returning({ id: tasks.id });

  return reviewerTask ?? null;
}

// ── Context builder (BT-6) ────────────────────────────────────────────────────

interface BuildContextParams {
  originalTaskId: string;
  originalTask: {
    title: string;
    description: string | null;
    pathManifest?: string[] | null;
    iteration?: number | null;
    maxIterations?: number | null;
  };
  prNumber: number;
  prUrl: string;
  headSha: string;
  installationId: number;
  repoFullName: string;
  policyConfig?: WorkspacePolicyConfig;
}

/** Doctrine bullets used when the task declared a concrete file scope. */
const CONCRETE_MANIFEST_DOCTRINE = [
  '- ONE-WORK-UNIT: The PR should touch only files in the pathManifest (plus lock files). Flag scope creep.',
  '- PATH-MANIFEST CONFORMANCE: Every file in pathManifest must be present in the diff. Missing = incomplete delivery.',
].join('\n');

/** Doctrine bullets used when the task never declared a file scope. */
const UNDECLARED_MANIFEST_DOCTRINE = [
  '- ONE-WORK-UNIT: This task has no declared manifest, so judge scope against the task description — flag files the description does not account for.',
  '- PATH-MANIFEST CONFORMANCE: Not applicable — with no declared manifest there is nothing to check the diff against. Do NOT report files as missing from the manifest.',
].join('\n');

/**
 * Render the manifest-dependent parts of the reviewer prompt: the two scope
 * doctrine bullets and the `## Expected Path Manifest` section.
 *
 * The repo-wide sentinel `'**'` (the mission-task default in POST /api/tasks)
 * means "this task never declared its scope" — it is NOT a path. Rendering it as
 * a manifest entry told the reviewer to confirm a file literally named `**`
 * appears in the diff, an impossible check that polluted review output. Advisory
 * manifests therefore get an honest "no declared scope" rendering and the
 * completeness doctrine is withdrawn. `isAdvisoryManifest` is the single
 * definition of that predicate (see packages/core/path-overlap.ts).
 */
export function renderManifestGuidance(
  pathManifest?: string[] | null,
): { doctrine: string; section: string } {
  if (isAdvisoryManifest(pathManifest)) {
    return {
      doctrine: UNDECLARED_MANIFEST_DOCTRINE,
      section: [
        '## Expected Path Manifest',
        '',
        'This task declared no file scope — its manifest is the repo-wide sentinel `**`,',
        'which is the default for mission tasks filed without paths. It is advisory, not a',
        'list of files, so it cannot be used as a completeness check. Judge scope and',
        'completeness from the task description and the diff alone.',
      ].join('\n'),
    };
  }

  if (!pathManifest || pathManifest.length === 0) {
    return {
      doctrine: UNDECLARED_MANIFEST_DOCTRINE,
      section: '## Expected Path Manifest\n\n(No pathManifest declared for this task)',
    };
  }

  return {
    doctrine: CONCRETE_MANIFEST_DOCTRINE,
    section: `## Expected Path Manifest (files this PR should touch)\n\n${pathManifest
      .map((p) => `- ${p}`)
      .join('\n')}`,
  };
}

async function buildReviewerContext(params: BuildContextParams): Promise<string> {
  const { originalTaskId, originalTask, prNumber, prUrl, headSha, repoFullName, policyConfig } = params;

  // Fetch PR diff summary via GitHub API (lazy import avoids circular deps)
  let diffSummary = '';
  try {
    const { githubApi } = await import('@/lib/github');
    const files: Array<{
      filename: string;
      additions: number;
      deletions: number;
      status: string;
    }> = await githubApi(
      params.installationId,
      `/repos/${repoFullName}/pulls/${prNumber}/files?per_page=300`,
    );

    if (Array.isArray(files) && files.length > 0) {
      const totalAdded = files.reduce((s, f) => s + (f.additions || 0), 0);
      const totalDeleted = files.reduce((s, f) => s + (f.deletions || 0), 0);
      const fileLines = files
        .map((f) => `  - ${f.filename} (+${f.additions}/-${f.deletions}) [${f.status}]`)
        .join('\n');
      diffSummary = `## PR Files Changed (+${totalAdded}/-${totalDeleted})\n\n${fileLines}`;
    }
  } catch (err) {
    console.warn(`[reviewer] Failed to fetch PR files for #${prNumber}:`, err);
    diffSummary = '## PR Files\n\n(Could not fetch file list — check GitHub API access)';
  }

  // Fetch task artifacts
  let artifactsSection = '';
  try {
    const taskArtifacts = await db.query.artifacts.findMany({
      where: eq(artifacts.workerId, originalTaskId),
      columns: { id: true, title: true, type: true, content: true, storageKey: true },
    });

    if (taskArtifacts.length > 0) {
      const artifactLines = taskArtifacts.map((a) => {
        const preview = a.content ? `\n  Content preview: ${a.content.slice(0, 300)}...` : '';
        return `- [${a.type}] ${a.title}${preview}`;
      });
      artifactsSection = `## Task Artifacts\n\n${artifactLines.join('\n\n')}`;
    }
  } catch (err) {
    console.warn(`[reviewer] Failed to fetch artifacts for task ${originalTaskId}:`, err);
  }

  // Path manifest — doctrine + section vary by whether the scope was declared.
  const { doctrine: manifestDoctrine, section: manifestSection } =
    renderManifestGuidance(originalTask.pathManifest);

  const iterationInfo = originalTask.iteration != null
    ? `Iteration: ${originalTask.iteration}/${originalTask.maxIterations ?? 3}`
    : '';

  // Build policy context section
  let policySection: string;
  let uncoveredSection = '';
  if (policyConfig) {
    policySection = buildPolicyClassPaths(policyConfig);

    // Self-healing: find files not covered by any risk class but risk-adjacent
    const allFiles = diffSummary
      .split('\n')
      .filter((l) => l.trim().startsWith('- '))
      .map((l) => l.trim().slice(2).split(' ')[0])
      .filter(Boolean);
    const uncovered = findUncoveredRiskPaths(policyConfig, allFiles);
    if (uncovered.length > 0) {
      const lines = uncovered.map(
        (u) => `- \`${u.file}\` → suggested class: \`${u.suggestedClass}\``,
      );
      uncoveredSection = `\n## Proposed Policy Additions (self-healing)\nThe following files are risk-adjacent but not covered by any policy class.\nInclude in your escalationReason so the human can add them to the workspace policy:\n\n${lines.join('\n')}`;
    }
  } else {
    policySection = `## Escalation Rules (hard — these override your confidence)
- Escalate if the diff touches \`drizzle/*.sql\` or \`packages/core/db/schema.ts\` (schema changes need human review)
- Escalate if your confidence is below the workspace threshold (default 0.6)
- Escalate if you detect a possible security issue`;
  }

  return `# Reviewer Task

You are reviewing PR #${prNumber} on \`${repoFullName}\`.
PR URL: ${prUrl}
HEAD SHA: ${headSha}
${iterationInfo}

## Original Task
**Title:** ${originalTask.title}

**Description:**
${originalTask.description ?? '(no description)'}

## Doctrine
${manifestDoctrine}
- SPEC CONFORMANCE: What was built must match the task description.
- NO OBVIOUS REGRESSIONS: No deleted test files, no broken imports visible in diff.

${policySection}
${uncoveredSection}

${manifestSection}

${diffSummary}

${artifactsSection}

## Your Output
Use your outputSchema to return:
- \`verdict\`: 'approve' | 'request-changes' | 'escalate'
- \`confidence\`: 0.0–1.0
- \`summary\`: one sentence
- \`feedback\`: (request-changes only) specific, actionable, with file paths
- \`escalationReason\`: (escalate only) why a human must decide; include any proposed policy additions
- \`recommendation\`: (escalate only) what the human should DO next — the specific action, decision, or check. Never leave this empty on an escalation: it is the first line they read on their queue.
`.trim();
}

// ── Human-merge supersession ──────────────────────────────────────────────────

export interface SupersedeReviewerOnMergeParams {
  originalTaskId: string;
  installationId: number;
  repoFullName: string;
  prNumber: number;
}

/**
 * Cancel a still-pending or still-running reviewer task after a human merges
 * its PR directly. Without this, a reviewer that hasn't started yet gets
 * claimed later and reviews a PR that's already merged — wasted work, and a
 * verdict that can no longer affect anything.
 *
 * Best-effort: never throws. A failure here must not roll back the merge that
 * already succeeded on GitHub.
 */
export async function supersedeReviewerTaskOnMerge(
  params: SupersedeReviewerOnMergeParams,
): Promise<{ superseded: boolean; reviewerTaskId: string | null }> {
  const { originalTaskId, installationId, repoFullName, prNumber } = params;

  try {
    const reviewerTask = await db.query.tasks.findFirst({
      where: and(
        eq(tasks.parentTaskId, originalTaskId),
        eq(tasks.category, 'review'),
        inArray(tasks.status, ['pending', 'assigned', 'in_progress']),
      ),
      columns: { id: true, missionId: true, workspaceId: true },
      orderBy: [desc(tasks.createdAt)],
      with: {
        workers: {
          where: inArray(workers.status, [...LIVE_WORKER_STATUSES]),
          columns: { id: true, status: true },
          limit: 1,
        },
      },
    });

    if (!reviewerTask) return { superseded: false, reviewerTaskId: null };

    const liveWorker = (reviewerTask as any).workers?.[0];
    if (liveWorker) {
      // CAS-guarded — a reviewer completing at the same instant should win
      // its own lease rather than being clobbered here.
      await db
        .update(workers)
        .set({
          status: 'failed',
          error: 'Superseded — PR merged by a human before review completed',
          exitCause: 'condition_unmet',
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(workers.id, liveWorker.id), eq(workers.status, liveWorker.status)));
    }

    const [cancelled] = await db
      .update(tasks)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(and(
        eq(tasks.id, reviewerTask.id),
        inArray(tasks.status, ['pending', 'assigned', 'in_progress']),
      ))
      .returning({ id: tasks.id });

    if (!cancelled) return { superseded: false, reviewerTaskId: null };

    if (reviewerTask.missionId) {
      await db.insert(missionNotes).values({
        missionId: reviewerTask.missionId,
        taskId: originalTaskId,
        authorType: 'system',
        type: 'reviewer_superseded',
        title: `PR #${prNumber}: review cancelled — merged by a human`,
        body: 'A human merged this PR while the agent review was still pending or running. The review task was cancelled so it does not run against an already-merged PR.',
        status: 'open',
      });
    }

    await appendPrActivity({
      installationId,
      repoFullName,
      prNumber,
      entry: { kind: 'review_superseded_by_merge' },
      workspaceId: reviewerTask.workspaceId,
    }).catch(() => {});

    return { superseded: true, reviewerTaskId: reviewerTask.id };
  } catch (err) {
    console.error(`[reviewer] supersedeReviewerTaskOnMerge failed for PR #${prNumber}:`, err);
    return { superseded: false, reviewerTaskId: null };
  }
}
