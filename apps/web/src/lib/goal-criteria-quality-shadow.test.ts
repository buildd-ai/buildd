import { describe, expect, it } from 'bun:test';
import { runGoalQualityShadow, scheduleGoalQualityShadow, type GoalQualityShadowInput } from './goal-criteria-quality-shadow';

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
const deps = () => ({ resolveAccess: allowed as any, decide, cache: new Map(), log: () => {} });

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
