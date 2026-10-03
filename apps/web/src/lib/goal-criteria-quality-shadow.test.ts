import { describe, expect, it } from 'bun:test';
import { criterionFingerprint } from '@buildd/core/mission-helpers';
import {
  goalQualityAdvisory,
  runGoalQualityShadow,
  scheduleGoalQualityShadow,
  withGoalQualityAdvisory,
  type GoalQualityShadowInput,
} from './goal-criteria-quality-shadow';
import { GOAL_QUALITY_MODE, GOAL_QUALITY_REWRITES, goalQualityBypasses } from './goal-criteria-quality-decision';

const weak = { type: 'command', command: 'bun run test', label: 'tests pass' };
const strong = { type: 'command', command: 'bun run e2e signup', label: 'A visitor can sign up' };

const input = (over: Partial<GoalQualityShadowInput> = {}): GoalQualityShadowInput => ({
  missionId: '11111111-2222-4333-8444-555555555555',
  teamId: 'team-1',
  workspaceId: 'ws-1',
  criteria: [strong, weak, { type: 'all_prs_merged' }],
  dataClass: null,
  surface: 'POST /api/missions',
  callerOrigin: 'api',
  ...over,
});

const allowed = async () => ({ ok: true as const, apiKey: 'k', model: 'jev-test' });
/** Grades the criterion labelled "tests pass" (state position 1) as not noticeable. */
const decide = (async (req: any) => {
  const answers: Record<string, unknown> = {};
  for (const name of Object.keys(req.questions)) {
    answers[name] = { type: 'choice', confidence: 0.9, probabilities: {}, choice: name === 'rewrite' ? 'state-outcome' : name === 'c1_noticeable' ? 'no' : 'yes' };
  }
  return { ok: true, answers, model: 'jev-test', latencyMs: 5, usage: null };
}) as any;
const deps = () => ({ resolveAccess: allowed as any, decide, cache: new Map(), log: () => {}, loadRubric: async () => ({ text: 'rubric', version: 'base', acceptedFingerprints: [] }) });

describe('runGoalQualityShadow', () => {
  it('records one warned row for the weak criterion and none for the strong one', async () => {
    const fired: any[] = [];
    await runGoalQualityShadow(input(), { deps: deps(), fire: r => fired.push(r) });
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ gate: 'goal_criteria_quality', outcome: 'warned', detail: { index: 1, type: 'command' } });
  });

  it('a strong goal records nothing', async () => {
    const fired: any[] = [];
    await runGoalQualityShadow(input({ criteria: [strong] }), { deps: deps(), fire: r => fired.push(r) });
    expect(fired).toEqual([]);
  });

  it('a dataClass lookup failure fails closed: nothing is sent', async () => {
    let called = false;
    const r = await runGoalQualityShadow(input({ dataClass: undefined }), {
      deps: { ...deps(), decide: (async (...a: any[]) => { called = true; return decide(...a); }) as any },
      loadDataClass: async () => { throw new Error('db down'); },
      fire: () => {},
    });
    expect(r).toBeNull();
    expect(called).toBe(false);
  });

  it('reads dataClass in the background when the route did not have it', async () => {
    let called = false;
    await runGoalQualityShadow(input({ dataClass: undefined }), {
      deps: { ...deps(), decide: (async (...a: any[]) => { called = true; return decide(...a); }) as any },
      loadDataClass: async () => 'sensitive',
      fire: () => {},
    });
    expect(called).toBe(false);
  });

  it('a throwing ledger writer is swallowed', async () => {
    const r = await runGoalQualityShadow(input(), { deps: deps(), fire: () => { throw new Error('ledger down'); } });
    expect(r).not.toBeNull();
  });
});

describe('scheduleGoalQualityShadow', () => {
  it('returns before the verdict exists, even when decide never resolves', () => {
    const scheduled: Array<() => Promise<unknown>> = [];
    const start = Date.now();
    scheduleGoalQualityShadow(input(), {
      schedule: fn => { scheduled.push(fn); },
      deps: { ...deps(), decide: (() => new Promise(() => {})) as any },
    });
    expect(Date.now() - start).toBeLessThan(50);
    expect(scheduled).toHaveLength(1);
  });

  it('without a request scope it still runs, unawaited, and never throws', async () => {
    const fired: any[] = [];
    expect(() => scheduleGoalQualityShadow(input(), {
      schedule: () => { throw new Error('after() outside a request scope'); },
      deps: deps(),
      fire: r => fired.push(r),
    })).not.toThrow();
    await new Promise(r => setTimeout(r, 10));
    expect(fired).toHaveLength(1);
  });
});

const MISSION = '11111111-2222-4333-8444-555555555555';
const warnedRow = (c: any, mode = 'shadow') => ({ outcome: 'warned', detail: { fingerprint: criterionFingerprint(c), type: c.type, mode, promptVersion: 'gq2' } });
const patch = (over: Partial<GoalQualityShadowInput> = {}) => input({ surface: 'PATCH /api/missions/[id]', ...over });

describe('goalQualityBypasses (pure)', () => {
  const ctx = { missionId: MISSION, workspaceId: 'ws-1', surface: 'PATCH /api/missions/[id]' as const };

  it('a warned criterion still present is bypassed once, matched by fingerprint not index (AC-8)', () => {
    // The weak criterion moved from index 1 to index 0: same criterion.
    const rows = goalQualityBypasses([weak, strong] as any, [warnedRow(weak)], ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      gate: 'goal_criteria_quality',
      outcome: 'bypassed',
      missionId: MISSION,
      detail: { fingerprint: criterionFingerprint(weak as any), type: 'command', mode: 'shadow' },
    });
    expect(JSON.stringify(rows)).not.toContain('tests pass');
    expect(JSON.stringify(rows)).not.toContain('bun run test');
  });

  it('an existing bypassed row means no second one (AC-8)', () => {
    const prior = [warnedRow(weak), { outcome: 'bypassed', detail: { fingerprint: criterionFingerprint(weak as any) } }];
    expect(goalQualityBypasses([weak] as any, prior, ctx)).toEqual([]);
  });

  it('a removed or changed criterion is not bypassed (AC-9)', () => {
    expect(goalQualityBypasses([strong] as any, [warnedRow(weak)], ctx)).toEqual([]);
    expect(goalQualityBypasses([{ ...weak, label: 'a visitor can sign up' }] as any, [warnedRow(weak)], ctx)).toEqual([]);
  });

  it('carries the mode of the warning it answers; a duplicate criterion is one row', () => {
    const rows = goalQualityBypasses([weak, weak] as any, [warnedRow(weak, 'surface')], ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0].detail).toMatchObject({ mode: 'surface' });
  });

  it('rows without a fingerprint are ignored', () => {
    expect(goalQualityBypasses([weak] as any, [{ outcome: 'warned', detail: null }, { outcome: 'warned', detail: { fingerprint: 3 } }], ctx)).toEqual([]);
  });
});

describe('runGoalQualityShadow — bypass ledger', () => {
  it('PATCH keeping a warned criterion records bypassed, even with the capability off', async () => {
    const fired: any[] = [];
    let decided = false;
    await runGoalQualityShadow(patch({ criteria: [weak, strong], stored: [weak] }), {
      deps: {
        ...deps(),
        resolveAccess: (async () => ({ ok: false, error: { kind: 'capability_disabled', capability: 'mission_goal_quality' } })) as any,
        decide: (async () => { decided = true; }) as any,
      },
      loadLedger: async () => [warnedRow(weak)],
      fire: r => fired.push(r),
    });
    expect(decided).toBe(false);
    expect(fired.map(r => r.outcome)).toEqual(['bypassed']);
  });

  it('a byte-identical PATCH still records the bypass but makes no decision call (AC-8, AC-14)', async () => {
    const fired: any[] = [];
    let decided = false;
    await runGoalQualityShadow(patch({ criteria: [weak], stored: [weak] }), {
      deps: { ...deps(), decide: (async () => { decided = true; }) as any },
      loadLedger: async () => [warnedRow(weak)],
      fire: r => fired.push(r),
    });
    expect(decided).toBe(false);
    expect(fired.map(r => r.outcome)).toEqual(['bypassed']);
  });

  it('the bypass check precedes this write\'s own warnings', async () => {
    const fired: any[] = [];
    await runGoalQualityShadow(patch({ criteria: [strong, weak], stored: [] }), {
      deps: deps(),
      loadLedger: async () => [],
      fire: r => fired.push(r),
    });
    expect(fired.map(r => r.outcome)).toEqual(['warned']);
  });

  it('POST never reads the ledger', async () => {
    let reads = 0;
    await runGoalQualityShadow(input(), { deps: deps(), loadLedger: async () => { reads++; return []; }, fire: () => {} });
    expect(reads).toBe(0);
  });

  it('a failing ledger read records nothing and the verdict still runs', async () => {
    const fired: any[] = [];
    const r = await runGoalQualityShadow(patch({ criteria: [strong, weak], stored: [] }), {
      deps: deps(),
      loadLedger: async () => { throw new Error('db down'); },
      fire: x => fired.push(x),
    });
    expect(r).not.toBeNull();
    expect(fired.map(x => x.outcome)).toEqual(['warned']);
  });
});

describe('withGoalQualityAdvisory — surface, driven by parameter', () => {
  const criteria = [strong, weak, { type: 'all_prs_merged' }];
  const body = () => ({ id: MISSION, goalCriteria: structuredClone(criteria) });
  const noSchedule = { schedule: () => {} };

  it('the shipped mode is surface', () => {
    expect(GOAL_QUALITY_MODE).toBe('surface');
  });

  it('shadow: the response is the same object, unchanged, and the verdict is scheduled (AC-12)', async () => {
    const scheduled: any[] = [];
    const b = body();
    const out = await withGoalQualityAdvisory(b, input({ criteria }), { mode: 'shadow', deps: deps(), schedule: fn => { scheduled.push(fn); }, fire: () => {} });
    expect(out).toBe(b);
    expect(out).toEqual(body());
    expect(out).not.toHaveProperty('advisory');
    expect(scheduled).toHaveLength(1);
  });

  it('surface: carries exactly one suggestion and per-criterion flags; the goal is untouched', async () => {
    const submitted = Object.freeze(criteria.map(c => Object.freeze({ ...c })));
    const b = body();
    const fired: any[] = [];
    const out: any = await withGoalQualityAdvisory(b, input({ criteria: submitted }), { ...noSchedule, mode: 'surface', deps: deps(), fire: r => fired.push(r) });
    expect(out.goalCriteria).toEqual(criteria);
    expect(b).not.toHaveProperty('advisory');
    expect(out.advisory.suggestion).toBe(GOAL_QUALITY_REWRITES['state-outcome']);
    expect(typeof out.advisory.suggestion).toBe('string');
    expect(Object.keys(out.advisory).filter(k => /suggest/i.test(k))).toEqual(['suggestion']);
    expect(out.advisory.criteria).toEqual([
      { index: 0, fingerprint: criterionFingerprint(strong as any), type: 'command', outcome: true, checkable: true, weak: false },
      { index: 1, fingerprint: criterionFingerprint(weak as any), type: 'command', outcome: false, checkable: true, weak: true },
      { index: 2, fingerprint: criterionFingerprint({ type: 'all_prs_merged' }), type: 'all_prs_merged', outcome: false, checkable: true, weak: false },
    ]);
    expect(fired[0].detail.mode).toBe('surface');
  });

  it('surface: a verdict slower than the deadline means no advisory, and the work still finishes', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const slow = (async (req: any) => { await gate; return decide(req); }) as any;
    const fired: any[] = [];
    const b = body();
    const out = await withGoalQualityAdvisory(b, input({ criteria }), { ...noSchedule, mode: 'surface', deps: { ...deps(), decide: slow }, fire: r => fired.push(r), timeoutMs: 10 });
    expect(out).toBe(b);
    release();
    await new Promise(r => setTimeout(r, 10));
    expect(fired.map(r => r.outcome)).toEqual(['warned']);
  });

  it('surface: nothing weak, or no verdict, means no advisory', async () => {
    const b = body();
    expect(await withGoalQualityAdvisory(b, input({ criteria: [strong] }), { ...noSchedule, mode: 'surface', deps: deps(), fire: () => {} })).toBe(b);
    const throwing = { ...deps(), decide: (async () => { throw new Error('down'); }) as any };
    expect(await withGoalQualityAdvisory(b, input({ criteria }), { ...noSchedule, mode: 'surface', deps: throwing, fire: () => {} })).toBe(b);
  });

  it('a `none` rewrite with a weak criterion still renders one code-owned suggestion', () => {
    const advisory = goalQualityAdvisory({
      criteria: [{ index: 0, fingerprint: 'f', type: 'description', noticeable: 'yes', noticeableConfidence: 0.9, checkable: 'no', checkableConfidence: 0.9, weak: true, weakOn: ['checkable'] }],
      weakCount: 1, rewrite: 'none', rewriteConfidence: 0.5, suggestion: null, model: 'm', promptVersion: 'gq2', rubricVersion: 'base',
    });
    expect(advisory!.rewrite).toBe('command-proof');
    expect(advisory!.suggestion).toBe(GOAL_QUALITY_REWRITES['command-proof']!);
  });
});
