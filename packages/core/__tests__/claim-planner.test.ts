import { describe, expect, it } from 'bun:test';
import {
  DAILY_BUDGET_DOWNGRADE_FRACTION,
  overlapFraction,
  overlapPairKey,
  planClaimBatch,
  starvationBucket,
  type ClaimPlanInput,
  type PlannerCandidate,
  type PlannerInFlight,
  type PlannerThresholds,
} from '../claim-planner';
import { pathsOverlap } from '../path-overlap';

const T0 = Date.parse('2026-01-01T00:00:00Z');

function cand(id: string, over: Partial<PlannerCandidate> = {}): PlannerCandidate {
  return {
    id,
    priority: 0,
    createdAt: T0,
    missionId: 'm1',
    declaredScope: null,
    predictedScope: null,
    setConfidence: null,
    expectedSize: null,
    dependentCount: 0,
    ...over,
  };
}

function flight(id: string, over: Partial<PlannerInFlight> = {}): PlannerInFlight {
  return { id, kind: 'worker', missionId: 'm1', declaredScope: null, ...over };
}

const THRESHOLDS: PlannerThresholds = { thetaOrder: 0.3, thetaSoft: 0.5, thetaIdle: 0.8 };

function input(over: Partial<ClaimPlanInput>): ClaimPlanInput {
  return { candidates: [], inFlight: [], capacity: 3, pressure: null, thresholds: THRESHOLDS, ...over };
}

const picks = (r: ReturnType<typeof planClaimBatch>) => r.picks.map(p => p.id);

describe('planClaimBatch — hard edges', () => {
  it('two overlapping concrete tasks: the open-PR side is the blocker, whatever the score', () => {
    const r = planClaimBatch(input({
      candidates: [
        cand('a', { priority: 5, declaredScope: ['packages/core/foo.ts'] }),
        cand('b', { priority: 0, declaredScope: ['packages/core/foo.ts', 'packages/core/bar.ts'], hasOpenPr: true }),
      ],
    }));
    expect(picks(r)).toEqual(['b']);
    expect(r.orientation).toEqual([
      expect.objectContaining({ taskId: 'a', blockedBy: 'b', reason: 'open_pr', edge: 'path_overlap' }),
    ]);
  });

  it('two overlapping concrete tasks without a PR: the higher score goes first', () => {
    const r = planClaimBatch(input({
      candidates: [
        cand('a', { priority: 0, declaredScope: ['apps/web/src/lib'] }),
        cand('b', { priority: 2, declaredScope: ['apps/web/src/lib/x.ts'] }),
      ],
    }));
    expect(picks(r)).toEqual(['b']);
    expect(r.orientation).toEqual([
      expect.objectContaining({ taskId: 'a', blockedBy: 'b', reason: 'higher_score', edge: 'path_overlap' }),
    ]);
  });

  it('an in-flight open PR beats an in-flight worker as the named blocker', () => {
    const r = planClaimBatch(input({
      candidates: [cand('a', { declaredScope: ['a.ts'] })],
      inFlight: [
        flight('w1', { kind: 'worker', declaredScope: ['a.ts'] }),
        flight('pr1', { kind: 'open_pr', declaredScope: ['a.ts'] }),
      ],
    }));
    expect(picks(r)).toEqual([]);
    expect(r.orientation[0]).toMatchObject({ taskId: 'a', blockedBy: 'pr1', reason: 'open_pr', edge: 'open_pr_overlap' });
  });

  it('a live lease blocks with lease_overlap', () => {
    const r = planClaimBatch(input({
      candidates: [cand('a', { declaredScope: ['a.ts'] })],
      inFlight: [flight('l1', { kind: 'lease', declaredScope: ['a.ts'] })],
    }));
    expect(r.orientation[0]).toMatchObject({ blockedBy: 'l1', reason: 'in_flight', edge: 'lease_overlap' });
  });

  it('a candidate is never blocked by in-flight rows it owns', () => {
    const r = planClaimBatch(input({
      candidates: [cand('a', { declaredScope: ['a.ts'], hasOpenPr: true })],
      inFlight: [flight('pr-a', { kind: 'open_pr', taskId: 'a', declaredScope: ['a.ts'] })],
    }));
    expect(picks(r)).toEqual(['a']);
  });

  it('the same serialized surface is a hard edge even with disjoint paths', () => {
    const r = planClaimBatch(input({
      candidates: [
        cand('a', { priority: 1, declaredScope: ['x.ts'], serializedSurfaces: ['migrations'] }),
        cand('b', { declaredScope: ['y.ts'], serializedSurfaces: ['migrations'] }),
      ],
    }));
    expect(picks(r)).toEqual(['a']);
    expect(r.orientation[0]).toMatchObject({ taskId: 'b', blockedBy: 'a', edge: 'serialized_surface' });
  });

  it('an unresolved dependsOn orders the dependent behind its upstream regardless of score', () => {
    const r = planClaimBatch(input({
      candidates: [
        cand('up', { priority: 0, declaredScope: ['u.ts'] }),
        cand('down', { priority: 9, declaredScope: ['d.ts'], dependsOn: ['up'] }),
      ],
    }));
    expect(picks(r)).toEqual(['up']);
    expect(r.orientation[0]).toMatchObject({ taskId: 'down', blockedBy: 'up', reason: 'depends_on', edge: 'depends_on' });
  });

  it('no-scope nodes in one mission keep the mutex; other missions and file-less tasks are free', () => {
    const r = planClaimBatch(input({
      capacity: 5,
      candidates: [
        cand('a', { priority: 2 }),
        cand('b', { priority: 1 }),
        cand('c', { missionId: 'm2' }),
        cand('d', { editsFiles: false }),
      ],
    }));
    expect(picks(r).sort()).toEqual(['a', 'c', 'd']);
    expect(r.orientation).toEqual([expect.objectContaining({ taskId: 'b', blockedBy: 'a', edge: 'no_scope_mutex' })]);
  });

  it('the no-scope mutex holds against an in-flight no-scope worker in the mission', () => {
    const r = planClaimBatch(input({
      candidates: [cand('a')],
      inFlight: [flight('w1', { kind: 'worker' })],
    }));
    expect(picks(r)).toEqual([]);
    expect(r.orientation[0]).toMatchObject({ blockedBy: 'w1', edge: 'no_scope_mutex' });
  });

  it('the repo-wide sentinel is advisory, never a concrete overlap', () => {
    const r = planClaimBatch(input({
      candidates: [
        cand('a', { declaredScope: ['**'], missionId: 'm1' }),
        cand('b', { declaredScope: ['x.ts'], missionId: 'm1' }),
      ],
    }));
    expect(picks(r).sort()).toEqual(['a', 'b']);
  });
});

describe('planClaimBatch — soft edges', () => {
  it('a low-confidence prediction never blocks', () => {
    const r = planClaimBatch(input({
      candidates: [
        cand('a', { priority: 1, declaredScope: ['x.ts'] }),
        cand('b', { predictedScope: ['x.ts'], setConfidence: 0.1 }),
      ],
    }));
    expect(picks(r).sort()).toEqual(['a', 'b']);
    expect(r.orientation).toEqual([]);
  });

  it('a confident predicted overlap orders the node behind, but never as a hard edge', () => {
    const r = planClaimBatch(input({
      capacity: 1,
      candidates: [
        cand('a', { priority: 1, declaredScope: ['x.ts'] }),
        cand('b', { predictedScope: ['x.ts'], setConfidence: 0.9 }),
      ],
    }));
    expect(picks(r)).toEqual(['a']);
    expect(r.explanations.find(e => e.id === 'b')).toMatchObject({ outcome: 'skipped', reason: 'soft_overlap', blockedBy: 'a' });
    expect(r.hardEdges).toEqual([]);
  });

  it('soft weight at or above thetaSoft skips; work conservation admits under thetaIdle', () => {
    const r = planClaimBatch(input({
      capacity: 2,
      candidates: [
        cand('a', { priority: 1, declaredScope: ['x.ts'] }),
        cand('b', { predictedScope: ['x.ts'], setConfidence: 0.6 }),
      ],
    }));
    // 0.6 ≥ thetaSoft (0.5) but < thetaIdle (0.8): admitted only because capacity would idle.
    expect(picks(r)).toEqual(['a', 'b']);
    expect(r.picks[1]).toMatchObject({ id: 'b', admittedBy: 'work_conservation' });
  });

  it('soft weight at or above thetaIdle is ordered behind the overlapping node', () => {
    const r = planClaimBatch(input({
      capacity: 2,
      candidates: [
        cand('a', { priority: 1, declaredScope: ['x.ts'] }),
        cand('b', { predictedScope: ['x.ts'], setConfidence: 0.9 }),
      ],
    }));
    expect(picks(r)).toEqual(['a']);
    expect(r.orientation[0]).toMatchObject({ taskId: 'b', blockedBy: 'a', edge: 'soft_overlap', reason: 'higher_score' });
  });

  it('a stored NOT_REAL answer replaces the estimate', () => {
    const r = planClaimBatch(input({
      capacity: 2,
      candidates: [
        cand('a', { priority: 1, declaredScope: ['x.ts'] }),
        cand('b', { predictedScope: ['x.ts'], setConfidence: 0.95 }),
      ],
      overlapAnswers: { [overlapPairKey('a', 'b')]: 'NOT_REAL' },
    }));
    expect(picks(r)).toEqual(['a', 'b']);
    expect(r.picks[1].admittedBy).toBe('greedy');
  });

  it('a stored REAL answer raises the weight but stays soft', () => {
    const r = planClaimBatch(input({
      capacity: 2,
      thresholds: { thetaOrder: 0.3, thetaSoft: 0.5, thetaIdle: 1.5 },
      candidates: [
        cand('a', { priority: 1, declaredScope: ['x.ts'] }),
        cand('b', { predictedScope: ['x.ts', 'y.ts', 'z.ts', 'w.ts'], setConfidence: 0.35 }),
      ],
      overlapAnswers: { [overlapPairKey('b', 'a')]: 'REAL' },
    }));
    // REAL → weight 1, above thetaSoft, still admitted under thetaIdle: soft, never hard.
    expect(picks(r)).toEqual(['a', 'b']);
    expect(r.picks[1].admittedBy).toBe('work_conservation');
  });

  it('null thresholds = declared/observed scope only: predictions neither block nor unlock', () => {
    const r = planClaimBatch(input({
      thresholds: null,
      capacity: 5,
      candidates: [
        cand('a', { priority: 2, declaredScope: ['x.ts'] }),
        cand('b', { priority: 1, predictedScope: ['x.ts'], setConfidence: 1 }),
        cand('c', { predictedScope: ['y.ts'], setConfidence: 1 }),
      ],
    }));
    // b is not ordered behind a (predictions ignored), but b and c both fall back to
    // "no scope" in m1 and keep today's mutex with each other.
    expect(picks(r)).toEqual(['a', 'b']);
    expect(r.orientation).toEqual([expect.objectContaining({ taskId: 'c', blockedBy: 'b', edge: 'no_scope_mutex' })]);
  });

  it('a prediction under thetaOrder does not count as scope', () => {
    const r = planClaimBatch(input({
      capacity: 5,
      candidates: [
        cand('a', { priority: 1, predictedScope: ['x.ts'], setConfidence: 0.2 }),
        cand('b', { predictedScope: ['y.ts'], setConfidence: 0.2 }),
      ],
    }));
    expect(picks(r)).toEqual(['a']);
    expect(r.orientation[0]).toMatchObject({ taskId: 'b', edge: 'no_scope_mutex' });
  });

  it('overlapFraction is the share of the smaller scope matched in the other', () => {
    expect(overlapFraction(['a.ts', 'b.ts'], ['a.ts', 'c.ts', 'd.ts'])).toBe(0.5);
    expect(overlapFraction(['dir'], ['dir/x.ts', 'y.ts'])).toBe(1);
    expect(overlapFraction(['a.ts'], ['b.ts'])).toBe(0);
    expect(overlapFraction([], ['b.ts'])).toBe(0);
    expect(overlapFraction(['**'], ['b.ts'])).toBe(0);
  });
});

describe('planClaimBatch — score', () => {
  const sized = (id: string, files: number, dependentCount = 0) =>
    cand(id, { declaredScope: [`${id}.ts`], expectedSize: { files, minutes: files * 10 }, dependentCount });

  it('priority first, then unblocking value, then smaller first', () => {
    const r = planClaimBatch(input({
      capacity: 3,
      candidates: [sized('big-unblocker', 20, 3), sized('small', 1), cand('urgent', { priority: 1, declaredScope: ['u.ts'] })],
    }));
    expect(picks(r)).toEqual(['urgent', 'big-unblocker', 'small']);
  });

  it('pressure flips size above unblocking (OAuth at the parallelism floor with good confidence)', () => {
    const r = planClaimBatch(input({
      capacity: 2,
      pressure: { dailyBudgetPct: null, oauthPressure: 0.5, confidence: 'good' },
      candidates: [sized('big-unblocker', 20, 3), sized('small', 1)],
    }));
    expect(picks(r)).toEqual(['small', 'big-unblocker']);
    expect(r.underPressure).toBe(true);
  });

  it('pressure from the daily budget downgrade threshold flips too', () => {
    const r = planClaimBatch(input({
      pressure: { dailyBudgetPct: DAILY_BUDGET_DOWNGRADE_FRACTION, oauthPressure: null, confidence: null },
      candidates: [sized('big-unblocker', 20, 3), sized('small', 1)],
    }));
    expect(picks(r)).toEqual(['small', 'big-unblocker']);
  });

  it('OAuth pressure without good confidence is not pressure', () => {
    const r = planClaimBatch(input({
      pressure: { dailyBudgetPct: 0.1, oauthPressure: 0.9, confidence: 'low' },
      candidates: [sized('big-unblocker', 20, 3), sized('small', 1)],
    }));
    expect(r.underPressure).toBe(false);
    expect(picks(r)).toEqual(['big-unblocker', 'small']);
  });

  it('starvation credit outranks size but never crosses priority', () => {
    const r = planClaimBatch(input({
      capacity: 3,
      candidates: [
        cand('starved', { declaredScope: ['s.ts'], expectedSize: { files: 30, minutes: 300 }, starvationCredit: 50 }),
        cand('small', { declaredScope: ['m.ts'], expectedSize: { files: 1, minutes: 5 } }),
        cand('urgent', { priority: 1, declaredScope: ['u.ts'], expectedSize: { files: 30, minutes: 300 } }),
      ],
    }));
    expect(picks(r)).toEqual(['urgent', 'starved', 'small']);
  });

  it('starvation credit is bucketed so a single pass does not reorder', () => {
    expect(starvationBucket(0)).toBe(starvationBucket(1));
    expect(starvationBucket(50)).toBeGreaterThan(starvationBucket(0));
    const r = planClaimBatch(input({
      candidates: [
        cand('big', { declaredScope: ['b.ts'], expectedSize: { files: 9, minutes: 90 }, starvationCredit: 1 }),
        cand('small', { declaredScope: ['s.ts'], expectedSize: { files: 1, minutes: 5 } }),
      ],
    }));
    expect(picks(r)).toEqual(['small', 'big']);
  });

  it('unknown size sorts after known sizes', () => {
    const r = planClaimBatch(input({
      candidates: [cand('unknown', { declaredScope: ['u.ts'] }), sized('known', 50)],
    }));
    expect(picks(r)).toEqual(['known', 'unknown']);
  });

  it('deterministic tie-break: createdAt, then id, independent of input order', () => {
    const a = cand('b-id', { declaredScope: ['1.ts'] });
    const b = cand('a-id', { declaredScope: ['2.ts'] });
    const c = cand('older', { declaredScope: ['3.ts'], createdAt: T0 - 1000 });
    const r1 = planClaimBatch(input({ candidates: [a, b, c] }));
    const r2 = planClaimBatch(input({ candidates: [c, a, b] }));
    expect(picks(r1)).toEqual(['older', 'a-id', 'b-id']);
    expect(r2).toEqual(r1);
  });

  it('accepts Date and ISO createdAt', () => {
    const r = planClaimBatch(input({
      candidates: [
        cand('later', { declaredScope: ['1.ts'], createdAt: new Date(T0 + 5) }),
        cand('earlier', { declaredScope: ['2.ts'], createdAt: new Date(T0).toISOString() }),
      ],
    }));
    expect(picks(r)).toEqual(['earlier', 'later']);
  });
});

describe('planClaimBatch — capacity and explanations', () => {
  it('never exceeds k, and k ≤ 0 picks nothing', () => {
    const cs = ['a', 'b', 'c', 'd'].map(id => cand(id, { declaredScope: [`${id}.ts`] }));
    expect(planClaimBatch(input({ candidates: cs, capacity: 2 })).picks).toHaveLength(2);
    expect(planClaimBatch(input({ candidates: cs, capacity: 0 })).picks).toHaveLength(0);
    expect(planClaimBatch(input({ candidates: cs, capacity: -1 })).picks).toHaveLength(0);
  });

  it('explains every candidate exactly once', () => {
    const r = planClaimBatch(input({
      capacity: 1,
      candidates: [
        cand('a', { priority: 1, declaredScope: ['x.ts'] }),
        cand('b', { declaredScope: ['x.ts'] }),
        cand('c', { declaredScope: ['y.ts'] }),
      ],
    }));
    expect(r.explanations.map(e => e.id).sort()).toEqual(['a', 'b', 'c']);
    expect(r.explanations.find(e => e.id === 'a')).toMatchObject({ outcome: 'picked', rank: 0 });
    expect(r.explanations.find(e => e.id === 'b')).toMatchObject({ outcome: 'skipped', reason: 'path_overlap', blockedBy: 'a' });
    expect(r.explanations.find(e => e.id === 'c')).toMatchObject({ outcome: 'skipped', reason: 'capacity' });
  });
});

// ── Property tests ───────────────────────────────────────────────────────────

/** Small deterministic PRNG so failures reproduce. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FILES = ['a.ts', 'b.ts', 'c.ts', 'dir', 'dir/x.ts', 'dir/y.ts', 'e.ts', '**'];

function randomScope(r: () => number): string[] | null {
  if (r() < 0.25) return null;
  const n = 1 + Math.floor(r() * 3);
  return Array.from({ length: n }, () => FILES[Math.floor(r() * FILES.length)]);
}

function randomInput(seed: number): ClaimPlanInput {
  const r = rng(seed);
  const n = 1 + Math.floor(r() * 25);
  const ids = Array.from({ length: n }, (_, i) => `t${i}`);
  const candidates = ids.map(id => cand(id, {
    priority: Math.floor(r() * 3),
    createdAt: T0 + Math.floor(r() * 10),
    missionId: r() < 0.5 ? 'm1' : 'm2',
    declaredScope: r() < 0.6 ? randomScope(r) : null,
    predictedScope: r() < 0.5 ? randomScope(r) : null,
    setConfidence: r() < 0.8 ? r() : null,
    expectedSize: r() < 0.7 ? { files: Math.floor(r() * 20), minutes: Math.floor(r() * 120) } : null,
    dependentCount: Math.floor(r() * 4),
    dependsOn: r() < 0.15 ? [ids[Math.floor(r() * n)]] : undefined,
    serializedSurfaces: r() < 0.15 ? ['migrations'] : undefined,
    starvationCredit: Math.floor(r() * 30),
    hasOpenPr: r() < 0.1,
    editsFiles: r() < 0.9,
  }));
  const inFlight = Array.from({ length: Math.floor(r() * 5) }, (_, i) => flight(`f${i}`, {
    kind: (['worker', 'open_pr', 'lease'] as const)[Math.floor(r() * 3)],
    missionId: r() < 0.5 ? 'm1' : 'm2',
    declaredScope: randomScope(r),
    serializedSurfaces: r() < 0.1 ? ['migrations'] : undefined,
  }));
  const thresholds = r() < 0.2 ? null : { thetaOrder: r() * 0.5, thetaSoft: 0.3 + r() * 0.4, thetaIdle: 0.6 + r() * 0.6 };
  return {
    candidates,
    inFlight,
    capacity: Math.floor(r() * 8) - 1,
    pressure: { dailyBudgetPct: r(), oauthPressure: r(), confidence: r() < 0.5 ? 'good' : 'low' },
    thresholds,
  };
}

describe('planClaimBatch — properties', () => {
  it('never exceeds k, never picks a node with a hard edge to a pick or in-flight node, and is deterministic', () => {
    for (let seed = 1; seed <= 400; seed++) {
      const inp = randomInput(seed);
      const out = planClaimBatch(inp);
      expect(out.picks.length).toBeLessThanOrEqual(Math.max(0, inp.capacity));

      const picked = new Set(out.picks.map(p => p.id));
      for (const p of out.picks) {
        for (const e of out.hardEdges) {
          if (e.a === p.id && (picked.has(e.b) || inp.inFlight.some(f => f.id === e.b))) {
            throw new Error(`seed ${seed}: ${p.id} picked with hard edge to ${e.b} (${e.kind})`);
          }
          if (e.b === p.id && picked.has(e.a)) {
            throw new Error(`seed ${seed}: ${p.id} picked with hard edge to ${e.a} (${e.kind})`);
          }
        }
      }
      // Independent of the module's own edge list: no two concrete-scoped picks (or a
      // pick and an in-flight row) overlap, share a surface, or pick a dependent.
      const concrete = (s: string[] | null | undefined) => (s && !s.includes('**') ? s : null);
      const pickedRows = inp.candidates.filter(c => picked.has(c.id));
      const others = [...pickedRows, ...inp.inFlight];
      for (const p of pickedRows) {
        expect((p.dependsOn ?? []).filter(d => d !== p.id)).toEqual([]);
        for (const o of others) {
          if (o.id === p.id) continue;
          const ps = concrete(p.declaredScope);
          const os = concrete(o.declaredScope);
          if (ps && os && pathsOverlap(ps, os)) throw new Error(`seed ${seed}: ${p.id} overlaps ${o.id}`);
          const shared = (p.serializedSurfaces ?? []).some(s => (o.serializedSurfaces ?? []).includes(s));
          if (shared) throw new Error(`seed ${seed}: ${p.id} shares a surface with ${o.id}`);
        }
      }
      // Every candidate is explained exactly once.
      expect(out.explanations.map(e => e.id).sort()).toEqual(inp.candidates.map(c => c.id).sort());
      // Reversed input order produces an identical plan.
      expect(planClaimBatch({ ...inp, candidates: [...inp.candidates].reverse(), inFlight: [...inp.inFlight].reverse() }))
        .toEqual(out);
    }
  });

  it('predicted scope never creates a hard edge', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const inp = randomInput(seed);
      const out = planClaimBatch(inp);
      const stripped = planClaimBatch({
        ...inp,
        thresholds: inp.thresholds ?? THRESHOLDS,
        candidates: inp.candidates.map(c => ({ ...c, predictedScope: null })),
      });
      // Every path/surface/dependency edge with predictions present also exists without them.
      const key = (e: { a: string; b: string; kind: string }) => `${e.a}|${e.b}|${e.kind}`;
      const without = new Set(stripped.hardEdges.filter(e => e.kind !== 'no_scope_mutex').map(key));
      for (const e of out.hardEdges.filter(e => e.kind !== 'no_scope_mutex')) {
        expect(without.has(key(e))).toBe(true);
      }
    }
  });
});
