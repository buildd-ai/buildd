import { describe, it, expect, beforeEach, mock } from 'bun:test';

const mockAccount = mock(async (_accountId: string, _ws: string) => false);
const mockSession = mock(async (_userId: string, _ws: string) => null as unknown);

mock.module('@/lib/team-access', () => ({
  verifyAccountWorkspaceAccess: mockAccount,
  verifyWorkspaceAccess: mockSession,
}));

const { filterReachableEvidenceBackends, viewerReachesWorkspace } = await import('./evidence-backend-access');

const rows = [
  { id: 'team', workspaceId: null },
  { id: 'linked', workspaceId: 'ws-linked' },
  { id: 'restricted', workspaceId: 'ws-restricted' },
];
const viewer = (over: object) => ({ teamId: 't', role: 'member' as const, userId: null, accountId: null, ...over });

beforeEach(() => {
  mockAccount.mockReset();
  mockSession.mockReset();
  mockAccount.mockImplementation(async (_a, ws) => ws === 'ws-linked');
  mockSession.mockImplementation(async () => ({ teamId: 't', role: 'member' }));
});

describe('filterReachableEvidenceBackends', () => {
  it('an API account sees the team default and linked workspaces, not a restricted one', async () => {
    const out = await filterReachableEvidenceBackends(viewer({ accountId: 'acct' }), rows);
    expect(out.map((r) => r.id)).toEqual(['team', 'linked']);
  });

  it('a session user is decided by workspace access', async () => {
    mockSession.mockImplementation(async (_u, ws) => (ws === 'ws-restricted' ? null : { teamId: 't', role: 'member' }));
    const out = await filterReachableEvidenceBackends(viewer({ userId: 'u-1' }), rows);
    expect(out.map((r) => r.id)).toEqual(['team', 'linked']);
    expect(mockAccount).not.toHaveBeenCalled();
  });

  it('checks each workspace once and never for the team default', async () => {
    await filterReachableEvidenceBackends(viewer({ accountId: 'acct' }), [...rows, { id: 'dup', workspaceId: 'ws-linked' }]);
    expect(mockAccount).toHaveBeenCalledTimes(2);
  });

  it('a caller with neither account nor user sees only the team default', async () => {
    const out = await filterReachableEvidenceBackends(viewer({}), rows);
    expect(out.map((r) => r.id)).toEqual(['team']);
  });
});

describe('viewerReachesWorkspace', () => {
  it('an account check wins over the session check when a viewer carries both (OAuth JWT bearer)', async () => {
    // The session check would allow it; the account is not linked to a restricted workspace.
    mockSession.mockImplementation(async () => ({ teamId: 't', role: 'admin' }));
    expect(await viewerReachesWorkspace({ accountId: 'acct', userId: 'u-1' }, 'ws-restricted')).toBe(false);
    expect(mockAccount).toHaveBeenCalledWith('acct', 'ws-restricted');
    expect(mockSession).not.toHaveBeenCalled();
  });

  it('the same precedence holds when filtering a list', async () => {
    const out = await filterReachableEvidenceBackends(viewer({ accountId: 'acct', userId: 'u-1' }), rows);
    expect(out.map((r) => r.id)).toEqual(['team', 'linked']);
    expect(mockSession).not.toHaveBeenCalled();
  });

  it('a session user without an account is decided by workspace access', async () => {
    mockSession.mockImplementation(async () => null);
    expect(await viewerReachesWorkspace({ userId: 'u-1' }, 'ws-linked')).toBe(false);
    expect(mockAccount).not.toHaveBeenCalled();
  });

  it('a caller with neither reaches nothing', async () => {
    expect(await viewerReachesWorkspace({}, 'ws-linked')).toBe(false);
  });
});
