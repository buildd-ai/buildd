import { describe, it, expect } from 'bun:test';
import {
  calibrationBins,
  evaluateClaimRiskPolicy,
  holdAllPolicy,
  isHarmful,
  riskProfilePolicy,
  startUnlessHardPolicy,
  type ClaimRiskScenario,
} from '../orchestration-claim-risk-eval';
import { assessClaimOverlapRisk } from '../orchestration-claim-risk';
import { CLAIM_RISK_SCENARIOS } from './fixtures/claim-risk-scenarios';

/**
 * Replay of the labelled scenario set. These are the numbers a prompt or
 * threshold change must be compared on; the per-scenario routes are the
 * task's acceptance shapes.
 */

const byId = (id: string) => CLAIM_RISK_SCENARIOS.find(s => s.id === id)!;
const route = (id: string) => assessClaimOverlapRisk(byId(id).input);

describe('acceptance shapes replayed', () => {
  it('a stale mission refresh whose PR at head is disjoint does not block new work', () => {
    expect(route('stale-refresh-disjoint-at-head')).toMatchObject({ tier: 'no_effective_overlap', route: 'deterministic_start' });
  });

  it('a refresh diff from a moved head is not trusted: the model judges', () => {
    expect(route('stale-refresh-head-moved').route).toBe('ask_model');
  });

  it('same ordinary file, separate regions: low risk, judged by the model', () => {
    expect(route('same-file-separate-regions-probe-clean')).toMatchObject({ tier: 'low', route: 'ask_model' });
    expect(route('same-file-low-history')).toMatchObject({ tier: 'low', route: 'ask_model' });
  });

  it('a genuine collision is held in code with the conflict files named', () => {
    const a = route('same-file-probe-conflict');
    expect(a).toMatchObject({ tier: 'high', route: 'deterministic_hold' });
    expect(a.rationale).toContain('apps/web/src/lib/claim.ts');
  });

  it.each(['migration-index-collision', 'generated-file', 'live-lease', 'unknown-state'])('%s stays a hard hold', (id) => {
    expect(route(id)).toMatchObject({ tier: 'hard', route: 'deterministic_hold' });
  });

  it('a holder that never started no longer strands the candidate', () => {
    expect(route('holder-never-started').route).toBe('deterministic_start');
  });
});

describe('labelling rules', () => {
  it('a held pair is censored, never conflict-free', () => {
    expect(isHarmful('censored_held')).toBeNull();
  });

  it('a rebase or a structural merge is cost, not harm; a migration collision and a CI regression are harm', () => {
    expect(isHarmful('rebase_required')).toBe(false);
    expect(isHarmful('mergiraf_resolved')).toBe(false);
    expect(isHarmful('migration_index_collision')).toBe(true);
    expect(isHarmful('ci_semantic_regression')).toBe(true);
  });

  it('the shadow cohort shape (every decision held) scores nothing: no observed start, no false-hold rate', () => {
    const shadow = CLAIM_RISK_SCENARIOS.filter(s => s.shape === 'shadow_censored');
    const e = evaluateClaimRiskPolicy(shadow, holdAllPolicy);
    expect(e.observed).toBe(0);
    expect(e.censored).toBe(shadow.length);
    expect(e.unsafeStartRate).toBeNull();
    expect(e.preventableHoldRate).toBeNull();
  });
});

describe('policy comparison on the full set', () => {
  const holdAll = evaluateClaimRiskPolicy(CLAIM_RISK_SCENARIOS, holdAllPolicy);
  const startAll = evaluateClaimRiskPolicy(CLAIM_RISK_SCENARIOS, startUnlessHardPolicy);
  const profile = evaluateClaimRiskPolicy(CLAIM_RISK_SCENARIOS, riskProfilePolicy());

  it('censored pairs are counted the same under every policy and never scored', () => {
    const censored = CLAIM_RISK_SCENARIOS.filter(s => s.outcome === 'censored_held').length;
    for (const e of [holdAll, startAll, profile]) {
      expect(e.censored).toBe(censored);
      expect(e.observed + e.censored).toBe(CLAIM_RISK_SCENARIOS.length);
    }
  });

  it('hold-everything has no unsafe start and pays for it in preventable holds', () => {
    expect(holdAll.unsafeStarts).toBe(0);
    expect(holdAll.preventableHolds).toBeGreaterThan(0);
    expect(holdAll.cost.waitMinutes).toBeGreaterThan(0);
  });

  it('the risk profile (model fallback = HOLD) holds less than hold-everything and starts less unsafely than start-unless-hard', () => {
    expect(profile.preventableHolds).toBeLessThan(holdAll.preventableHolds);
    expect(profile.unsafeStarts).toBeLessThan(startAll.unsafeStarts);
    expect(profile.cost.totalMinutes).toBeLessThan(holdAll.cost.totalMinutes);
  });

  it('a clean merge that regresses CI is a start the profile cannot see: CI and review gates still own it', () => {
    const e = evaluateClaimRiskPolicy([byId('clean-merge-semantic-regression')], riskProfilePolicy());
    expect(e.unsafeStarts).toBe(1);
    expect(e.byOutcome).toEqual({ ci_semantic_regression: 1 });
  });

  it('frozen splits are scored independently', () => {
    const train = evaluateClaimRiskPolicy(CLAIM_RISK_SCENARIOS, riskProfilePolicy(), { split: 'train' });
    const heldout = evaluateClaimRiskPolicy(CLAIM_RISK_SCENARIOS, riskProfilePolicy(), { split: 'heldout' });
    expect(train.scenarios + heldout.scenarios).toBeLessThan(CLAIM_RISK_SCENARIOS.length);
    expect(train.scenarios).toBeGreaterThan(0);
    expect(heldout.scenarios).toBeGreaterThan(0);
  });
});

describe('replaying model answers', () => {
  it('a replayed answer with a probability yields Brier and calibration bins; ASK without an answer is abstention', () => {
    const replay = new Map<string, { action: 'START' | 'HOLD'; pHarm: number }>([
      ['same-file-separate-regions-probe-clean', { action: 'START', pHarm: 0.1 }],
      ['same-file-low-history', { action: 'START', pHarm: 0.2 }],
      ['same-file-no-history-conflicted', { action: 'HOLD', pHarm: 0.7 }],
    ]);
    const policy = riskProfilePolicy((s) => replay.get(s.id) ?? { action: 'ASK' });
    const e = evaluateClaimRiskPolicy(CLAIM_RISK_SCENARIOS, policy);
    expect(e.brier).not.toBeNull();
    expect(e.calibration.reduce((a, b) => a + b.n, 0)).toBe(3);
    expect(e.abstained).toBeGreaterThan(0);
  });

  it('calibrationBins puts p = 1 in the top bin', () => {
    const bins = calibrationBins([{ p: 1, y: true }, { p: 0, y: false }], 5);
    expect(bins[4].n).toBe(1);
    expect(bins[0].n).toBe(1);
  });

  it('a scenario set is plain data: replays are deterministic', () => {
    const run = () => evaluateClaimRiskPolicy(CLAIM_RISK_SCENARIOS as ClaimRiskScenario[], riskProfilePolicy());
    expect(run()).toEqual(run());
  });
});
