/**
 * Baseline ladder for gated-release queue depth. "Baseline" is the point in
 * time after which a merged PR counts as unshipped. Most workspaces start
 * with zero rows in `releases` — that MUST NOT collapse to "no data" (spec §4's
 * `render nothing` rule is for `archetype: none`, not for "no data yet").
 *
 * Rungs, most-trusted first:
 *   1. MAX(healthy_at) of a `state = 'healthy'` release — verified deploy.
 *   2. else MAX(deployed_at) of any non-failed release — deployed but unverified.
 *   3. else the latest release row of any state (dispatched_at, or its
 *      createdAt if dispatched_at was never set) — attempted but unresolved.
 *   4. else the caller-supplied prod-branch HEAD timestamp — no release has
 *      ever been recorded for this workspace, so the only honest baseline is
 *      "whatever is currently on the prod branch" (resolved externally, e.g.
 *      via a GitHub API call — this module stays pure and DB/network-free).
 *   5. else `none` — no baseline can be established at all (e.g. no releases
 *      row and prod-branch HEAD could not be resolved either).
 */

export type ReleaseBaselineSource = 'healthy' | 'deployed' | 'dispatched' | 'prod_head' | 'none'

export interface ReleaseBaselineCandidate {
  state: string
  healthyAt: string | null
  deployedAt: string | null
  dispatchedAt: string | null
  createdAt: string
}

export interface ReleaseBaseline {
  source: ReleaseBaselineSource
  /** ISO timestamp to compare merges against, or null when source === 'none'. */
  asOf: string | null
}

function latestBy(rows: ReleaseBaselineCandidate[], field: 'healthyAt' | 'deployedAt' | 'createdAt'): ReleaseBaselineCandidate | undefined {
  return [...rows].sort((a, b) => (b[field] as string).localeCompare(a[field] as string))[0]
}

export function resolveReleaseBaseline(
  candidates: ReleaseBaselineCandidate[],
  prodHeadAsOf: string | null,
): ReleaseBaseline {
  const healthy = latestBy(candidates.filter((r) => r.state === 'healthy' && r.healthyAt), 'healthyAt')
  if (healthy) return { source: 'healthy', asOf: healthy.healthyAt }

  const deployed = latestBy(candidates.filter((r) => r.state !== 'failed' && r.deployedAt), 'deployedAt')
  if (deployed) return { source: 'deployed', asOf: deployed.deployedAt }

  if (candidates.length > 0) {
    const latest = latestBy(candidates, 'createdAt')!
    return { source: 'dispatched', asOf: latest.dispatchedAt ?? latest.createdAt }
  }

  if (prodHeadAsOf) return { source: 'prod_head', asOf: prodHeadAsOf }

  return { source: 'none', asOf: null }
}
