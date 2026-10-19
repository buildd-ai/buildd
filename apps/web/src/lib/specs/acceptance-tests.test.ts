import { describe, it, expect, mock } from 'bun:test';

// A small in-memory tasks table behind the drizzle calls ensureAcceptanceTests makes.
let store: any[] = [];
let inserted: any[] = [];
let role: string | null = 'tester';
let roleOffered: string[] = [];
const woken: string[] = [];
const fakeDb = {
  query: {
    tasks: {
      // The hold pass asks for dependsOn; the other two reads want acceptance-tests rows only.
      findMany: async (args: any) => (args.columns.dependsOn ? store : store.filter((t) => t.context?.acceptanceTests)),
    },
    missions: { findFirst: async () => ({ id: 'm1', title: 'M', workspaceId: 'ws1', workingBranch: null, integrationBranchEnabled: false }) },
    workspaces: { findFirst: async () => ({ id: 'ws1' }) },
  },
  insert: () => ({
    values: (v: any) => ({
      returning: async () => {
        const row = { id: `acc-${inserted.length + 1}`, status: 'pending', dependsOn: [], ...v };
        inserted.push(row);
        store.push(row);
        return [{ id: row.id }];
      },
    }),
  }),
  update: () => ({
    set: (v: any) => ({ where: async () => { pendingSet = v; } }),
  }),
};
let pendingSet: any = null;
mock.module('@buildd/core/db', () => ({ db: fakeDb }));
mock.module('@/lib/dispatch-authority', () => ({ announceTaskCreated: async () => {}, wakeTask: async (id: string) => { woken.push(id); } }));
mock.module('@/lib/effective-roles', () => ({ pickEffectiveRole: async (_ws: string, c: string[]) => { roleOffered = c; return role; } }));
mock.module('@buildd/core/db/relational-sql', () => ({ sqlWhere: (x: unknown) => x }));

const { decideAcceptanceTests, holdsForAcceptanceTests, acceptanceRoleCandidates, ensureAcceptanceTests, openAcceptanceTestsTaskId, ACCEPTANCE_TESTS_PREFIX } = await import('./acceptance-tests');

// Spec 1dc6cc39 R-76 / AC-122.
describe('the acceptance-tests task is filed once per outcome spec', () => {
  it('files one when the mission has none', () => {
    expect(decideAcceptanceTests([], 's1')).toEqual({ kind: 'file' });
  });
  it('reuses an open or finished one for the same spec', () => {
    expect(decideAcceptanceTests([{ id: 't1', status: 'pending', specId: 's1' }], 's1')).toEqual({ kind: 'open', taskId: 't1' });
    expect(decideAcceptanceTests([{ id: 't1', status: 'completed', specId: 's1' }], 's1')).toEqual({ kind: 'open', taskId: 't1' });
  });
  it('files again after a failed or cancelled one, and for another spec', () => {
    expect(decideAcceptanceTests([{ id: 't1', status: 'failed', specId: 's1' }], 's1')).toEqual({ kind: 'file' });
    expect(decideAcceptanceTests([{ id: 't1', status: 'cancelled', specId: 's1' }], 's1')).toEqual({ kind: 'file' });
    expect(decideAcceptanceTests([{ id: 't1', status: 'pending', specId: 's2' }], 's1')).toEqual({ kind: 'file' });
  });
  it('titles it so a person can tell it apart', () => {
    expect(ACCEPTANCE_TESTS_PREFIX).toBe('[acceptance tests]');
  });
});

describe('every building task waits for it', () => {
  const T = (over: Record<string, unknown>) => ({ id: 'b', status: 'pending', taskClass: 'work', title: 'feat: x', dependsOn: [] as string[], ...over });
  it('adds the dependency to unstarted building tasks only', () => {
    const rows = [
      T({ id: 'b1' }),
      T({ id: 'b2', dependsOn: ['x'] }),
      T({ id: 'b3', status: 'in_progress' }),
      T({ id: 'b4', status: 'completed' }),
      T({ id: 'b5', taskClass: 'bookkeeping' }),
      T({ id: 'b6', title: '[surface audit] M' }),
      T({ id: 'acc', context: { acceptanceTests: { missionId: 'm', specId: 's1' } } }),
      T({ id: 'b7', dependsOn: ['acc'] }),
    ];
    expect(holdsForAcceptanceTests(rows as any, 'acc')).toEqual([
      { id: 'b1', dependsOn: ['acc'] },
      { id: 'b2', dependsOn: ['x', 'acc'] },
    ]);
  });
});

describe('its agent is not a builder', () => {
  it('never offers the builder role', () => {
    expect(acceptanceRoleCandidates().length).toBeGreaterThan(0);
    expect(acceptanceRoleCandidates()).not.toContain('builder');
  });
});

describe('a builder held on a failed acceptance-tests task is released', () => {
  const T = (over: Record<string, unknown>) => ({ id: 'b', status: 'pending', taskClass: 'work', title: 'feat: x', dependsOn: [] as string[], ...over });
  const ctx = { acceptanceTests: { missionId: 'm', specId: 's1' } };
  it('swaps the failed id for the new one and keeps other dependencies', () => {
    const rows = [
      T({ id: 'old', status: 'failed', context: ctx }),
      T({ id: 'old2', status: 'cancelled', context: ctx }),
      T({ id: 'new', context: ctx }),
      T({ id: 'b1', dependsOn: ['old'] }),
      T({ id: 'b2', dependsOn: ['x', 'old', 'old2'] }),
    ];
    expect(holdsForAcceptanceTests(rows as any, 'new')).toEqual([
      { id: 'b1', dependsOn: ['new'] },
      { id: 'b2', dependsOn: ['x', 'new'] },
    ]);
  });
  it('leaves a dependency on a completed acceptance-tests task alone', () => {
    const rows = [T({ id: 'done', status: 'completed', context: ctx }), T({ id: 'new', context: ctx }), T({ id: 'b1', dependsOn: ['done'] })];
    expect(holdsForAcceptanceTests(rows as any, 'new')).toEqual([{ id: 'b1', dependsOn: ['done', 'new'] }]);
  });
});

describe('ensureAcceptanceTests (selecting an outcome spec)', () => {
  const crit = { type: 'living_spec', specId: 's1', specRevisionId: 'r1', revision: 1, contentHash: 'h', label: 'Spec X' } as any;
  const reset = () => { store = []; inserted = []; role = 'tester'; roleOffered = []; woken.length = 0; };

  it('files exactly one non-builder task, and a second selection reuses it', async () => {
    reset();
    const first = await ensureAcceptanceTests('m1', crit, ['AC-1']);
    expect(first).toEqual({ kind: 'dispatched', taskId: 'acc-1' });
    expect(inserted).toHaveLength(1);
    expect(inserted[0].roleSlug).toBe('tester');
    expect(roleOffered).not.toContain('builder');
    expect(inserted[0].context.acceptanceTests.apartFrom).toBe('builder');
    expect(woken).toEqual(['acc-1']);

    const second = await ensureAcceptanceTests('m1', crit, ['AC-1']);
    expect(second).toEqual({ kind: 'open', taskId: 'acc-1' });
    expect(inserted).toHaveLength(1);
  });

  it('makes existing unstarted building tasks depend on it', async () => {
    reset();
    store.push({ id: 'b1', status: 'pending', taskClass: 'work', title: 'feat: x', dependsOn: [] });
    await ensureAcceptanceTests('m1', crit, []);
    expect(pendingSet).toEqual({ dependsOn: ['acc-1'] });
  });

  it('files nothing when no non-builder role exists, rather than a role-less task a builder could claim', async () => {
    reset();
    role = null;
    const r = await ensureAcceptanceTests('m1', crit, []);
    expect(r.kind).toBe('unavailable');
    expect(inserted).toHaveLength(0);
  });

  it('openAcceptanceTestsTaskId names the unfinished task, so a later POST /api/tasks can depend on it', async () => {
    reset();
    await ensureAcceptanceTests('m1', crit, []);
    expect(await openAcceptanceTestsTaskId('m1')).toBe('acc-1');
    store[0].status = 'failed';
    expect(await openAcceptanceTestsTaskId('m1')).toBeNull();
  });
});
