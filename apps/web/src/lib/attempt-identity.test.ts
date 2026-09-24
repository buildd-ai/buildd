import { describe, it, expect, mock, beforeEach } from 'bun:test';

const mockTasksFindFirst = mock((_opts?: unknown): Promise<unknown> => Promise.resolve(null));

mock.module('@buildd/core/db', () => ({
  db: { query: { tasks: { findFirst: (opts: unknown) => mockTasksFindFirst(opts) } } },
}));

const { attemptIdentityFrom, inheritAttemptIdentity } = await import('./attempt-identity');

describe('attemptIdentityFrom', () => {
  // Regression: a request-changes / CI / conflict retry was inserted with only
  // the phase copied, so a Codex task's fix ran on Claude, a role-routed task
  // lost its role (and with it the runner filter and persona), and the kind
  // used for model routing reset to the default.
  it('copies backend, role, kind, complexity and phase from the parent', () => {
    expect(attemptIdentityFrom({
      backend: 'codex',
      roleSlug: 'builder',
      kind: 'engineering',
      complexity: 'complex',
      missionPhaseIndex: 2,
      missionPhaseLabel: 'Implementation',
    })).toEqual({
      backend: 'codex',
      roleSlug: 'builder',
      kind: 'engineering',
      complexity: 'complex',
      missionPhaseIndex: 2,
      missionPhaseLabel: 'Implementation',
    });
  });

  it('leaves backend unset for a missing parent so the column default applies', () => {
    const identity = attemptIdentityFrom(null);
    expect(identity).not.toHaveProperty('backend');
    expect(identity).toEqual({
      roleSlug: null,
      kind: null,
      complexity: null,
      missionPhaseIndex: null,
      missionPhaseLabel: null,
    });
  });

  it('drops a half-set phase instead of violating the paired-phase check', () => {
    const identity = attemptIdentityFrom({ backend: 'claude', missionPhaseIndex: 1, missionPhaseLabel: null });
    expect(identity.missionPhaseIndex).toBeNull();
    expect(identity.missionPhaseLabel).toBeNull();
  });
});

describe('inheritAttemptIdentity', () => {
  beforeEach(() => mockTasksFindFirst.mockReset());

  it('reads the parent task once and returns its identity', async () => {
    mockTasksFindFirst.mockResolvedValue({
      backend: 'codex', roleSlug: 'researcher', kind: 'research', complexity: 'simple',
      missionPhaseIndex: null, missionPhaseLabel: null,
    });
    const identity = await inheritAttemptIdentity('parent-1');
    expect(mockTasksFindFirst).toHaveBeenCalledTimes(1);
    expect(identity).toMatchObject({ backend: 'codex', roleSlug: 'researcher', kind: 'research', complexity: 'simple' });
  });

  it('returns an empty identity without a query when there is no parent', async () => {
    const identity = await inheritAttemptIdentity(null);
    expect(mockTasksFindFirst).not.toHaveBeenCalled();
    expect(identity).not.toHaveProperty('backend');
    expect(identity.roleSlug).toBeNull();
  });
});
