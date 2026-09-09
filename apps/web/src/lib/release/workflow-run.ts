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

/** Terminal-ish state a completed workflow_run implies for its `releases` row. */
export type ReleaseStateFromRun = 'deploying' | 'failed' | null;

/**
 * Map a completed run's conclusion onto the release row's next state.
 *
 * This used to handle exactly `success` and `failure` and return early for
 * everything else — so a run that was `cancelled`, `timed_out` or died at
 * `startup_failure` left its release row sitting in `dispatched` forever, in a
 * state no sweeper covered, silently blocking any further non-forced release of
 * that commit.
 *
 * `action_required` is the one conclusion that genuinely is not an outcome: the
 * run is waiting on a human and a later event will carry the real verdict.
 * Everything else is terminal, including `skipped` and `neutral` — a release
 * workflow that skipped shipped nothing, and recording that as a failed release
 * is accurate, not pessimistic.
 */
export function mapWorkflowConclusionToReleaseState(
  conclusion: string | null,
): ReleaseStateFromRun {
  if (conclusion === 'success') return 'deploying';
  if (conclusion === null || conclusion === 'action_required') return null;
  return 'failed';
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
