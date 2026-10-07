import { describe, it, expect } from 'bun:test';
import { PR_PILL, canonicalPrState, derivePrDisplayState, prListStatus, prRecord, resolvePrDisplayState, type PrDisplayState } from './pr-presentation';

const pill = (lifecycle: string | null, mergedAt: unknown = null) => PR_PILL[derivePrDisplayState(lifecycle, mergedAt)];

describe('PR_PILL (the only PR pill vocabulary)', () => {
  // AC-6: #2010 regression — ci_green must not fall back to Open
  it('AC-6: ci_green renders as a CI badge, not Open', () => {
    expect(pill('ci_green').label).not.toBe('Open');
    expect(pill('ci_green').label.toLowerCase()).toContain('ci');
  });

  it('ci_failed and ci_running render as CI badges', () => {
    expect(pill('ci_failed').label.toLowerCase()).toContain('ci');
    expect(pill('ci_running').label.toLowerCase()).toContain('ci');
  });

  it('unknown or null status with a PR reads Open', () => {
    expect(pill('unknown_status').label).toBe('Open');
    expect(pill(null).label).toBe('Open');
  });

  it('merged reads Merged, and so does a merge stamp the lifecycle missed (the retired map ignored mergedAt)', () => {
    expect(pill('merged').label).toBe('Merged');
    expect(pill('ci_green', '2026-01-01T00:00:00Z').label).toBe('Merged');
  });

  it('an unresolvable PR does not render as Open', () => {
    expect(pill('unresolvable').label).not.toBe('Open');
  });
});

describe('resolvePrDisplayState (§17.5: the delivery owns a kernel PR)', () => {
  it('a kernel-owned delivery wins over the fact-cache columns', () => {
    expect(resolvePrDisplayState({ delivery: { prState: 'ci_failed' }, prLifecycleStatus: 'ci_green', mergedAt: null })).toBe('ci_failed');
    expect(resolvePrDisplayState({ delivery: { prState: 'awaiting_ci' }, prLifecycleStatus: 'merged', mergedAt: new Date() })).toBe('awaiting_ci');
  });

  it('no delivery (legacy or PR-less) keeps the column projection', () => {
    expect(resolvePrDisplayState({ delivery: null, prLifecycleStatus: 'ci_green', mergedAt: null })).toBe('ci_passed');
    expect(resolvePrDisplayState({ prLifecycleStatus: null, mergedAt: '2026-01-01' })).toBe('merged');
  });
});

// The one mapping from stored PR facts to a display state. Every surface
// (chat PR object, explain history, mission feed) projects from this.
describe('derivePrDisplayState', () => {
  // Every value of workers.prLifecycleStatus (packages/core/db/schema.ts), plus null.
  const TABLE: Array<[string | null, PrDisplayState]> = [
    [null, 'open'],
    ['pr_open', 'awaiting_ci'],
    ['ci_running', 'ci_running'],
    ['ci_green', 'ci_passed'],
    ['ci_failed', 'ci_failed'],
    ['conflict', 'conflict'],
    ['merged', 'merged'],
    ['closed', 'closed'],
    ['unresolvable', 'unresolvable'],
    ['something_new', 'open'],
  ];
  for (const [lifecycle, state] of TABLE) {
    it(`${lifecycle} -> ${state}`, () => {
      expect(derivePrDisplayState(lifecycle, null)).toBe(state);
    });
  }

  it('a merge stamp wins over any lifecycle value', () => {
    for (const [lifecycle] of TABLE) expect(derivePrDisplayState(lifecycle, new Date())).toBe('merged');
    expect(derivePrDisplayState(null, '2026-01-01T00:00:00Z')).toBe('merged');
  });
});

describe('Slice F: the API vocabulary reads the delivery for a kernel-owned PR', () => {
  const ALL: PrDisplayState[] = ['merged', 'closed', 'unresolvable', 'conflict', 'ci_failed', 'ci_running', 'ci_passed', 'awaiting_ci', 'open'];

  it('prListStatus is the inverse of derivePrDisplayState: list_prs speaks one vocabulary', () => {
    for (const s of ALL) expect(derivePrDisplayState(prListStatus(s), null)).toBe(s);
  });

  it('prRecord: a kernel-owned PR is merged only when the delivery says so, whatever the columns say', () => {
    const stale = { mergedAt: new Date('2026-01-01T00:00:00Z'), prLifecycleStatus: 'merged', supersededByPrNumber: 9, supersededByPrUrl: 'u9', supersededReason: 'old' };
    const open = prRecord({ ...stale, delivery: { state: 'AWAITING_REVIEW', mergedAt: null, supersededBy: null } });
    expect(open).toEqual({ merged: false, mergedAt: null, supersededBy: null });

    const merged = prRecord({ mergedAt: null, prLifecycleStatus: 'ci_failed', delivery: { state: 'MERGED', mergedAt: '2026-02-02T00:00:00.000Z', supersededBy: null } });
    expect(merged).toEqual({ merged: true, mergedAt: '2026-02-02T00:00:00.000Z', supersededBy: null });

    const superseded = prRecord({ delivery: { state: 'SUPERSEDED', mergedAt: null, supersededBy: { prNumber: 12, url: 'u12', reason: 'reopened' } } });
    expect(superseded.supersededBy).toEqual({ prNumber: 12, url: 'u12', reason: 'reopened' });
  });

  it('prRecord: a legacy PR keeps the fact-cache columns', () => {
    expect(prRecord({ mergedAt: null, prLifecycleStatus: 'merged' })).toEqual({ merged: true, mergedAt: null, supersededBy: null });
    expect(prRecord({ mergedAt: new Date('2026-03-03T00:00:00Z') }).mergedAt).toBe('2026-03-03T00:00:00.000Z');
    expect(prRecord({ supersededByPrNumber: 4, supersededByPrUrl: 'u4', supersededReason: 'r' }).supersededBy).toEqual({ prNumber: 4, url: 'u4', reason: 'r' });
    expect(prRecord({}).merged).toBe(false);
  });

  it('canonicalPrState: GitHub decides, the record fills a merge GitHub reported as a plain close', () => {
    expect(canonicalPrState({ githubMerged: true, githubClosed: true }, false)).toBe('merged');
    expect(canonicalPrState({ githubMerged: false, githubClosed: true }, true)).toBe('merged');
    expect(canonicalPrState({ githubMerged: false, githubClosed: true }, false)).toBe('closed_unmerged');
    // An open PR on GitHub is open, whatever a stale record says.
    expect(canonicalPrState({ githubMerged: false, githubClosed: false }, true)).toBe('open');
  });
});
