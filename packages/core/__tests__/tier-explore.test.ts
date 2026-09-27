import { describe, expect, it } from 'bun:test';
import {
  EMPTY_EVIDENCE,
  EXPLORE_POLICY,
  aggregateEvidence,
  armStage,
  enterExploreAllocation,
  exploreStep,
  popularityMean,
  projectOntoBounds,
  quantize,
  sameAllocation,
  seededRandom,
  splitGuardrails,
  stepSeedKey,
  stripPopularity,
  thompson,
  type ArmEvidence,
  type ExploreArmInput,
  type ExploreStepInput,
} from '../tier-explore';

const POOL = '6f1c3a52-9d0e-4b7a-8c11-2f5e7a9b0c3d';

function ev(graded: number, winRate: number, extra: Partial<ArmEvidence> = {}): ArmEvidence {
  return {
    graded,
    successes: graded * winRate,
    failures: graded * (1 - winRate),
    earlyCritical: 0,
    spread: { units: graded, conversations: graded, users: 10 },
    ...extra,
  };
}

function arm(id: string, role: 'incumbent' | 'challenger', evidence: ArmEvidence, over: Partial<ExploreArmInput> = {}): ExploreArmInput {
  return { id, role, model: id, ageDays: 30, evidence, popularity: null, succession: null, expiring: null, ...over };
}

function input(arms: ExploreArmInput[], current: Record<string, number>, over: Partial<ExploreStepInput> = {}): ExploreStepInput {
  return { poolId: POOL, surface: 'agent', date: '2026-09-27', policyVersion: 1, current, arms, gradingHealthy: true, ...over };
}

describe('seeded Thompson', () => {
  it('the same pool, policy version and date replay the same draws', () => {
    const a = seededRandom(stepSeedKey(POOL, 1, '2026-09-27'));
    const b = seededRandom(stepSeedKey(POOL, 1, '2026-09-27'));
    const xs = Array.from({ length: 5 }, () => a());
    expect(Array.from({ length: 5 }, () => b())).toEqual(xs);
  });

  it('a different date, pool or policy version draws differently', () => {
    const first = (k: string) => seededRandom(k)();
    const base = first(stepSeedKey(POOL, 1, '2026-09-27'));
    expect(first(stepSeedKey(POOL, 1, '2026-09-28'))).not.toBe(base);
    expect(first(stepSeedKey(POOL, 2, '2026-09-27'))).not.toBe(base);
    expect(first(stepSeedKey('other-pool', 1, '2026-09-27'))).not.toBe(base);
  });

  it('P(best) sums to 1 and favours the stronger posterior', () => {
    const r = thompson([{ alpha: 80, beta: 20 }, { alpha: 20, beta: 80 }], 2_000, seededRandom('x'));
    expect(r.pBest[0] + r.pBest[1]).toBeCloseTo(1, 9);
    expect(r.pBest[0]).toBeGreaterThan(0.99);
    expect(r.beats[0][1]).toBeGreaterThan(0.99);
  });

  it('a step replays byte for byte from its inputs', () => {
    const i = input([arm('inc', 'incumbent', ev(100, 0.7)), arm('ch', 'challenger', ev(70, 0.9))], { inc: 0.8, ch: 0.2 });
    expect(JSON.stringify(exploreStep(i))).toBe(JSON.stringify(exploreStep(i)));
  });
});

describe('stages', () => {
  it('learning until graded ≥ M, spread, 7 days and grading health', () => {
    const base = { role: 'challenger' as const, ageDays: 10 };
    expect(armStage({ ...base, evidence: ev(29, 1) }, 'agent', true)).toBe('learning');
    expect(armStage({ ...base, evidence: ev(30, 1) }, 'agent', true)).toBe(1);
    expect(armStage({ ...base, ageDays: 6, evidence: ev(30, 1) }, 'agent', true)).toBe('learning');
    expect(armStage({ ...base, evidence: ev(30, 1, { spread: { units: 4, conversations: 0, users: 0 } }) }, 'agent', true)).toBe('learning');
    expect(armStage({ ...base, evidence: ev(30, 1) }, 'agent', false)).toBe('learning');
    expect(armStage({ ...base, evidence: ev(50, 1, { spread: { units: 0, conversations: 10, users: 2 } }) }, 'chat', true)).toBe('learning');
  });

  it('stage steps at M, 2M and 4M', () => {
    const s = (g: number) => armStage({ role: 'challenger', ageDays: 30, evidence: ev(g, 1) }, 'agent', true);
    expect(s(59)).toBe(1);
    expect(s(60)).toBe(2);
    expect(s(119)).toBe(2);
    expect(s(120)).toBe(3);
  });
});

describe('projection and quantize', () => {
  it('clamps and renormalises onto the boxes', () => {
    const out = projectOntoBounds([0.1, 0.9], [{ lo: 0.2, hi: 1 }, { lo: 0.05, hi: 0.25 }]);
    expect(out[0]).toBeCloseTo(0.75, 9);
    expect(out[1]).toBeCloseTo(0.25, 9);
  });

  it('with a floor and a cap both binding, still sums to 1', () => {
    const out = projectOntoBounds([0.05, 0.05, 0.9], [{ lo: 0.2, hi: 1 }, { lo: 0.05, hi: 0.7 }, { lo: 0.05, hi: 0.25 }]);
    expect(out.reduce((s, v) => s + v, 0)).toBeCloseTo(1, 9);
    expect(out[2]).toBeCloseTo(0.25, 9);
    expect(out[0]).toBeCloseTo(0.375, 6);
  });

  it('quantizes to 0.05 by largest remainder with learning arms pinned', () => {
    expect(quantize([0.62, 0.28, 0.1], [null, null, 2])).toEqual([0.6, 0.3, 0.1]);
    // Ties go to the earlier arm.
    expect(quantize([0.475, 0.475, 0.05], [null, null, null])).toEqual([0.5, 0.45, 0.05]);
  });
});

describe('exploreStep', () => {
  it('a learning challenger holds exactly 10%, whatever its results', () => {
    const r = exploreStep(input([arm('inc', 'incumbent', ev(100, 0.5)), arm('ch', 'challenger', ev(10, 1))], { inc: 1, ch: 0 }));
    expect(r.allocation).toEqual({ inc: 0.9, ch: 0.1 });
    expect(r.write).toBe(true);
    expect(r.actorSystem).toBe('system:explore');
    expect(r.evidence.arms.ch.stage).toBe('learning');
  });

  it('writes nothing when the quantized result equals the current allocation', () => {
    const r = exploreStep(input([arm('inc', 'incumbent', ev(100, 0.5)), arm('ch', 'challenger', ev(10, 1))], { inc: 0.9, ch: 0.1 }));
    expect(r.write).toBe(false);
  });

  it('a strong stage-1 challenger moves at most its max step and stays under its stage cap', () => {
    const r = exploreStep(input([arm('inc', 'incumbent', ev(100, 0.5)), arm('ch', 'challenger', ev(40, 0.95))], { inc: 0.9, ch: 0.1 }));
    expect(r.evidence.arms.ch.stage).toBe(1);
    expect(r.allocation.ch).toBe(0.2);
    expect(r.allocation.inc).toBe(0.8);
    // Next day from 0.2: capped at the stage max 0.25.
    const r2 = exploreStep(input([arm('inc', 'incumbent', ev(100, 0.5)), arm('ch', 'challenger', ev(40, 0.95))], { inc: 0.8, ch: 0.2 }, { date: '2026-09-28' }));
    expect(r2.allocation.ch).toBe(0.25);
  });

  it('the incumbent keeps at least 20%', () => {
    const arms = [
      arm('inc', 'incumbent', ev(100, 0.1)),
      arm('a', 'challenger', ev(200, 0.99)),
      arm('b', 'challenger', ev(200, 0.98)),
    ];
    const r = exploreStep(input(arms, { inc: 0.2, a: 0.4, b: 0.4 }));
    expect(r.allocation.inc).toBeGreaterThanOrEqual(0.2);
    expect(Object.values(r.allocation).reduce((s, v) => s + v, 0)).toBeCloseTo(1, 9);
  });

  it('harm cut drops a challenger to 0 at once and names itself', () => {
    const r = exploreStep(input([arm('inc', 'incumbent', ev(100, 0.95)), arm('ch', 'challenger', ev(12, 0.1))], { inc: 0.9, ch: 0.1 }));
    expect(r.allocation).toEqual({ inc: 1, ch: 0 });
    expect(r.actorSystem).toBe('system:harm-cut');
    expect(r.causes).toContain('harm-cut');
  });

  it('two early critical grades cut even a learning challenger', () => {
    const r = exploreStep(input([arm('inc', 'incumbent', ev(100, 0.5)), arm('ch', 'challenger', ev(3, 0.5, { earlyCritical: 2 }))], { inc: 0.9, ch: 0.1 }));
    expect(r.allocation.ch).toBe(0);
  });

  it('an expiring arm steps down to 0 through the max-move limit', () => {
    const arms = [arm('inc', 'incumbent', ev(100, 0.5)), arm('ch', 'challenger', ev(40, 0.9), { expiring: { expiresAt: '2026-10-05T00:00:00.000Z' } })];
    const r = exploreStep(input(arms, { inc: 0.75, ch: 0.25 }));
    expect(r.allocation.ch).toBe(0.15);
    expect(r.actorSystem).toBe('system:expiry');
  });

  it('succession decay lowers an old challenger\'s cap and is the attributed cause', () => {
    const arms = [
      arm('inc', 'incumbent', ev(100, 0.5)),
      arm('old', 'challenger', ev(40, 0.95), { succession: { successorArmId: 'new', multiplier: 0.25, held: false } }),
      arm('new', 'challenger', ev(5, 0.9)),
    ];
    const r = exploreStep(input(arms, { inc: 0.65, old: 0.25, new: 0.1 }));
    expect(r.evidence.arms.old.capBefore).toBe(0.25);
    expect(r.evidence.arms.old.capAfter).toBe(0.0625);
    // Decay is never faster than the stage's max step: 0.25 → 0.15.
    expect(r.allocation.old).toBe(0.15);
    expect(r.causes).toContain('succession');
    expect(r.actorSystem).toBe('system:succession');
  });

  it('a challenger whose decay multiplier falls below 0.1 gets a removal suggestion', () => {
    const arms = [
      arm('inc', 'incumbent', ev(100, 0.5)),
      arm('old', 'challenger', ev(40, 0.5), { succession: { successorArmId: 'new', multiplier: 0.09, held: false } }),
      arm('new', 'challenger', ev(5, 0.9)),
    ];
    const r = exploreStep(input(arms, { inc: 0.85, old: 0.05, new: 0.1 }));
    expect(r.suggestions).toEqual([{ key: 'succession-remove:old:new', action: 'remove', armId: 'old', signal: 'succession' }]);
  });

  it('decay freezes once both arms are past learning and the old arm clearly beats its successor', () => {
    const arms = [
      arm('inc', 'incumbent', ev(100, 0.5)),
      arm('old', 'challenger', ev(100, 0.95), { succession: { successorArmId: 'new', multiplier: 0.6, held: false } }),
      arm('new', 'challenger', ev(40, 0.4)),
    ];
    const r = exploreStep(input(arms, { inc: 0.6, old: 0.25, new: 0.15 }));
    expect(r.holds).toEqual({ old: 0.6 });
    expect(r.evidence.signals.some(s => s.kind === 'succession_held')).toBe(true);
  });

  it('popularity never triggers a change on its own', () => {
    // Three evenly matched arms with little evidence: popularity alone tips
    // the target, but the current allocation is what evidence alone gives.
    const pop = (p: number) => ({ m: popularityMean(p), views: ['tool_calling'], asOf: '2026-09-26' });
    const arms = [
      arm('inc', 'incumbent', ev(2, 0.5), { popularity: pop(0) }),
      arm('a', 'challenger', ev(120, 0.5, { successes: 1, failures: 1 }), { popularity: pop(1) }),
    ];
    const noPop = exploreStep(input(arms.map(a => ({ ...a, popularity: null })), { inc: 0.5, a: 0.5 }));
    const withPop = exploreStep(input(arms, noPop.allocation));
    const fromScratch = exploreStep(input(arms, { inc: 0.5, a: 0.5 }));
    expect(sameAllocation(fromScratch.allocation, noPop.allocation)).toBe(false);
    expect(withPop.write).toBe(false);
  });

  it('records the per-arm popularity prior for replay', () => {
    const arms = [
      arm('inc', 'incumbent', ev(100, 0.5)),
      arm('ch', 'challenger', ev(5, 0.5), { popularity: { m: 0.55, views: ['tool_calling', 'programming'], asOf: '2026-09-26' } }),
    ];
    const r = exploreStep(input(arms, { inc: 1, ch: 0 }));
    expect(r.evidence.arms.ch.prior).toEqual({ signal: 'popularity', views: ['tool_calling', 'programming'], asOf: '2026-09-26', m: 0.55 });
    expect(r.evidence.arms.ch.alpha).toBeCloseTo(1 + 2.5 + 4 * 0.55, 4);
    expect(r.evidence.policy).toBe('explore-v1');
    expect(r.evidence.seed).toBe(`${POOL}:1:2026-09-27`);
  });
});

describe('popularity prior', () => {
  it('m spans [0.45, 0.55], at most 0.4 pseudo-successes apart over 4 units', () => {
    expect(popularityMean(1)).toBeCloseTo(0.55, 9);
    expect(popularityMean(0)).toBeCloseTo(0.45, 9);
    expect(popularityMean(0.5)).toBeCloseTo(0.5, 9);
    expect(EXPLORE_POLICY.popularityUnits * (popularityMean(1) - popularityMean(0))).toBeCloseTo(0.4, 9);
  });
});

describe('enterExploreAllocation', () => {
  it('projects a split onto stage bounds: learning arms to 10%, the incumbent at least 20%', () => {
    const out = enterExploreAllocation({
      surface: 'agent', gradingHealthy: true, current: { inc: 0.5, a: 0.5, b: 0 },
      arms: [
        { id: 'inc', role: 'incumbent', ageDays: 90, evidence: EMPTY_EVIDENCE },
        { id: 'a', role: 'challenger', ageDays: 30, evidence: ev(40, 0.8) },
        { id: 'b', role: 'challenger', ageDays: 1, evidence: EMPTY_EVIDENCE },
      ],
    });
    expect(out).toEqual({ inc: 0.65, a: 0.25, b: 0.1 });
  });
});

describe('splitGuardrails', () => {
  const base = { poolId: POOL, surface: 'agent' as const, date: '2026-09-27', policyVersion: 1 };

  it('does nothing for a healthy split', () => {
    expect(splitGuardrails({ ...base, current: { inc: 0.5, ch: 0.5 }, arms: [
      { id: 'inc', role: 'incumbent', evidence: ev(50, 0.5), expired: false },
      { id: 'ch', role: 'challenger', evidence: ev(50, 0.5), expired: false },
    ] })).toBeNull();
  });

  it('a harm cut moves the arm\'s share onto the incumbent', () => {
    const r = splitGuardrails({ ...base, current: { inc: 0.5, ch: 0.5 }, arms: [
      { id: 'inc', role: 'incumbent', evidence: ev(50, 0.95), expired: false },
      { id: 'ch', role: 'challenger', evidence: ev(20, 0.1), expired: false },
    ] });
    expect(r?.allocation).toEqual({ inc: 1, ch: 0 });
    expect(r?.actorSystem).toBe('system:harm-cut');
  });

  it('an expired model goes to 0 as system:expiry', () => {
    const r = splitGuardrails({ ...base, current: { inc: 0.75, ch: 0.25 }, arms: [
      { id: 'inc', role: 'incumbent', evidence: ev(50, 0.5), expired: false },
      { id: 'ch', role: 'challenger', evidence: ev(5, 0.5), expired: true },
    ] });
    expect(r?.allocation).toEqual({ inc: 1, ch: 0 });
    expect(r?.actorSystem).toBe('system:expiry');
  });
});

describe('aggregateEvidence', () => {
  it('weights graded units by q, skips ungraded ones, and counts spread', () => {
    const e = aggregateEvidence([
      { severity: 'none', unitId: 'm1', conversationId: null, userId: null },
      { severity: 'minor', unitId: 'm1', conversationId: null, userId: null },
      { severity: null, unitId: 'm2', conversationId: null, userId: null },
      { severity: 'critical', unitId: 'm3', conversationId: null, userId: null },
    ]);
    expect(e).toEqual({ graded: 3, successes: 1.75, failures: 1.25, earlyCritical: 1, spread: { units: 2, conversations: 0, users: 0 } });
  });
});

describe('stripPopularity', () => {
  it('removes priors, popularity signals and causes', () => {
    const out = stripPopularity({
      arms: { a: { stage: 1, prior: { signal: 'popularity', m: 0.55 } } },
      signals: [{ kind: 'popularity', armId: 'a' }, { kind: 'expiry', armId: 'a' }],
      causes: ['popularity', 'expiry'],
    });
    expect(out).toEqual({ arms: { a: { stage: 1 } }, signals: [{ kind: 'expiry', armId: 'a' }], causes: ['expiry'] });
  });
});
