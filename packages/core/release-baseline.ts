/**
 * Baseline ladder for gated-release queue depth. "Baseline" is the point in
 * time after which a merged PR counts as unshipped. Most workspaces start
 * with zero rows in `releases` — that MUST NOT collapse to "no data" (spec §4's
 * `render nothing` rule is for `archetype: none`, not for "no data yet").
 *
 * A `failed` release row is excluded from EVERY rung, not just rung 2 — a
 * failed dispatch is a reading taken at a moment now known to be bad, so it
 * cannot anchor "the point after which merges are unshipped" any more than
 * it can stand in for current CI state (see `resolveLatestCiReading` below).
 *
 * Rungs, most-trusted first:
 *   1. MAX(healthy_at) of a `state = 'healthy'` release — verified deploy.
 *   2. else MAX(deployed_at) of any non-failed release — deployed but unverified.
 *   3. else the latest non-failed release row of any other state
 *      (dispatched_at, or its createdAt if dispatched_at was never set) —
 *      attempted but unresolved.
 *   4. else the caller-supplied prod-branch HEAD timestamp — no release has
 *      ever been recorded for this workspace, so the only honest baseline is
 *      "whatever is currently on the prod branch" (resolved externally, e.g.
 *      via a GitHub API call — this module stays pure and DB/network-free).
 *   5. else `none` — no baseline can be established at all (e.g. no releases
 *      row and prod-branch HEAD could not be resolved either, or every
 *      release row on record is `failed`).
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

  const attempted = candidates.filter((r) => r.state !== 'failed')
  if (attempted.length > 0) {
    const latest = latestBy(attempted, 'createdAt')!
    return { source: 'dispatched', asOf: latest.dispatchedAt ?? latest.createdAt }
  }

  if (prodHeadAsOf) return { source: 'prod_head', asOf: prodHeadAsOf }

  return { source: 'none', asOf: null }
}

/**
 * CI reading for the release queue widget. The latest `releases` row's
 * `ciStateAtDispatch` is only evidence of *current* CI when both hold:
 *   - the row did not come from a `failed` dispatch (that reading is known
 *     stale the moment the dispatch fails — see module doc above), and
 *   - the reading is within `ttlMs` of `nowIso` (an old reading is not
 *     evidence of current CI either, failed or not).
 * Otherwise degrade to `unknown`, which the widget's decision rule already
 * treats optimistically (`show`, not `ci_blocking`) — fail toward showing
 * the release action, never toward a dead card.
 */
export type CiStateReading = 'passing' | 'failing' | 'pending' | 'unknown'

export interface CiReadingCandidate {
  state: string
  ciStateAtDispatch: 'passing' | 'failing' | 'pending' | null
  dispatchedAt: string | null
  createdAt: string
}

/** How long a dispatch-time CI reading remains trustworthy as "current" CI state. */
export const CI_READING_TTL_MS = 6 * 60 * 60 * 1000 // 6 hours

export function resolveLatestCiReading(
  candidates: CiReadingCandidate[],
  nowIso: string,
  ttlMs: number = CI_READING_TTL_MS,
): CiStateReading {
  if (candidates.length === 0) return 'unknown'

  const latest = [...candidates].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
  if (latest.state === 'failed') return 'unknown'
  if (!latest.ciStateAtDispatch) return 'unknown'

  const readingAt = latest.dispatchedAt ?? latest.createdAt
  const ageMs = new Date(nowIso).getTime() - new Date(readingAt).getTime()
  if (!Number.isFinite(ageMs) || ageMs > ttlMs) return 'unknown'

  return latest.ciStateAtDispatch
}
