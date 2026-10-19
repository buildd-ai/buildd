import { describe, it, expect, mock } from 'bun:test';

mock.module('@buildd/core/db', () => ({ db: {} }));
mock.module('@/lib/dispatch-authority', () => ({ announceTaskCreated: async () => {}, wakeTask: async () => {} }));
mock.module('@/lib/effective-roles', () => ({ pickEffectiveRole: async () => null }));

const { decideAcceptanceTests, holdsForAcceptanceTests, acceptanceRoleCandidates, ACCEPTANCE_TESTS_PREFIX } = await import('./acceptance-tests');

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
