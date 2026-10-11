/**
 * How a release reads on the Releases list and the release page: its state as
 * a StatePill, whether it was superseded, and which row is the next release.
 * Pure and client-safe.
 */
import type { StateKey } from '@/components/ui/states';

export type ReleaseRowState =
  | 'dispatched' | 'deploying' | 'healthy' | 'failed' | 'degraded' | 'pending_external'
  | (string & {});

/** Release states that have not finished: the release is still going out. */
const IN_FLIGHT = new Set<string>(['dispatched', 'pending_external', 'deploying']);

export const isReleaseInFlight = (state: string): boolean => IN_FLIGHT.has(state);

/** The id of the release that replaced this one, parsed from `failureReason`. */
export function supersededById(failureReason: string | null | undefined): string | null {
  const match = failureReason?.match(/^superseded by release (\S+)/);
  return match?.[1] ?? null;
}

/** A failed row the executor closed because a newer release shipped its commits. */
export function isSupersededRelease(r: { state: string; failureReason: string | null }): boolean {
  return r.state === 'failed' && supersededById(r.failureReason) !== null;
}

const RELEASE_PILL: Record<string, { state: StateKey; label: string; title: string }> = {
  pending_external: { state: 'ready', label: 'Pending', title: 'Dispatched; waiting for the release to merge' },
  dispatched: { state: 'review', label: 'Dispatched', title: 'The release workflow is running' },
  deploying: { state: 'landing', label: 'Deploying', title: 'Merged; the deploy is going out' },
  healthy: { state: 'landed', label: 'Healthy', title: 'Deployed and passing its health checks' },
  degraded: { state: 'ci_failed', label: 'Degraded', title: 'Deployed, but its health checks are failing' },
  failed: { state: 'failed', label: 'Failed', title: 'The release did not ship' },
};

/**
 * A release's state as a StatePill. A superseded release is not a failure: it
 * reads as a neutral `Superseded`, never a red `Failed`.
 */
export function releasePill(r: { state: string; failureReason: string | null }): { state: StateKey; label: string; title: string } {
  if (isSupersededRelease(r)) {
    return { state: 'queued', label: 'Superseded', title: 'A newer release shipped these commits' };
  }
  return RELEASE_PILL[r.state] ?? { state: 'ready', label: r.state, title: r.state };
}

/**
 * The next release: the newest release that is still in flight and is the
 * latest row of its workspace (an in-flight row behind a finished one is
 * history, about to be swept). Rows are newest first. Null when nothing is
 * going out.
 */
export function pickNextRelease<T extends { id: string; workspaceId: string; state: string }>(rows: readonly T[]): T | null {
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.workspaceId)) continue;
    seen.add(r.workspaceId);
    if (isReleaseInFlight(r.state)) return r;
  }
  return null;
}

/** The list's count line: the real total, and how much of it is shown. */
export function releaseCountLine(shown: number, total: number): string {
  if (total > shown) return `Latest ${shown} of ${total} releases`;
  return `${total} ${total === 1 ? 'release' : 'releases'}`;
}
