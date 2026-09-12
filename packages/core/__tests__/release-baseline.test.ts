import { describe, expect, it } from 'bun:test'
import { resolveReleaseBaseline, resolveLatestCiReading, type ReleaseBaselineCandidate, type CiReadingCandidate } from '../release-baseline'

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

  it('rung 3: falls back to the latest non-failed release row, using dispatchedAt', () => {
    const rows = [
      row({ state: 'dispatched', dispatchedAt: '2026-08-12T00:00:00.000Z', createdAt: '2026-08-12T00:00:00.000Z' }),
      row({ state: 'failed', dispatchedAt: '2026-08-22T00:00:00.000Z', createdAt: '2026-08-22T00:00:00.000Z' }),
    ]
    const baseline = resolveReleaseBaseline(rows, null)
    expect(baseline).toEqual({ source: 'dispatched', asOf: '2026-08-12T00:00:00.000Z' })
  })

  it('rung 3: uses createdAt when the latest row never got a dispatchedAt', () => {
    const rows = [row({ state: 'dispatched', dispatchedAt: null, createdAt: '2026-08-29T00:00:00.000Z' })]
    const baseline = resolveReleaseBaseline(rows, null)
    expect(baseline).toEqual({ source: 'dispatched', asOf: '2026-08-29T00:00:00.000Z' })
  })

  it('rung 3 is excluded when every candidate is failed: a failed dispatch establishes no baseline at all', () => {
    const rows = [
      row({ state: 'failed', dispatchedAt: '2026-08-12T00:00:00.000Z', createdAt: '2026-08-12T00:00:00.000Z' }),
      row({ state: 'failed', dispatchedAt: '2026-08-22T00:00:00.000Z', createdAt: '2026-08-22T00:00:00.000Z' }),
    ]
    expect(resolveReleaseBaseline(rows, null)).toEqual({ source: 'none', asOf: null })
    expect(resolveReleaseBaseline(rows, '2026-08-01T00:00:00.000Z')).toEqual({
      source: 'prod_head',
      asOf: '2026-08-01T00:00:00.000Z',
    })
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

function ciRow(overrides: Partial<CiReadingCandidate>): CiReadingCandidate {
  return {
    state: 'healthy',
    ciStateAtDispatch: 'passing',
    dispatchedAt: null,
    createdAt: '2026-09-12T00:00:00.000Z',
    ...overrides,
  }
}

describe('resolveLatestCiReading', () => {
  const NOW = '2026-09-12T06:40:00.000Z'

  it('no candidates → unknown', () => {
    expect(resolveLatestCiReading([], NOW)).toBe('unknown')
  })

  it('picks the reading from the most recent row by createdAt', () => {
    const rows = [
      ciRow({ ciStateAtDispatch: 'passing', createdAt: '2026-09-10T00:00:00.000Z' }),
      ciRow({ ciStateAtDispatch: 'failing', createdAt: '2026-09-12T02:01:00.000Z' }),
    ]
    expect(resolveLatestCiReading(rows, NOW)).toBe('failing')
  })

  it('a failed dispatch is never read as current CI state, even fresh', () => {
    const rows = [ciRow({ state: 'failed', ciStateAtDispatch: 'failing', createdAt: '2026-09-12T02:01:00.000Z' })]
    expect(resolveLatestCiReading(rows, NOW)).toBe('unknown')
  })

  it('a reading past the TTL degrades to unknown, never to failing', () => {
    const rows = [
      ciRow({ state: 'healthy', ciStateAtDispatch: 'failing', createdAt: '2026-09-10T00:00:00.000Z' }),
    ]
    expect(resolveLatestCiReading(rows, NOW)).toBe('unknown')
  })

  it('a fresh, non-failed reading passes through', () => {
    const rows = [
      ciRow({ state: 'healthy', ciStateAtDispatch: 'passing', createdAt: '2026-09-12T06:00:00.000Z' }),
    ]
    expect(resolveLatestCiReading(rows, NOW)).toBe('passing')
  })

  it('regression guard: a healthy, fresh failing reading still reports failing (the real gate)', () => {
    const rows = [
      ciRow({ state: 'healthy', ciStateAtDispatch: 'failing', createdAt: '2026-09-12T06:30:00.000Z' }),
    ]
    expect(resolveLatestCiReading(rows, NOW)).toBe('failing')
  })
})
