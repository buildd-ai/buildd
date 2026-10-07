import { describe, it, expect } from 'bun:test';
import { PR_PILL, derivePrDisplayState, resolvePrDisplayState, type PrDisplayState } from './pr-presentation';

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
