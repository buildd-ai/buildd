// Pure helpers for processing GitHub `workflow_run` webhook events.
// Extracted here so the mapping logic is unit-testable independently of the
// DB layer in the webhook route handler.

import type { ReleaseResult } from '@buildd/core/db/schema';

export interface WorkflowRunPayload {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  head_branch: string | null;
}

/**
 * Map a completed GitHub workflow_run onto an updated ReleaseResult.
 * Pure: no I/O.
 */
export function buildWorkflowRunOutcome(
  previous: ReleaseResult,
  run: WorkflowRunPayload,
): ReleaseResult {
  const succeeded = run.conclusion === 'success';
  const branch = run.head_branch ?? 'unknown';

  return {
    ...previous,
    status: succeeded ? 'completed' : 'failed',
    message: succeeded
      ? `Release: completed — workflow "${run.name}" succeeded on ${branch}`
      : `Release: FAILED — workflow "${run.name}" conclusion: ${run.conclusion ?? 'unknown'}`,
    runStatus: run.status,
    runConclusion: run.conclusion,
    runUrl: run.html_url,
    // Preserve a previously-set mergedAt; fall back to now on success.
    ...(succeeded ? { mergedAt: previous.mergedAt ?? new Date().toISOString() } : {}),
    ...(succeeded ? {} : { error: `Workflow conclusion: ${run.conclusion ?? 'unknown'}` }),
  };
}
