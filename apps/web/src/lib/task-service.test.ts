import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveCreatorContext, resolveCreationSource } from './task-service';

// Mock the database module
vi.mock('@buildd/core/db', () => ({
  db: {
    query: {
      accounts: {
        findFirst: vi.fn(),
      },
      workers: {
        findFirst: vi.fn(),
      },
      workspaces: {
        findFirst: vi.fn(),
      },
    },
  },
}));

import { db } from '@buildd/core/db';

describe('task-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
        expect(db.query.accounts.findFirst).not.toHaveBeenCalled();
      });

      it('looks up user account for session auth', async () => {
        (db.query.accounts.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
          id: 'user-account-456',
        });

        const result = await resolveCreatorContext({
          userId: 'user-789',
        });

        expect(result.createdByAccountId).toBe('user-account-456');
        expect(db.query.accounts.findFirst).toHaveBeenCalled();
      });

      it('returns null if user has no account', async () => {
        (db.query.accounts.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);

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
        expect(db.query.accounts.findFirst).not.toHaveBeenCalled();
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
        (db.query.accounts.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
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
        (db.query.workers.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
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
        (db.query.workers.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
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
        (db.query.workers.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);

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
        expect(db.query.workers.findFirst).not.toHaveBeenCalled();
      });

      it('validates worker via workspace ownership for session auth', async () => {
        (db.query.accounts.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
          id: 'user-account',
        });
        (db.query.workers.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
          id: 'worker-1',
          accountId: 'other-account',
          taskId: 'parent-task-1',
          workspaceId: 'ws-1',
        });
        (db.query.workspaces.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
          id: 'ws-1',
          ownerId: 'user-123',
        });

        const result = await resolveCreatorContext({
          userId: 'user-123',
          createdByWorkerId: 'worker-1',
        });

        expect(result.createdByWorkerId).toBe('worker-1');
      });

      it('rejects worker when workspace not owned by user', async () => {
        (db.query.accounts.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
          id: 'user-account',
        });
        (db.query.workers.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
          id: 'worker-1',
          accountId: 'other-account',
          taskId: 'parent-task-1',
          workspaceId: 'ws-1',
        });
        (db.query.workspaces.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
          id: 'ws-1',
          ownerId: 'different-user',
        });

        const result = await resolveCreatorContext({
          userId: 'user-123',
          createdByWorkerId: 'worker-1',
        });

        expect(result.createdByWorkerId).toBeNull();
      });
    });

    describe('parentTaskId derivation', () => {
      it('auto-derives from worker current task when not provided', async () => {
        (db.query.workers.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
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
        (db.query.workers.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
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
        (db.query.workers.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
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
        (db.query.workers.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
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
        (db.query.workers.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
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
        });
      });

      it('handles dashboard task creation', async () => {
        (db.query.accounts.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
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
        });
      });
    });
  });
});
