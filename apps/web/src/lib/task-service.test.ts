import { describe, it, expect, beforeEach, mock } from 'bun:test';

// Mock functions with proper typing
const mockAccountsFindFirst = mock(() => null as any);
const mockWorkersFindFirst = mock(() => null as any);
const mockWorkspacesFindFirst = mock(() => null as any);
// teamMembers.findMany and teams.findFirst back getUserTeamIds without mocking @/lib/team-access
const mockTeamMembersFindMany = mock(async () => [{ teamId: 'team-1' }] as any[]);
const mockTeamsFindFirst = mock(async () => null as any);
const mockTasksFindFirst = mock(async () => null as any);
const mockMissionsFindFirst = mock(async () => null as any);

// Mock the database module
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      accounts: {
        findFirst: mockAccountsFindFirst,
      },
      workers: {
        findFirst: mockWorkersFindFirst,
      },
      workspaces: {
        findFirst: mockWorkspacesFindFirst,
      },
      teamMembers: {
        findMany: mockTeamMembersFindMany,
      },
      teams: {
        findFirst: mockTeamsFindFirst,
      },
      tasks: {
        findFirst: mockTasksFindFirst,
      },
      missions: {
        findFirst: mockMissionsFindFirst,
      },
      taskSchedules: {
        findFirst: mock(async () => null as any),
      },
    },
  },
}));

import { resolveCreatorContext, resolveCreationSource, resolveMissionCreator } from './task-service';

describe('task-service', () => {
  beforeEach(() => {
    mockAccountsFindFirst.mockReset();
    mockWorkersFindFirst.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockTeamMembersFindMany.mockReset();
    mockTeamMembersFindMany.mockResolvedValue([{ teamId: 'team-1' }]);
    mockTeamsFindFirst.mockReset();
    mockTeamsFindFirst.mockResolvedValue(null);
  });

  describe('resolveCreationSource', () => {
    it('returns explicit source when valid', () => {
      expect(resolveCreationSource('mcp', null, null)).toBe('mcp');
      expect(resolveCreationSource('dashboard', null, null)).toBe('dashboard');
      expect(resolveCreationSource('github', null, null)).toBe('github');
      expect(resolveCreationSource('local_ui', null, null)).toBe('local_ui');
      expect(resolveCreationSource('api', null, null)).toBe('api');
    });

    it('ignores invalid source values', () => {
      expect(resolveCreationSource('invalid', null, null)).toBe('api');
      expect(resolveCreationSource('unknown', null, null)).toBe('api');
      expect(resolveCreationSource('', null, null)).toBe('api');
    });

    it('returns "dashboard" for session auth without explicit source', () => {
      expect(resolveCreationSource(undefined, null, 'user-123')).toBe('dashboard');
    });

    it('returns "api" for API key auth without explicit source', () => {
      expect(resolveCreationSource(undefined, { id: 'account-123' }, null)).toBe('api');
    });

    it('returns "api" as default when no auth context', () => {
      expect(resolveCreationSource(undefined, null, null)).toBe('api');
    });

    it('explicit source overrides session auth default', () => {
      expect(resolveCreationSource('mcp', null, 'user-123')).toBe('mcp');
    });
  });

  describe('resolveCreatorContext', () => {
    describe('createdByAccountId resolution', () => {
      it('uses API account ID when authenticated via API key', async () => {
        const result = await resolveCreatorContext({
          apiAccount: { id: 'account-123' },
        });

        expect(result.createdByAccountId).toBe('account-123');
        expect(mockAccountsFindFirst).not.toHaveBeenCalled();
      });

      it('looks up user account for session auth', async () => {
        mockAccountsFindFirst.mockResolvedValue({
          id: 'user-account-456',
        });

        const result = await resolveCreatorContext({
          userId: 'user-789',
        });

        expect(result.createdByAccountId).toBe('user-account-456');
        expect(mockAccountsFindFirst).toHaveBeenCalled();
      });

      it('returns null if user has no account', async () => {
        mockAccountsFindFirst.mockResolvedValue(null);

        const result = await resolveCreatorContext({
          userId: 'user-789',
        });

        expect(result.createdByAccountId).toBeNull();
      });

      it('returns null when no auth context provided', async () => {
        const result = await resolveCreatorContext({});

        expect(result.createdByAccountId).toBeNull();
      });

      it('prefers API account over user ID when both provided', async () => {
        const result = await resolveCreatorContext({
          apiAccount: { id: 'api-account' },
          userId: 'user-123',
        });

        expect(result.createdByAccountId).toBe('api-account');
        expect(mockAccountsFindFirst).not.toHaveBeenCalled();
      });
    });

    describe('creationSource resolution', () => {
      it('defaults to "api" for API key auth', async () => {
        const result = await resolveCreatorContext({
          apiAccount: { id: 'account-123' },
        });

        expect(result.creationSource).toBe('api');
      });

      it('defaults to "dashboard" for session auth', async () => {
        mockAccountsFindFirst.mockResolvedValue({
          id: 'acc',
        });

        const result = await resolveCreatorContext({
          userId: 'user-123',
        });

        expect(result.creationSource).toBe('dashboard');
      });

      it('respects explicit creationSource', async () => {
        const result = await resolveCreatorContext({
          apiAccount: { id: 'account-123' },
          creationSource: 'mcp',
        });

        expect(result.creationSource).toBe('mcp');
      });

      it('ignores invalid creationSource values', async () => {
        const result = await resolveCreatorContext({
          apiAccount: { id: 'account-123' },
          creationSource: 'invalid-source',
        });

        expect(result.creationSource).toBe('api');
      });
    });

    describe('createdByWorkerId validation', () => {
      it('validates worker belongs to authenticated API account', async () => {
        mockWorkersFindFirst.mockResolvedValue({
          id: 'worker-1',
          accountId: 'account-123',
          taskId: 'parent-task-1',
          workspaceId: 'ws-1',
        });

        const result = await resolveCreatorContext({
          apiAccount: { id: 'account-123' },
          createdByWorkerId: 'worker-1',
        });

        expect(result.createdByWorkerId).toBe('worker-1');
      });

      it('rejects worker from different account', async () => {
        mockWorkersFindFirst.mockResolvedValue({
          id: 'worker-1',
          accountId: 'different-account',
          taskId: 'parent-task-1',
          workspaceId: 'ws-1',
        });

        const result = await resolveCreatorContext({
          apiAccount: { id: 'account-123' },
          createdByWorkerId: 'worker-1',
        });

        expect(result.createdByWorkerId).toBeNull();
      });

      it('returns null when worker not found', async () => {
        mockWorkersFindFirst.mockResolvedValue(null);

        const result = await resolveCreatorContext({
          apiAccount: { id: 'account-123' },
          createdByWorkerId: 'nonexistent-worker',
        });

        expect(result.createdByWorkerId).toBeNull();
      });

      it('returns null when no workerId provided', async () => {
        const result = await resolveCreatorContext({
          apiAccount: { id: 'account-123' },
        });

        expect(result.createdByWorkerId).toBeNull();
        expect(mockWorkersFindFirst).not.toHaveBeenCalled();
      });

      it('validates worker via workspace ownership for session auth', async () => {
        mockAccountsFindFirst.mockResolvedValue({
          id: 'user-account',
        });
        mockWorkersFindFirst.mockResolvedValue({
          id: 'worker-1',
          accountId: 'other-account',
          taskId: 'parent-task-1',
          workspaceId: 'ws-1',
        });
        mockWorkspacesFindFirst.mockResolvedValue({
          id: 'ws-1',
          teamId: 'team-1',
        });
        // getUserTeamIds reads from mockTeamMembersFindMany (pre-set to [{teamId:'team-1'}])

        const result = await resolveCreatorContext({
          userId: 'user-123',
          createdByWorkerId: 'worker-1',
        });

        expect(result.createdByWorkerId).toBe('worker-1');
      });

      it('rejects worker when workspace not owned by user', async () => {
        mockAccountsFindFirst.mockResolvedValue({
          id: 'user-account',
        });
        mockWorkersFindFirst.mockResolvedValue({
          id: 'worker-1',
          accountId: 'other-account',
          taskId: 'parent-task-1',
          workspaceId: 'ws-1',
        });
        mockWorkspacesFindFirst.mockResolvedValue({
          id: 'ws-1',
          teamId: 'other-team',
        });
        // getUserTeamIds reads from mockTeamMembersFindMany (pre-set to [{teamId:'team-1'}])
        // workspace.teamId is 'other-team' which is not in ['team-1'] → rejected

        const result = await resolveCreatorContext({
          userId: 'user-123',
          createdByWorkerId: 'worker-1',
        });

        expect(result.createdByWorkerId).toBeNull();
      });
    });

    describe('parentTaskId derivation', () => {
      it('auto-derives from worker current task when not provided', async () => {
        mockWorkersFindFirst.mockResolvedValue({
          id: 'worker-1',
          accountId: 'account-123',
          taskId: 'parent-task-1',
          workspaceId: 'ws-1',
        });

        const result = await resolveCreatorContext({
          apiAccount: { id: 'account-123' },
          createdByWorkerId: 'worker-1',
        });

        expect(result.parentTaskId).toBe('parent-task-1');
      });

      it('uses explicit parentTaskId over derived', async () => {
        mockWorkersFindFirst.mockResolvedValue({
          id: 'worker-1',
          accountId: 'account-123',
          taskId: 'auto-parent',
          workspaceId: 'ws-1',
        });

        const result = await resolveCreatorContext({
          apiAccount: { id: 'account-123' },
          createdByWorkerId: 'worker-1',
          parentTaskId: 'explicit-parent',
        });

        expect(result.parentTaskId).toBe('explicit-parent');
      });

      it('returns null when worker has no current task', async () => {
        mockWorkersFindFirst.mockResolvedValue({
          id: 'worker-1',
          accountId: 'account-123',
          taskId: null,
          workspaceId: 'ws-1',
        });

        const result = await resolveCreatorContext({
          apiAccount: { id: 'account-123' },
          createdByWorkerId: 'worker-1',
        });

        expect(result.parentTaskId).toBeNull();
      });

      it('returns null when no worker context', async () => {
        const result = await resolveCreatorContext({
          apiAccount: { id: 'account-123' },
        });

        expect(result.parentTaskId).toBeNull();
      });

      it('does not derive parentTaskId when worker validation fails', async () => {
        mockWorkersFindFirst.mockResolvedValue({
          id: 'worker-1',
          accountId: 'different-account',
          taskId: 'should-not-derive',
          workspaceId: 'ws-1',
        });

        const result = await resolveCreatorContext({
          apiAccount: { id: 'account-123' },
          createdByWorkerId: 'worker-1',
        });

        expect(result.parentTaskId).toBeNull();
      });
    });

    describe('full integration scenarios', () => {
      it('handles MCP task creation with worker context', async () => {
        mockWorkersFindFirst.mockResolvedValue({
          id: 'mcp-worker',
          accountId: 'account-123',
          taskId: 'current-task',
          workspaceId: 'ws-1',
        });

        const result = await resolveCreatorContext({
          apiAccount: { id: 'account-123' },
          createdByWorkerId: 'mcp-worker',
          creationSource: 'mcp',
        });

        expect(result).toEqual({
          createdByAccountId: 'account-123',
          createdByWorkerId: 'mcp-worker',
          creationSource: 'mcp',
          parentTaskId: 'current-task',
          createdByUserId: null,
        });
      });

      it('handles dashboard task creation', async () => {
        mockAccountsFindFirst.mockResolvedValue({
          id: 'user-account',
        });

        const result = await resolveCreatorContext({
          userId: 'user-123',
        });

        expect(result).toEqual({
          createdByAccountId: 'user-account',
          createdByWorkerId: null,
          creationSource: 'dashboard',
          parentTaskId: null,
          createdByUserId: 'user-123',
        });
      });

      it('handles GitHub webhook task creation', async () => {
        const result = await resolveCreatorContext({
          creationSource: 'github',
        });

        expect(result).toEqual({
          createdByAccountId: null,
          createdByWorkerId: null,
          creationSource: 'github',
          parentTaskId: null,
          createdByUserId: null,
        });
      });
    });
  });

  describe('createdByUserId (who the task is for)', () => {
    it('is the signed-in user', async () => {
      const ctx = await resolveCreatorContext({ userId: 'user-1' });
      expect(ctx.createdByUserId).toBe('user-1');
    });

    it('is the person behind an OAuth session', async () => {
      const ctx = await resolveCreatorContext({ apiAccount: { id: 'acct-1', sessionUserId: 'user-2' } });
      expect(ctx.createdByUserId).toBe('user-2');
    });

    it("leaves an agent-filed task's person to the insert trigger, so it is recorded as derived", async () => {
      mockTasksFindFirst.mockImplementation(async () => ({ createdByUserId: 'user-3' }));
      const ctx = await resolveCreatorContext({ apiAccount: { id: 'acct-1' }, parentTaskId: 'parent-1' });
      expect(ctx.createdByUserId).toBeNull();
      expect(ctx.parentTaskId).toBe('parent-1');
      mockTasksFindFirst.mockImplementation(async () => null);
    });

    it('is null for a plain API key with no parent', async () => {
      const ctx = await resolveCreatorContext({ apiAccount: { id: 'acct-1' } });
      expect(ctx.createdByUserId).toBeNull();
    });
  });
});

// Spec 7702c32a R-1/R-2, AC-1: who filed a mission (account, worker, its task)
// is recorded apart from the person it is for, and an agent filing for a
// person is never recorded as that person's direct action.
describe('resolveMissionCreator', () => {
  const agentTask = { id: 'task-agent', createdByUserId: 'user-requester', parentTaskId: null, missionId: null, scheduleId: null };

  beforeEach(() => {
    mockAccountsFindFirst.mockReset();
    mockWorkersFindFirst.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockTasksFindFirst.mockReset();
    mockTasksFindFirst.mockResolvedValue(null);
    mockMissionsFindFirst.mockReset();
    mockMissionsFindFirst.mockResolvedValue(null);
    mockTeamMembersFindMany.mockReset();
    mockTeamMembersFindMany.mockResolvedValue([{ teamId: 'team-1' }]);
  });

  it('records a signed-in person as an explicit request', async () => {
    mockAccountsFindFirst.mockResolvedValue({ id: 'acct-user' });
    expect(await resolveMissionCreator({ user: { id: 'user-1' }, apiAccount: null })).toEqual({
      createdByUserId: 'user-1', requesterSource: 'explicit',
      createdByAccountId: 'acct-user', createdByWorkerId: null, createdByTaskId: null,
    });
  });

  it("records the person's own OAuth session as an explicit request", async () => {
    const r = await resolveMissionCreator({ user: null, apiAccount: { id: 'acct-team', sessionUserId: 'user-1', actsAs: 'person' } });
    expect(r).toMatchObject({ createdByUserId: 'user-1', requesterSource: 'explicit', createdByAccountId: 'acct-team' });
  });

  it("records an agent's mission for its task's requester as derived, with the agent as the actor", async () => {
    mockWorkersFindFirst.mockResolvedValue({ id: 'worker-1', accountId: 'acct-runner', taskId: 'task-agent' });
    mockTasksFindFirst.mockResolvedValue(agentTask);
    const r = await resolveMissionCreator({ user: null, apiAccount: { id: 'acct-runner' }, createdByWorkerId: 'worker-1' });
    expect(r).toEqual({
      createdByUserId: 'user-requester', requesterSource: 'parent',
      createdByAccountId: 'acct-runner', createdByWorkerId: 'worker-1', createdByTaskId: 'task-agent',
    });
  });

  it('never takes a per-task token as a person, even one that carries a session user', async () => {
    mockWorkersFindFirst.mockResolvedValue({ id: 'worker-1', accountId: 'acct-runner', taskId: 'task-agent' });
    mockTasksFindFirst.mockResolvedValue(agentTask);
    const r = await resolveMissionCreator({
      user: { id: 'user-cookie' },
      apiAccount: { id: 'acct-runner', sessionUserId: 'user-other', taskScope: { taskId: 'task-agent' } },
      createdByWorkerId: 'worker-1',
    });
    expect(r).toMatchObject({ createdByUserId: 'user-requester', requesterSource: 'parent', createdByTaskId: 'task-agent' });
  });

  it("records no person for an 'agent' grant with no task behind it, not the grant's user", async () => {
    const r = await resolveMissionCreator({ user: null, apiAccount: { id: 'acct-team', actsAs: 'agent', oauthUserId: 'user-1' } });
    expect(r).toEqual({ createdByUserId: null, requesterSource: 'none', createdByAccountId: 'acct-team', createdByWorkerId: null, createdByTaskId: null });
  });

  it("ignores a worker that is not the caller's", async () => {
    mockWorkersFindFirst.mockResolvedValue({ id: 'worker-x', accountId: 'acct-other', taskId: 'task-agent', workspaceId: 'ws-x' });
    mockTasksFindFirst.mockResolvedValue(agentTask);
    const r = await resolveMissionCreator({ user: null, apiAccount: { id: 'acct-runner' }, createdByWorkerId: 'worker-x' });
    expect(r).toEqual({ createdByUserId: null, requesterSource: 'none', createdByAccountId: 'acct-runner', createdByWorkerId: null, createdByTaskId: null });
  });
});

describe('resolveCreatorContext — an agent is never the person (spec 7702c32a R-2)', () => {
  beforeEach(() => {
    mockWorkersFindFirst.mockReset();
    mockTasksFindFirst.mockReset();
  });

  it('writes no person for a per-task token, whatever it carries', async () => {
    const r = await resolveCreatorContext({ apiAccount: { id: 'acct-runner', sessionUserId: 'user-1', taskScope: { taskId: 't' } } as any });
    expect(r.createdByUserId).toBeNull();
  });

  it("writes no person for an 'agent' grant", async () => {
    const r = await resolveCreatorContext({ apiAccount: { id: 'acct-team', actsAs: 'agent', oauthUserId: 'user-1' } as any });
    expect(r.createdByUserId).toBeNull();
  });

  it('a bearer key decides over a browser cookie riding along', async () => {
    const r = await resolveCreatorContext({ apiAccount: { id: 'acct-runner' }, userId: 'user-cookie' });
    expect(r.createdByUserId).toBeNull();
  });
});
