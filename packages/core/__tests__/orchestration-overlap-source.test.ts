import { describe, it, expect, mock, beforeEach } from 'bun:test';

/**
 * The overlap-real decision's I/O half (jev-scheduling §5). The orchestration
 * (`runOverlapRealShadow`) is driven entirely through injected deps: no DB,
 * no network. The raw DB-query helpers get a lighter smoke test against a
 * stubbed `db/client`, mirroring manifest-prediction-source.test.ts.
 */

const fake = {
  inserted: [] as { table: string; values: any; target?: any; set?: any }[],
  selectRows: [] as any[],
  throwOnInsert: false,
  throwOnSelect: false,
};
const nameOf = (table: any) => table?.[Symbol.for('drizzle:Name')];

mock.module('../db/client', () => ({
  db: {
    insert: (table: any) => ({
      values: (values: any) => ({
        onConflictDoUpdate: async (opts: any) => {
          if (fake.throwOnInsert) throw new Error('insert failed');
          fake.inserted.push({ table: nameOf(table), values, target: opts?.target, set: opts?.set });
        },
      }),
    }),
    select: () => ({
      from: (table: any) => ({
        where: (where: any) => {
          if (fake.throwOnSelect) throw new Error('select failed');
          const res: any = Promise.resolve(fake.selectRows);
          res.orderBy = () => ({ limit: async () => fake.selectRows });
          res.limit = async () => fake.selectRows;
          return res;
        },
      }),
    }),
  },
}));

const src = await import('../orchestration-overlap-source');
const { OVERLAP_REAL_DECISION } = await import('../orchestration-overlap-decision');
const { overlapPairKey } = await import('../claim-planner');

beforeEach(() => {
  fake.inserted = [];
  fake.selectRows = [];
  fake.throwOnInsert = false;
  fake.throwOnSelect = false;
});

const newTask = () => ({
  taskId: 'new',
  title: 'Fix the claim route',
  description: 'touches the claim route',
  declaredScope: null,
  predictedScope: ['apps/web/src/app/api/workers/claim/route.ts'],
  setConfidence: 0.9,
});

const input = () => ({ teamId: 'team-1', workspaceId: 'ws-1', missionId: null, accountId: null, userId: null });

const outcome = (over: Record<string, unknown> = {}) => ({
  effective: 'REAL', applied: false, status: 'fallback', reason: 'capability_disabled', suggested: null, confidence: null, row: null, ...over,
});

describe('runOverlapRealShadow', () => {
  it('no candidates ⇒ no decision call, nothing recorded', async () => {
    const decide = mock(async () => outcome());
    const recordAnswer = mock(async () => {});
    await src.runOverlapRealShadow(newTask(), input(), { loadCandidates: async () => [], decide, recordAnswer });
    expect(decide).not.toHaveBeenCalled();
    expect(recordAnswer).not.toHaveBeenCalled();
  });

  it('asks about each soft pair and records only applied answers', async () => {
    const other = { taskId: 'other', title: 'Other task', description: null, declaredScope: ['apps/web/src/app/api/workers/claim/route.ts'], predictedScope: null, setConfidence: null };
    const decide = mock(async (p: any) => {
      expect(p.question).toBe('overlap');
      expect(p.capability).toBe('orchestration_ordering');
      expect(p.ruleVerdict).toBe('REAL');
      expect(p.scope).toMatchObject({ teamId: 'team-1', workspaceId: 'ws-1', taskId: 'new' });
      expect(p.isValidAnswer('NOT_REAL')).toBe(true);
      expect(p.isValidAnswer('MAYBE')).toBe(false);
      return outcome({ applied: true, status: 'applied', effective: 'NOT_REAL', suggested: 'NOT_REAL', confidence: 0.8 });
    });
    const recordAnswer = mock(async () => {});
    const hasRecent = mock(async () => false);
    await src.runOverlapRealShadow(newTask(), input(), { loadCandidates: async () => [other], decide, recordAnswer, hasRecent });
    expect(decide).toHaveBeenCalledTimes(1);
    expect(recordAnswer).toHaveBeenCalledTimes(1);
    const row = (recordAnswer.mock.calls[0] as any)[0];
    expect(row.pairKey).toBe(overlapPairKey('new', 'other'));
    expect(row.answer).toBe('NOT_REAL');
    expect(row.confidence).toBe(0.8);
  });

  it('below-threshold (suggested) and capability-off (fallback) record nothing — the rule stands', async () => {
    const other = { taskId: 'other', title: 'Other task', description: null, declaredScope: ['x.ts'], predictedScope: null, setConfidence: null };
    for (const o of [
      outcome({ applied: false, status: 'suggested', reason: 'below_threshold', effective: 'REAL', suggested: 'REAL', confidence: 0.3 }),
      outcome({ applied: false, status: 'fallback', reason: 'capability_disabled', effective: 'REAL' }),
      outcome({ applied: false, status: 'fallback', reason: 'deadline', effective: 'REAL' }),
    ]) {
      const recordAnswer = mock(async () => {});
      await src.runOverlapRealShadow(
        { ...newTask(), predictedScope: ['x.ts'] },
        input(),
        { loadCandidates: async () => [other], decide: async () => o, recordAnswer, hasRecent: async () => false },
      );
      expect(recordAnswer).not.toHaveBeenCalled();
    }
  });

  it('dedupes: an already-recently-asked pair is skipped entirely', async () => {
    const other = { taskId: 'other', title: 'Other task', description: null, declaredScope: ['x.ts'], predictedScope: null, setConfidence: null };
    const decide = mock(async () => outcome());
    await src.runOverlapRealShadow(
      { ...newTask(), predictedScope: ['x.ts'] },
      input(),
      { loadCandidates: async () => [other], decide, hasRecent: async () => true },
    );
    expect(decide).not.toHaveBeenCalled();
  });

  it('bounds the number of pairs asked per task creation', async () => {
    const others = Array.from({ length: 20 }, (_, i) => ({ taskId: `t${i}`, title: 't', description: null, declaredScope: ['x.ts'], predictedScope: null, setConfidence: null }));
    const decide = mock(async () => outcome());
    await src.runOverlapRealShadow(
      { ...newTask(), predictedScope: ['x.ts'] },
      input(),
      { loadCandidates: async () => others, decide, hasRecent: async () => false, maxPairs: 5 },
    );
    expect(decide).toHaveBeenCalledTimes(5);
  });

  it('one pair failing never stops the rest (never throws)', async () => {
    const others = [
      { taskId: 'bad', title: 't', description: null, declaredScope: ['x.ts'], predictedScope: null, setConfidence: null },
      { taskId: 'good', title: 't', description: null, declaredScope: ['x.ts'], predictedScope: null, setConfidence: null },
    ];
    let calls = 0;
    const decide = mock(async () => {
      calls++;
      if (calls === 1) throw new Error('boom');
      return outcome({ applied: true, status: 'applied', effective: 'REAL', suggested: 'REAL', confidence: 0.9 });
    });
    const recordAnswer = mock(async () => {});
    await expect(src.runOverlapRealShadow(
      { ...newTask(), predictedScope: ['x.ts'] },
      input(),
      { loadCandidates: async () => others, decide, hasRecent: async () => false, recordAnswer },
    )).resolves.toBeUndefined();
    expect(recordAnswer).toHaveBeenCalledTimes(1);
  });

  it('never calls anything beyond loadCandidates/decide/recordAnswer — it can never touch a hard edge', async () => {
    const other = { taskId: 'other', title: 't', description: null, declaredScope: ['x.ts'], predictedScope: null, setConfidence: null };
    const calledFns = new Set<string>();
    await src.runOverlapRealShadow(
      { ...newTask(), predictedScope: ['x.ts'] },
      input(),
      {
        loadCandidates: async () => { calledFns.add('loadCandidates'); return [other]; },
        decide: async () => { calledFns.add('decide'); return outcome({ applied: true, status: 'applied', effective: 'REAL', suggested: 'REAL', confidence: 0.9 }); },
        recordAnswer: async () => { calledFns.add('recordAnswer'); },
        hasRecent: async () => { calledFns.add('hasRecent'); return false; },
      },
    );
    expect(calledFns).toEqual(new Set(['loadCandidates', 'decide', 'recordAnswer', 'hasRecent']));
  });
});

describe('recordOverlapAnswer', () => {
  it('upserts keyed on (workspace, pairKey, decisionId); a failed write never throws', async () => {
    await src.recordOverlapAnswer({
      teamId: 't', workspaceId: 'ws-1', missionId: null, pairKey: overlapPairKey('a', 'b'),
      taskAId: 'a', taskBId: 'b', decisionId: OVERLAP_REAL_DECISION.id, fingerprint: 'fp', answer: 'REAL', confidence: 0.8,
    });
    expect(fake.inserted).toHaveLength(1);
    expect(fake.inserted[0].table).toBe('orchestration_overlap_answers');

    fake.throwOnInsert = true;
    await expect(src.recordOverlapAnswer({
      teamId: 't', workspaceId: 'ws-1', missionId: null, pairKey: overlapPairKey('a', 'c'),
      taskAId: 'a', taskBId: 'c', decisionId: OVERLAP_REAL_DECISION.id, fingerprint: 'fp', answer: 'NOT_REAL', confidence: 0.8,
    })).resolves.toBeUndefined();
  });
});

describe('loadStoredOverlapAnswers', () => {
  it('returns only answers whose BOTH task ids are in the requested set, keyed by pairKey', async () => {
    fake.selectRows = [
      { pairKey: overlapPairKey('a', 'b'), taskAId: 'a', taskBId: 'b', answer: 'REAL' },
      { pairKey: overlapPairKey('a', 'z'), taskAId: 'a', taskBId: 'z', answer: 'NOT_REAL' },
    ];
    const result = await src.loadStoredOverlapAnswers({ workspaceId: 'ws-1', taskIds: ['a', 'b', 'c'] });
    expect(result).toEqual({ [overlapPairKey('a', 'b')]: 'REAL' });
  });

  it('fewer than 2 task ids ⇒ empty, no query', async () => {
    expect(await src.loadStoredOverlapAnswers({ workspaceId: 'ws-1', taskIds: ['a'] })).toEqual({});
  });

  it('a failed read answers {} (nothing applied), never throws', async () => {
    fake.throwOnSelect = true;
    expect(await src.loadStoredOverlapAnswers({ workspaceId: 'ws-1', taskIds: ['a', 'b'] })).toEqual({});
  });
});

describe('hasRecentOverlapDecision', () => {
  it('true when a matching row exists, false otherwise, true (never re-ask) on a failed read', async () => {
    const k = { workspaceId: 'ws-1', taskId: 'new', decisionId: 'd', fingerprint: 'fp', candidateDigest: 'dig', since: new Date() };
    fake.selectRows = [];
    expect(await src.hasRecentOverlapDecision(k)).toBe(false);
    fake.selectRows = [{ id: 'row-1' }];
    expect(await src.hasRecentOverlapDecision(k)).toBe(true);
    fake.throwOnSelect = true;
    expect(await src.hasRecentOverlapDecision(k)).toBe(true);
  });
});
