import { describe, it, expect } from 'bun:test';
import { PR_LIFECYCLE, derivePrLifecycle, derivePrDisplayState, type PrDisplayState } from './pr-presentation';

describe('PR_LIFECYCLE map', () => {
  // AC-3: ci_green must be in the map so it renders as a CI state, never as Open
  it('contains ci_green (AC-3)', () => {
    expect(PR_LIFECYCLE.ci_green).toBeDefined();
    expect(PR_LIFECYCLE.ci_green.label).not.toBe('Open');
  });

  it('ci_green label contains CI-related text', () => {
    expect(PR_LIFECYCLE.ci_green.label.toLowerCase()).toContain('ci');
  });

  it('all CI states (ci_running, ci_failed, ci_green) are present', () => {
    expect(PR_LIFECYCLE.ci_running).toBeDefined();
    expect(PR_LIFECYCLE.ci_failed).toBeDefined();
    expect(PR_LIFECYCLE.ci_green).toBeDefined();
  });
});

describe('derivePrLifecycle', () => {
  // AC-6: #2010 regression — ci_green must not fall back to Open
  it('AC-6: ci_green prLifecycleStatus renders as CI badge, not Open', () => {
    const result = derivePrLifecycle('ci_green', true);
    expect(result).not.toBeNull();
    expect(result?.label).not.toBe('Open');
    expect(result?.label.toLowerCase()).toContain('ci');
  });

  it('ci_failed renders as CI failing badge', () => {
    const result = derivePrLifecycle('ci_failed', true);
    expect(result?.label.toLowerCase()).toContain('ci');
  });

  it('ci_running renders as CI running badge', () => {
    const result = derivePrLifecycle('ci_running', true);
    expect(result?.label.toLowerCase()).toContain('ci');
  });

  it('unknown status with PR falls back to Open', () => {
    const result = derivePrLifecycle('unknown_status', true);
    expect(result?.label).toBe('Open');
  });

  it('null status with PR falls back to Open', () => {
    const result = derivePrLifecycle(null, true);
    expect(result?.label).toBe('Open');
  });

  it('null status with no PR returns null', () => {
    expect(derivePrLifecycle(null, false)).toBeNull();
  });

  it('merged renders correctly', () => {
    const result = derivePrLifecycle('merged', true);
    expect(result?.label).toBe('Merged');
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

describe('derivePrLifecycle: unresolvable', () => {
  it('an unresolvable PR does not render as Open', () => {
    expect(derivePrLifecycle('unresolvable', true)?.label).not.toBe('Open');
  });
});
