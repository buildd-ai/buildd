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
import { eq, and } from 'drizzle-orm';
import type { MergePolicy } from '@buildd/shared';

// ── Output schema ────────────────────────────────────────────────────────────

export interface ReviewerTaskOutput {
  verdict: 'approve' | 'request-changes' | 'escalate';
  confidence: number;
  summary: string;
  feedback?: string;
  escalationReason?: string;
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
  },
  additionalProperties: false,
} as const;

// ── Schema-touching path patterns ────────────────────────────────────────────

const SCHEMA_PATHS = ['drizzle/', 'packages/core/db/schema.ts'];

export function isSchemaTouchingFile(filename: string): boolean {
  // drizzle/*.sql — any SQL migration file under the drizzle/ directory
  if (filename.startsWith('drizzle/') && filename.endsWith('.sql')) return true;
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
 *
 * This is a fail-safe on top of the reviewer agent's own escalation logic.
 */
export function preflightEscalationCheck(
  prFiles: Array<{ filename: string }>,
  policy: MergePolicy,
): { shouldEscalate: true; reason: string } | { shouldEscalate: false } {
  // Schema migration check
  for (const f of prFiles) {
    if (isSchemaTouchingFile(f.filename)) {
      return {
        shouldEscalate: true,
        reason: `PR touches schema migration file: ${f.filename}`,
      };
    }
  }

  // Policy deny-path check
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
  });

  const title = `[reviewer] PR #${prNumber}: ${originalTask.title}`;

  const [reviewerTask] = await db
    .insert(tasks)
    .values({
      workspaceId,
      title,
      description: diffContext,
      category: 'review',
      roleSlug: reviewerRole,
      outputSchema: REVIEWER_TASK_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
      missionId: originalTask.missionId,
      parentTaskId: originalTaskId,
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
}

async function buildReviewerContext(params: BuildContextParams): Promise<string> {
  const { originalTaskId, originalTask, prNumber, prUrl, headSha, repoFullName } = params;

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

  // Path manifest
  const pathManifest = originalTask.pathManifest;
  const manifestSection = pathManifest && pathManifest.length > 0
    ? `## Expected Path Manifest (files this PR should touch)\n\n${pathManifest.map((p) => `- ${p}`).join('\n')}`
    : '## Expected Path Manifest\n\n(No pathManifest declared for this task)';

  const iterationInfo = originalTask.iteration != null
    ? `Iteration: ${originalTask.iteration}/${originalTask.maxIterations ?? 3}`
    : '';

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
- ONE-WORK-UNIT: The PR should touch only files in the pathManifest (plus lock files). Flag scope creep.
- PATH-MANIFEST CONFORMANCE: Every file in pathManifest must be present in the diff. Missing = incomplete delivery.
- SPEC CONFORMANCE: What was built must match the task description.
- NO OBVIOUS REGRESSIONS: No deleted test files, no broken imports visible in diff.

## Escalation Rules (hard — these override your confidence)
- Escalate if the diff touches \`drizzle/*.sql\` or \`packages/core/db/schema.ts\` (schema changes need human review)
- Escalate if your confidence is below the workspace threshold (default 0.6)
- Escalate if you detect a possible security issue

${manifestSection}

${diffSummary}

${artifactsSection}

## Your Output
Use your outputSchema to return:
- \`verdict\`: 'approve' | 'request-changes' | 'escalate'
- \`confidence\`: 0.0–1.0
- \`summary\`: one sentence
- \`feedback\`: (request-changes only) specific, actionable, with file paths
- \`escalationReason\`: (escalate only) why a human must decide
`.trim();
}
