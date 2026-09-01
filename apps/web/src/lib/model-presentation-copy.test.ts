/**
 * The wording the Health page uses to qualify every model number.
 *
 * These are tested rather than inlined in the JSX because the claims are the
 * feature: a divergence percentage without its `n of m` is unreadable, and a
 * silently empty "By model" block on seat auth is indistinguishable from
 * "nothing ran".
 */

import { describe, test, expect } from 'bun:test';
import { derivedUnavailable, derivedValue } from '@buildd/core/derived-metric';
import type { ModelDivergence, ScanBounds } from './usage-stats';
import { byModelAbsence, divergenceSummary, scanCaveat } from './model-presentation';

const scan = (over: Partial<ScanBounds> = {}): ScanBounds => ({
  rows: 120,
  limit: 5000,
  truncated: false,
  completeSince: '2026-08-01T00:00:00.000Z',
  ...over,
});

describe('divergenceSummary', () => {
  test('prints the denominator and the exclusions, not just a percentage', () => {
    const s = divergenceSummary(derivedValue<ModelDivergence>({
      workers: 10, compared: 8, diverged: 2, rate: 0.25, unattributed: 2,
    }));
    expect(s.headline).toBe('25%');
    expect(s.note).toContain('2 of 8 workers');
    expect(s.note).toContain('2 excluded');
  });

  test('says so when every worker was comparable', () => {
    const s = divergenceSummary(derivedValue<ModelDivergence>({
      workers: 4, compared: 4, diverged: 0, rate: 0, unattributed: 0,
    }));
    expect(s.headline).toBe('0%');
    expect(s.note).toBe('0 of 4 workers · all comparable');
  });

  test('an unavailable metric is an em-dash with the reason, never 0%', () => {
    const s = divergenceSummary(derivedUnavailable<ModelDivergence>('no_scope', 'No comparable worker: all 3 of 3 lack an assigned model'));
    expect(s.headline).toBe('—');
    expect(s.headline).not.toContain('0');
    expect(s.note).toContain('all 3 of 3');
  });

  test('falls back to the reason code when there is no detail', () => {
    const s = divergenceSummary(derivedUnavailable<ModelDivergence>('no_scope'));
    expect(s.note).toBe('no_scope');
  });
});

describe('byModelAbsence', () => {
  test('names seat/OAuth auth when tokens were spent but nothing was attributed', () => {
    expect(byModelAbsence(1_000_000)).toContain('seat-based (OAuth) auth');
  });

  test('an empty window is not blamed on auth', () => {
    expect(byModelAbsence(0)).toBe('No tokens recorded in this window');
  });
});

describe('scanCaveat', () => {
  test('silent when the scan covered the whole window', () => {
    expect(scanCaveat(scan(), '30d ago')).toBeNull();
  });

  test('states the cap and how far back the numbers are actually complete', () => {
    const note = scanCaveat(scan({ rows: 5000, truncated: true }), '2d ago');
    expect(note).toContain('5,000');
    expect(note).toContain('2d ago');
  });
});
