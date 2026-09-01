import { describe, expect, it } from 'bun:test'
import { resolveReleaseBaseline, type ReleaseBaselineCandidate } from '../release-baseline'

function row(overrides: Partial<ReleaseBaselineCandidate>): ReleaseBaselineCandidate {
  return {
    state: 'healthy',
    healthyAt: null,
    deployedAt: null,
    dispatchedAt: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('resolveReleaseBaseline', () => {
  it('rung 1: picks the most recent healthy release over older ones', () => {
    const rows = [
      row({ state: 'healthy', healthyAt: '2026-08-10T00:00:00.000Z', createdAt: '2026-08-10T00:00:00.000Z' }),
      row({ state: 'healthy', healthyAt: '2026-08-20T00:00:00.000Z', createdAt: '2026-08-20T00:00:00.000Z' }),
      row({ state: 'deploying', deployedAt: '2026-08-25T00:00:00.000Z', createdAt: '2026-08-25T00:00:00.000Z' }),
    ]
    const baseline = resolveReleaseBaseline(rows, null)
    expect(baseline).toEqual({ source: 'healthy', asOf: '2026-08-20T00:00:00.000Z' })
  })

  it('rung 2: falls back to the latest deployed (non-failed) release when nothing is healthy', () => {
    const rows = [
      row({ state: 'failed', deployedAt: '2026-08-15T00:00:00.000Z', createdAt: '2026-08-15T00:00:00.000Z' }),
      row({ state: 'degraded', deployedAt: '2026-08-18T00:00:00.000Z', createdAt: '2026-08-18T00:00:00.000Z' }),
      row({ state: 'deploying', deployedAt: null, dispatchedAt: '2026-08-05T00:00:00.000Z', createdAt: '2026-08-05T00:00:00.000Z' }),
    ]
    const baseline = resolveReleaseBaseline(rows, null)
    expect(baseline).toEqual({ source: 'deployed', asOf: '2026-08-18T00:00:00.000Z' })
  })

  it('rung 2: a failed release with deployedAt is excluded even if it is the newest', () => {
    const rows = [
      row({ state: 'degraded', deployedAt: '2026-08-01T00:00:00.000Z', createdAt: '2026-08-01T00:00:00.000Z' }),
      row({ state: 'failed', deployedAt: '2026-08-30T00:00:00.000Z', createdAt: '2026-08-30T00:00:00.000Z' }),
    ]
    const baseline = resolveReleaseBaseline(rows, null)
    expect(baseline).toEqual({ source: 'deployed', asOf: '2026-08-01T00:00:00.000Z' })
  })

  it('rung 3: falls back to the latest release row of any state, using dispatchedAt', () => {
    const rows = [
      row({ state: 'dispatched', dispatchedAt: '2026-08-12T00:00:00.000Z', createdAt: '2026-08-12T00:00:00.000Z' }),
      row({ state: 'failed', dispatchedAt: '2026-08-22T00:00:00.000Z', createdAt: '2026-08-22T00:00:00.000Z' }),
    ]
    const baseline = resolveReleaseBaseline(rows, null)
    expect(baseline).toEqual({ source: 'dispatched', asOf: '2026-08-22T00:00:00.000Z' })
  })

  it('rung 3: uses createdAt when the latest row never got a dispatchedAt', () => {
    const rows = [row({ state: 'dispatched', dispatchedAt: null, createdAt: '2026-08-29T00:00:00.000Z' })]
    const baseline = resolveReleaseBaseline(rows, null)
    expect(baseline).toEqual({ source: 'dispatched', asOf: '2026-08-29T00:00:00.000Z' })
  })

  it('rung 4: zero release rows falls back to the supplied prod-branch HEAD timestamp', () => {
    const baseline = resolveReleaseBaseline([], '2026-08-28T00:00:00.000Z')
    expect(baseline).toEqual({ source: 'prod_head', asOf: '2026-08-28T00:00:00.000Z' })
  })

  it('empty state: no releases and no resolvable prod-branch HEAD → none/unavailable', () => {
    const baseline = resolveReleaseBaseline([], null)
    expect(baseline).toEqual({ source: 'none', asOf: null })
  })
})
