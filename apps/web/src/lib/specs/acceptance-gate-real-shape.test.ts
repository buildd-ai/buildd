import { describe, it, expect, mock } from 'bun:test';

// The acceptance-tests task exactly as ensureAcceptanceTests files it: `acceptanceTests` is a marker object.
const MARKER = { missionId: 'm1', specId: 's1', specRevisionId: 'r1', apartFrom: 'builder' };
let rows: any[] = [];
let updates: Array<{ set: any }> = [];
const fakeDb = {
  query: {
    tasks: {
      findMany: async () => rows,
      findFirst: async () => rows[0],
    },
  },
  update: () => ({
    set: (v: any) => ({
      where: async () => {
        updates.push({ set: v });
        const row = rows.find((r) => 'context' in v ? r.id === 'acc' : false);
        if (row && v.context) row.context = v.context;
      },
    }),
  }),
};
mock.module('@buildd/core/db', () => ({ db: fakeDb }));
mock.module('@buildd/core/db/relational-sql', () => ({ sqlWhere: (x: unknown) => x }));

const { dbGateStore, recordAcceptanceObjection, isAcceptanceTask, testsFromContext } = await import('./acceptance-gate-apply');

const fresh = () => {
  updates = [];
  rows = [
    { id: 'acc', status: 'in_progress', dependsOn: [], context: { acceptanceTests: { ...MARKER } } },
    { id: 'b1', status: 'pending', dependsOn: [], context: {} },
  ];
};

describe('acceptance gate over the real task shape (R-79)', () => {
  it('recognises the marker-object task and lists tests recorded inside it', () => {
    expect(isAcceptanceTask({ context: { acceptanceTests: MARKER } })).toBe(true);
    expect(isAcceptanceTask({ context: {} })).toBe(false);
    const tests = [{ checkId: 'AC-1', name: 'n', startingResult: 'fail' }];
    expect(testsFromContext({ acceptanceTests: { ...MARKER, tests } })).toEqual(tests);
    expect(testsFromContext({ acceptanceTests: MARKER })).toEqual([]);
    expect(testsFromContext({ acceptanceTests: tests })).toEqual(tests); // older array shape
  });

  it('load finds the task instead of answering "none"', async () => {
    fresh();
    const state = await dbGateStore.load('m1');
    expect(state?.acceptanceTask.id).toBe('acc');
    expect(state?.buildingTasks.map((t) => t.id)).toEqual(['b1']);
  });

  it('an objection holds the building task and reopens the acceptance task', async () => {
    fresh();
    const out = await recordAcceptanceObjection(dbGateStore, 'm1', true);
    expect(out).toEqual({ decision: 'hold', held: ['b1'] });
    expect(updates.some((u) => Array.isArray(u.set.dependsOn) && u.set.dependsOn.includes('acc'))).toBe(true);
    expect(updates.some((u) => u.set.status === 'pending')).toBe(true);
    expect(rows[0].context.acceptanceObjection).toBe(true);
    expect(rows[0].context.acceptanceTests).toEqual(MARKER); // marker stays an object
  });

  it('recorded results keep the marker object and are read back', async () => {
    fresh();
    await dbGateStore.patchContext('acc', { acceptanceTests: [{ checkId: 'AC-1', name: 'n', startingResult: 'fail' }] });
    expect(rows[0].context.acceptanceTests.specId).toBe('s1');
    expect(testsFromContext(rows[0].context)).toHaveLength(1);
  });
});
