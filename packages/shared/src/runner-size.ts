/**
 * Which cloud-runner container class a workspace's tasks run in:
 * `gitConfig.runnerSize` (jsonb, no column).
 *
 * - `standard`: the default class (½ vCPU, 4 GiB, 8 GB disk).
 * - `large`: 2 vCPU, 8 GiB, 16 GB disk, for repos whose build or checkout
 *   does not fit the standard one.
 *
 * Unset is derived from the workspace's recent cloud run reports, and sticky
 * once derived (apps/web/src/lib/runner-size.ts). The cloud runner's Worker
 * asks buildd for the size at dispatch (POST /api/runner/runner-size), so the
 * container never chooses its own class.
 */
export const RUNNER_SIZES = ['standard', 'large'] as const;
export type RunnerSize = typeof RUNNER_SIZES[number];

/** Where the effective size came from, for the settings page and the run report. */
export type RunnerSizeSource = 'explicit' | 'derived' | 'default';

/**
 * Why a workspace was moved to `large`. One per trigger in the derivation
 * rule; a run report names the first one that fired.
 */
export const RUNNER_SIZE_REASONS = ['memory_pressure', 'low_disk', 'container_restart', 'large_checkout'] as const;
export type RunnerSizeReason = typeof RUNNER_SIZE_REASONS[number];

/**
 * Fair-use weight of one runner-second per class: what hosted billing will
 * count (not applied anywhere yet). Mirrors apps/cloud-runner/src/runner-class.ts.
 */
export const RUNNER_SIZE_WEIGHT: Record<RunnerSize, number> = { standard: 1, large: 2 };

export function isRunnerSize(value: unknown): value is RunnerSize {
  return typeof value === 'string' && (RUNNER_SIZES as readonly string[]).includes(value);
}

export function isRunnerSizeReason(value: unknown): value is RunnerSizeReason {
  return typeof value === 'string' && (RUNNER_SIZE_REASONS as readonly string[]).includes(value);
}
