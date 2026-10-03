import { describe, it, expect, mock, beforeEach } from 'bun:test';

/**
 * The post-insert hook only: who is eligible, what it hands the prediction,
 * that it runs after the response, never throws and forwards decision
 * receipts to ai_usage. The prediction itself is covered by
 * packages/core/__tests__/manifest-prediction*.test.ts.
 */
const calls: any[] = [];
let throwIt = false;
let predictResult: any = { skipped: 'capability_disabled' };
mock.module('@buildd/core/manifest-prediction-source', () => ({
  predictCreationManifest: async (input: any, deps: any) => {
    calls.push({ input, deps });
    if (throwIt) throw new Error('boom');
    return predictResult;
  },
}));

const overlapCalls: any[] = [];
mock.module('@buildd/core/orchestration-overlap-source', () => ({
  runOverlapRealShadow: async (newTask: any, input: any, deps: any) => { overlapCalls.push({ newTask, input, deps }); },
}));

const { scheduleCreationManifestShadow, runCreationManifestShadow, creationManifestEligibility } = await import('./task-manifest-prediction');

const TEAM = '00000000-0000-4000-8000-0000000000bb';
const CREATED = new Date('2026-09-10T00:00:00Z');
const task = (over: Record<string, unknown> = {}) => ({
  id: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-0000000000aa',
  missionId: '00000000-0000-4000-8000-0000000000cc',
  title: 'T',
  description: 'D',
  createdAt: CREATED,
  pathManifest: null as string[] | null,
  taskClass: 'work',
  kind: null as string | null,
  context: { baseBranch: 'mission/x' },
  ...over,
});
const ctx = { teamId: TEAM, accountId: 'acct' };

/** Schedule the hook, then run whatever it scheduled. */
async function scheduleAndRun(t: ReturnType<typeof task>, c: any = ctx) {
  const scheduled: Array<() => Promise<unknown>> = [];
  const ok = scheduleCreationManifestShadow(t, c, fn => { scheduled.push(fn); });
  for (const fn of scheduled) await fn();
  return { ok, scheduled };
}

beforeEach(() => { calls.length = 0; overlapCalls.length = 0; throwIt = false; predictResult = { skipped: 'capability_disabled' }; });

describe('creationManifestEligibility', () => {
  it('work with no kind, or an engineering/writing/design kind, is eligible', () => {
    for (const kind of [null, undefined, 'engineering', 'writing', 'design']) {
      expect(creationManifestEligibility(task({ kind }))).toEqual({ eligible: true });
    }
  });

  it('analysis, research, coordination and observation are skipped by kind', () => {
    for (const kind of ['analysis', 'research', 'coordination', 'observation']) {
      expect(creationManifestEligibility(task({ kind }))).toEqual({ eligible: false, reason: 'kind' });
    }
  });

  it('pipeline and bookkeeping rows are skipped', () => {
    expect(creationManifestEligibility(task({ taskClass: 'bookkeeping' }))).toEqual({ eligible: false, reason: 'not_work' });
    expect(creationManifestEligibility(task({ taskClass: 'pipeline' }))).toEqual({ eligible: false, reason: 'not_work' });
  });

  it('a concrete caller manifest always wins; the sentinel and too-wide globs are missing scope', () => {
    expect(creationManifestEligibility(task({ pathManifest: ['apps/web/src/lib/a.ts'] }))).toEqual({ eligible: false, reason: 'caller_declared' });
    expect(creationManifestEligibility(task({ pathManifest: ['**'] }))).toEqual({ eligible: true });
    expect(creationManifestEligibility(task({ pathManifest: [] }))).toEqual({ eligible: true });
  });
});

describe('scheduleCreationManifestShadow', () => {
  it('hands the run to the scheduler (after the response) without running it inline', async () => {
    const scheduled: Array<() => Promise<unknown>> = [];
    expect(scheduleCreationManifestShadow(task(), ctx, fn => { scheduled.push(fn); })).toBe(true);
    expect(scheduled).toHaveLength(1);
    expect(calls).toHaveLength(0);
    await scheduled[0]();
    expect(calls).toHaveLength(1);
    expect(calls[0].input).toEqual({
      taskId: task().id,
      teamId: TEAM,
      workspaceId: task().workspaceId,
      missionId: task().missionId,
      accountId: 'acct',
      userId: null,
      title: 'T',
      description: 'D',
      createdAt: CREATED,
      callerManifest: null,
      baseRef: 'mission/x',
    });
    expect(typeof calls[0].deps.onReceipt).toBe('function');
  });

  it('an ineligible task schedules nothing', async () => {
    for (const t of [task({ kind: 'analysis' }), task({ pathManifest: ['docs/a.md'] }), task({ taskClass: 'bookkeeping' })]) {
      const { ok, scheduled } = await scheduleAndRun(t);
      expect(ok).toBe(false);
      expect(scheduled).toHaveLength(0);
    }
    expect(calls).toHaveLength(0);
  });

  it('no team or no workspace schedules nothing', async () => {
    expect((await scheduleAndRun(task(), { teamId: null })).ok).toBe(false);
    expect((await scheduleAndRun(task({ workspaceId: null }))).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('a string createdAt is parsed; a missing one falls back to now', async () => {
    await scheduleAndRun(task({ createdAt: CREATED.toISOString() }));
    expect(calls[0].input.createdAt).toEqual(CREATED);
    await scheduleAndRun(task({ createdAt: null }));
    expect(calls[1].input.createdAt instanceof Date).toBe(true);
  });

  it('runs detached when no request scope exists, and never throws', async () => {
    expect(() => scheduleCreationManifestShadow(task(), ctx, () => { throw new Error('no request scope'); })).not.toThrow();
    await new Promise(r => setTimeout(r, 0));
    expect(calls).toHaveLength(1);
  });

  it('a malformed row never throws out of the hook', () => {
    expect(() => scheduleCreationManifestShadow(null as any, ctx, () => {})).not.toThrow();
  });

  it('a failing prediction is swallowed', async () => {
    throwIt = true;
    await expect(runCreationManifestShadow(calls[0]?.input ?? { taskId: 't' } as any)).resolves.toBeUndefined();
  });
});

describe('the overlap-real shadow runs from the same after() callback (jev-scheduling §5)', () => {
  it('asks about soft pairs once the new task has a non-empty predicted scope', async () => {
    predictResult = { row: { taskId: 'x', selected: ['apps/web/src/a.ts'], setConfidence: 0.8 } };
    await scheduleAndRun(task());
    expect(overlapCalls).toHaveLength(1);
    expect(overlapCalls[0].newTask).toEqual({
      taskId: task().id,
      title: 'T',
      description: 'D',
      declaredScope: null,
      predictedScope: ['apps/web/src/a.ts'],
      setConfidence: 0.8,
    });
    expect(overlapCalls[0].input).toEqual({
      teamId: TEAM, workspaceId: task().workspaceId, missionId: task().missionId, accountId: 'acct', userId: null,
    });
  });

  it('a null setConfidence is passed through as null, not undefined', async () => {
    predictResult = { row: { taskId: 'x', selected: ['a.ts'], setConfidence: null } };
    await scheduleAndRun(task());
    expect(overlapCalls[0].newTask.setConfidence).toBeNull();
  });

  it('skipped predictions (capability off, caller-declared, error) never trigger the overlap check', async () => {
    for (const skip of [{ skipped: 'capability_disabled' }, { skipped: 'caller_declared' }, { skipped: 'error' }]) {
      predictResult = skip;
      await scheduleAndRun(task());
    }
    expect(overlapCalls).toHaveLength(0);
  });

  it('an empty predicted selection never triggers the overlap check (nothing to pair from)', async () => {
    predictResult = { row: { taskId: 'x', selected: [], setConfidence: null } };
    await scheduleAndRun(task());
    expect(overlapCalls).toHaveLength(0);
  });
});
