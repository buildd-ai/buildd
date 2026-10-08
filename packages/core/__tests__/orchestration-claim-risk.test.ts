import { describe, it, expect } from 'bun:test';
import {
  HIGH_CONFLICT_LOWER_BOUND,
  MIN_FILE_HISTORY_SAMPLE,
  assessClaimOverlapRisk,
  claimRiskForModel,
  effectiveScopeIsCurrent,
  holderStateOf,
  judgeFileHistory,
  wilsonInterval,
  type ClaimRiskInput,
} from '../orchestration-claim-risk';
import { LIVE_HOLDER_STATUSES, summarizeFileConflictHistory } from '../orchestration-claim-decision';

/**
 * Claim-time risk profile: which overlap deferrals code decides and which
 * reach the model. Every case here is one acceptance shape from the task.
 */

const NOW = '2026-10-01T12:00:00.000Z';
const minutesAgo = (m: number) => new Date(Date.parse(NOW) - m * 60_000).toISOString();

const soft = (over: Partial<ClaimRiskInput> = {}): ClaimRiskInput => ({
  gate: 'soft_overlap',
  rail: null,
  overlapKind: 'same_file',
  candidatePaths: ['apps/web/src/lib/x.ts'],
  overlapPaths: ['apps/web/src/lib/x.ts'],
  holderState: 'live',
  now: NOW,
  ...over,
});

describe('wilsonInterval', () => {
  it('is null with no trials and brackets the point rate otherwise', () => {
    expect(wilsonInterval(0, 0)).toBeNull();
    const ci = wilsonInterval(2, 10)!;
    expect(ci.lower).toBeLessThan(0.2);
    expect(ci.upper).toBeGreaterThan(0.2);
  });

  it('one conflict in one merged PR is not a proven 100% rate', () => {
    const ci = wilsonInterval(1, 1)!;
    expect(ci.lower).toBeLessThan(HIGH_CONFLICT_LOWER_BOUND);
  });
});

describe('judgeFileHistory: intervals, not point rates', () => {
  const h = (counts: Array<[string, number, number]>) =>
    summarizeFileConflictHistory(counts.map(c => c[0]), counts.map(([path, mergedPrs, conflicted]) => ({ path, mergedPrs, conflicted })));

  it('no history is missing, not high', () => {
    expect(judgeFileHistory(h([['a.ts', 0, 0]]))).toBe('missing');
    expect(judgeFileHistory(null)).toBe('missing');
  });

  it('a tiny sample is insufficient either way', () => {
    expect(judgeFileHistory(h([['a.ts', 1, 1]]))).toBe('insufficient');
    expect(judgeFileHistory(h([['a.ts', 2, 0]]))).toBe('insufficient');
  });

  it('a sample whose lower bound clears the cap is high', () => {
    expect(judgeFileHistory(h([['a.ts', 10, 7]]))).toBe('high');
  });

  it('low needs every shared file sampled with a low upper bound', () => {
    expect(judgeFileHistory(h([['a.ts', 40, 1]]))).toBe('low');
    // One unsampled file can be the hot one.
    expect(judgeFileHistory(h([['a.ts', 40, 1], ['b.ts', 0, 0]]))).toBe('insufficient');
    expect(MIN_FILE_HISTORY_SAMPLE).toBeGreaterThan(1);
  });

  it('summarizeFileConflictHistory reports the interval-based summary and each file interval', () => {
    const s = h([['a.ts', 40, 1]]);
    expect(s.summary).toBe('low');
    expect(s.files[0].ci).toEqual(wilsonInterval(1, 40));
  });
});

describe('assessClaimOverlapRisk: hard rails always hold', () => {
  it.each(['live_lease', 'migration', 'serialized_surface', 'state_unresolved', 'live_holder'] as const)('%s is hard and deterministic', (rail) => {
    const a = assessClaimOverlapRisk(soft({ rail, holderState: 'not_started', overlapKind: 'prefix' }));
    expect(a.tier).toBe('hard');
    expect(a.route).toBe('deterministic_hold');
    expect(a.reasons[0]).toBe('hard_rail');
  });

  it('a hard rail wins over a clean probe and a disjoint effective scope', () => {
    const a = assessClaimOverlapRisk(soft({
      rail: 'migration',
      probe: { outcome: 'clean', conflictFiles: [], probedAt: minutesAgo(1), headsCurrent: true },
      holderScope: { source: 'live_lease', paths: ['other.ts'], observedAt: minutesAgo(1) },
    }));
    expect(a.tier).toBe('hard');
  });
});

describe('assessClaimOverlapRisk: deterministic STARTs', () => {
  it('a holder that never started has no edits to collide with', () => {
    const a = assessClaimOverlapRisk(soft({ holderState: 'not_started' }));
    expect(a).toMatchObject({ tier: 'no_effective_overlap', route: 'deterministic_start', reasons: ['holder_not_started'] });
  });

  it('an inherited declaration with a disjoint current PR diff at head starts', () => {
    const a = assessClaimOverlapRisk(soft({
      holderState: 'ended',
      holderScope: { source: 'pr_diff_at_head', paths: ['apps/web/src/other.ts'], headSha: 'abc', currentHeadSha: 'abc', observedAt: minutesAgo(5) },
    }));
    expect(a).toMatchObject({ tier: 'no_effective_overlap', route: 'deterministic_start', reasons: ['effective_scope_disjoint'] });
    expect(a.evidence).toEqual({ source: 'effective_scope', ageMinutes: 5 });
  });

  it('a directory-only overlap starts', () => {
    const a = assessClaimOverlapRisk(soft({ overlapKind: 'prefix', overlapPaths: ['apps/web/src/lib'] }));
    expect(a.tier).toBe('low');
    expect(a.route).toBe('deterministic_start');
    expect(a.reasons[0]).toBe('prefix_only');
  });

  it('the scope-undeclared gate never starts in code: the candidate leases nothing up front', () => {
    const a = assessClaimOverlapRisk({ gate: 'advisory_manifest', rail: null, candidatePaths: [], overlapPaths: [], holderState: 'not_started', now: NOW });
    expect(a.route).toBe('ask_model');
    expect(a.tier).toBe('uncertain');
  });
});

describe('assessClaimOverlapRisk: stale evidence is missing evidence', () => {
  it('a PR diff from an older head is not used', () => {
    const scope = { source: 'pr_diff_at_head' as const, paths: ['other.ts'], headSha: 'old', currentHeadSha: 'new', observedAt: minutesAgo(1) };
    expect(effectiveScopeIsCurrent(scope, NOW)).toBe(false);
    const a = assessClaimOverlapRisk(soft({ holderScope: scope }));
    expect(a.route).toBe('ask_model');
    expect(a.reasons).toContain('effective_scope_stale');
  });

  it('a PR diff with no head recorded is not used', () => {
    expect(effectiveScopeIsCurrent({ source: 'pr_diff_at_head', paths: [], observedAt: minutesAgo(1) }, NOW)).toBe(false);
  });

  it('an old effective scope is not used', () => {
    expect(effectiveScopeIsCurrent({ source: 'live_lease', paths: [], observedAt: minutesAgo(120) }, NOW)).toBe(false);
  });

  it('an old or moved-head probe is not used', () => {
    const a = assessClaimOverlapRisk(soft({ probe: { outcome: 'conflict', conflictFiles: ['x.ts'], probedAt: minutesAgo(5), headsCurrent: false } }));
    expect(a.tier).not.toBe('high');
    expect(a.reasons).toContain('probe_stale');
  });
});

describe('assessClaimOverlapRisk: same-file overlaps', () => {
  it('a fresh probe conflict is high and held in code, naming the files', () => {
    const a = assessClaimOverlapRisk(soft({ probe: { outcome: 'conflict', conflictFiles: ['apps/web/src/lib/x.ts'], probedAt: minutesAgo(3), headsCurrent: true } }));
    expect(a).toMatchObject({ tier: 'high', route: 'deterministic_hold' });
    expect(a.rationale).toContain('apps/web/src/lib/x.ts');
  });

  it('a fresh clean or Mergiraf-resolved probe is low, and the model still judges intent', () => {
    for (const outcome of ['clean', 'mergiraf_resolved'] as const) {
      const a = assessClaimOverlapRisk(soft({ probe: { outcome, conflictFiles: [], probedAt: minutesAgo(3), headsCurrent: true } }));
      expect(a.tier).toBe('low');
      expect(a.route).toBe('ask_model');
    }
  });

  it('a probe error carries no evidence', () => {
    const a = assessClaimOverlapRisk(soft({ probe: { outcome: 'error', conflictFiles: [], probedAt: minutesAgo(3), headsCurrent: true } }));
    expect(a.tier).toBe('uncertain');
  });

  it('measured high history is held in code', () => {
    const history = summarizeFileConflictHistory(['apps/web/src/lib/x.ts'], [{ path: 'apps/web/src/lib/x.ts', mergedPrs: 10, conflicted: 7 }]);
    expect(assessClaimOverlapRisk(soft({ history }))).toMatchObject({ tier: 'high', route: 'deterministic_hold' });
  });

  it('measured low history is low, judged by the model', () => {
    const history = summarizeFileConflictHistory(['apps/web/src/lib/x.ts'], [{ path: 'apps/web/src/lib/x.ts', mergedPrs: 40, conflicted: 1 }]);
    expect(assessClaimOverlapRisk(soft({ history }))).toMatchObject({ tier: 'low', route: 'ask_model' });
  });

  it('missing history is uncertain, never high', () => {
    const a = assessClaimOverlapRisk(soft());
    expect(a).toMatchObject({ tier: 'uncertain', route: 'ask_model' });
    expect(a.reasons).toEqual(['same_file', 'history_missing']);
  });

  it('measured high history also holds a directory-only overlap', () => {
    const history = summarizeFileConflictHistory(['apps/web/src/lib/x.ts'], [{ path: 'apps/web/src/lib/x.ts', mergedPrs: 10, conflicted: 8 }]);
    expect(assessClaimOverlapRisk(soft({ overlapKind: 'prefix', history })).tier).toBe('high');
  });
});

describe('open PR overlap without an effective scope', () => {
  it('is uncertain and asks the model', () => {
    const a = assessClaimOverlapRisk({ gate: 'open_pr_overlap', rail: null, candidatePaths: ['a.ts'], overlapPaths: ['a.ts'], holderState: 'ended', now: NOW });
    expect(a).toMatchObject({ tier: 'uncertain', route: 'ask_model' });
    expect(a.reasons[0]).toBe('open_pr_scope_unknown');
  });
});

describe('model-facing block and holder state', () => {
  it('the model sees only the tier and short reasons, never the rationale prose', () => {
    const a = assessClaimOverlapRisk(soft());
    expect(claimRiskForModel(a)).toEqual({ tier: 'uncertain', reasons: ['same_file', 'history_missing'] });
  });

  it('holderStateOf: no worker is not started; a live status is live; anything else ended', () => {
    expect(holderStateOf(null, LIVE_HOLDER_STATUSES)).toBe('not_started');
    expect(holderStateOf('running', LIVE_HOLDER_STATUSES)).toBe('live');
    expect(holderStateOf('completed', LIVE_HOLDER_STATUSES)).toBe('ended');
  });
});
