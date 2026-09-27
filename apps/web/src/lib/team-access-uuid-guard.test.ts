import { describe, it, expect, beforeEach, mock } from 'bun:test';

/**
 * verifyWorkspaceAccess/verifyAccountWorkspaceAccess compare workspaceId
 * directly against the `workspaces.id` uuid column. A non-UUID throws
 * `invalid input syntax for type uuid` (22P02), which ~70 route handlers
 * across the API surface would otherwise have to guard against individually
 * before ever calling in. Guard once, here.
 */
const mockWorkspacesFindFirst = mock(() => {
  throw new Error('workspaces.findFirst should not be called for a non-UUID workspaceId');
});
const mockTeamMembersFindFirst = mock(() => {
  throw new Error('teamMembers.findFirst should not be called for a non-UUID workspaceId');
});
const mockAccountsFindFirst = mock(() => {
  throw new Error('accounts.findFirst should not be called for a non-UUID workspaceId');
});
const mockAccountWorkspacesFindFirst = mock(() => {
  throw new Error('accountWorkspaces.findFirst should not be called for a non-UUID workspaceId');
});

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workspaces: { findFirst: mockWorkspacesFindFirst },
      teamMembers: { findFirst: mockTeamMembersFindFirst },
      accounts: { findFirst: mockAccountsFindFirst },
      accountWorkspaces: { findFirst: mockAccountWorkspacesFindFirst },
    },
  },
}));

const { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } = await import('./team-access');

describe('verifyWorkspaceAccess — non-UUID workspaceId', () => {
  beforeEach(() => {
    mockWorkspacesFindFirst.mockClear();
    mockTeamMembersFindFirst.mockClear();
  });

  it('returns null without querying the db for a short id', async () => {
    expect(await verifyWorkspaceAccess('user-1', 'ws-short8')).toBeNull();
    expect(mockWorkspacesFindFirst).not.toHaveBeenCalled();
  });

  it('returns null without querying the db for a mission:<uuid>-prefixed id', async () => {
    expect(await verifyWorkspaceAccess('user-1', 'mission:11111111-1111-4111-8111-111111111111')).toBeNull();
    expect(mockWorkspacesFindFirst).not.toHaveBeenCalled();
  });
});

describe('verifyAccountWorkspaceAccess — non-UUID workspaceId', () => {
  beforeEach(() => {
    mockWorkspacesFindFirst.mockClear();
    mockAccountsFindFirst.mockClear();
    mockAccountWorkspacesFindFirst.mockClear();
  });

  it('returns false without querying the db for a short id', async () => {
    expect(await verifyAccountWorkspaceAccess('account-1', 'ws-short8')).toBe(false);
    expect(mockWorkspacesFindFirst).not.toHaveBeenCalled();
  });
});
