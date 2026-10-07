/**
 * The trunk circuit breaker's pure pieces (docs/specs/workflow-state-kernel.md
 * §6.10, S24): policy, signatures, and what counts as "the trunk explains it".
 * The live path (incident rows, T25/T26, one trunk-fix task) runs on real
 * Postgres in apps/web/tests/db/workflow-matrix.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { checkRunsSummary } from './github-facts';
import {
  DEFAULT_TRUNK_WINDOW_MINUTES, UNKNOWN_CI_SIGNATURE, ciSignature, signatureChecks, trunkBreakerConfig, trunkExplains, trunkRecovered,
} from './trunk';
import { trunkFixDescription, trunkFixTitle } from './trunk-effects';

describe('trunkBreakerConfig', () => {
  test('absent = on with the base-red rule only; false turns it off; the multi-delivery rule is opt-in', () => {
    expect(trunkBreakerConfig(null)).toEqual({ enabled: true, minDeliveries: null, windowMinutes: DEFAULT_TRUNK_WINDOW_MINUTES });
    expect(trunkBreakerConfig({ trunkBreaker: false }).enabled).toBe(false);
    expect(trunkBreakerConfig({ trunkBreaker: 'off' }).enabled).toBe(false);
    expect(trunkBreakerConfig({ trunkBreaker: { minDeliveries: 3, windowMinutes: 30 } })).toEqual({ enabled: true, minDeliveries: 3, windowMinutes: 30 });
    // One delivery is never a trunk: a threshold below 2 is ignored.
    expect(trunkBreakerConfig({ trunkBreaker: { minDeliveries: 1 } }).minDeliveries).toBeNull();
  });
});

describe('signatures', () => {
  test('sorted, normalised, deduplicated failing check names; nothing readable is the placeholder', () => {
    expect(ciSignature(['Unit tests (shard 2/4)', 'Lint', 'Unit tests (shard 3/4)'])).toBe('ci:lint|unit tests (shard <n>/<n>)');
    expect(ciSignature([])).toBe(UNKNOWN_CI_SIGNATURE);
    expect(signatureChecks('ci:a|b')).toEqual(['a', 'b']);
    expect(signatureChecks(UNKNOWN_CI_SIGNATURE)).toEqual([]);
  });

  test('the trunk explains a failure only when every failing PR check also fails on the base', () => {
    expect(trunkExplains('ci:unit', 'ci:lint|unit')).toBe(true);
    expect(trunkExplains('ci:lint|unit', 'ci:unit')).toBe(false); // the PR has its own failure too
    expect(trunkExplains(UNKNOWN_CI_SIGNATURE, 'ci:unit')).toBe(false); // unknown is never the trunk's
    expect(trunkExplains('ci:unit', UNKNOWN_CI_SIGNATURE)).toBe(false);
  });

  test('recovered when none of the incident checks fails on the base any more', () => {
    expect(trunkRecovered('ci:unit', [])).toBe(true);
    expect(trunkRecovered('ci:unit', ['Lint'])).toBe(true);
    expect(trunkRecovered('ci:lint|unit', ['Unit'])).toBe(false);
  });
});

describe('checkRunsSummary', () => {
  test('failing completed runs by name; incomplete when any run is still going; no runs is unknown', () => {
    expect(checkRunsSummary([{ name: 'unit', status: 'completed', conclusion: 'failure' }, { name: 'lint', status: 'completed', conclusion: 'success' }]))
      .toEqual({ complete: true, failing: ['unit'] });
    expect(checkRunsSummary([{ name: 'unit', status: 'in_progress', conclusion: null }])).toEqual({ complete: false, failing: [] });
    expect(checkRunsSummary([])).toBeNull();
  });
});

describe('the trunk-fix task', () => {
  test('names the base and the failing checks, and the PRs it unblocks', () => {
    expect(trunkFixTitle('dev', 'ci:lint|unit')).toBe('fix(ci): dev is red — lint, unit');
    const d = trunkFixDescription({ repoFullName: 'acme/x', baseRef: 'dev', baseHeadSha: 'abcdef1234567890', signature: 'ci:unit', prNumbers: [7, 8] });
    expect(d).toContain('`abcdef123456`');
    expect(d).toContain('- unit');
    expect(d).toContain('#7, #8');
  });
});
