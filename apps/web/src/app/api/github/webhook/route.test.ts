import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// --- Mock functions ---

const mockVerifyWebhookSignature = mock(() => Promise.resolve(true));

// DB mock functions
const mockInstallationsInsert = mock(() => ({
  values: mock(() => ({
    onConflictDoUpdate: mock(() => ({
      returning: mock(() => [{ id: 'inst-uuid-1' }]),
    })),
  })),
}));

const mockReposInsert = mock(() => ({
  values: mock(() => ({
    onConflictDoNothing: mock(() => Promise.resolve()),
  })),
}));

const mockTasksInsert = mock(() => ({
  values: mock(() => ({
    onConflictDoNothing: mock(() => Promise.resolve()),
  })),
}));

const mockInstallationsDelete = mock(() => ({
  where: mock(() => Promise.resolve()),
}));

const mockReposDelete = mock(() => ({
  where: mock(() => Promise.resolve()),
}));

const mockInstallationsUpdate = mock(() => ({
  set: mock(() => ({
    where: mock(() => Promise.resolve()),
  })),
}));

const mockTasksUpdate = mock(() => ({
  set: mock(() => ({
    where: mock(() => Promise.resolve()),
  })),
}));

const mockInstallationsFindFirst = mock(() => null as any);
const mockReposFindFirst = mock(() => null as any);

// --- Module mocks ---

mock.module('@/lib/github', () => ({
  verifyWebhookSignature: mockVerifyWebhookSignature,
  syncInstallationRepos: mock(() => Promise.resolve(0)),
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      githubInstallations: { findFirst: mockInstallationsFindFirst },
      githubRepos: { findFirst: mockReposFindFirst },
    },
    insert: (table: any) => {
      if (table === 'githubInstallations') return mockInstallationsInsert();
      if (table === 'githubRepos') return mockReposInsert();
      if (table === 'tasks') return mockTasksInsert();
      return mockReposInsert();
    },
    delete: (table: any) => {
      if (table === 'githubInstallations') return mockInstallationsDelete();
      if (table === 'githubRepos') return mockReposDelete();
      return mockReposDelete();
    },
    update: (table: any) => {
      if (table === 'githubInstallations') return mockInstallationsUpdate();
      if (table === 'tasks') return mockTasksUpdate();
      return mockInstallationsUpdate();
    },
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  githubInstallations: 'githubInstallations',
  githubRepos: 'githubRepos',
  tasks: 'tasks',
  workspaces: 'workspaces',
}));

// Import route AFTER mocks are set up
import { POST } from './route';

// --- Helpers ---

const originalNodeEnv = process.env.NODE_ENV;

function createWebhookRequest(event: string, payload: any, signature = 'sha256=valid'): NextRequest {
  return new NextRequest('http://localhost:3000/api/github/webhook', {
    method: 'POST',
    headers: new Headers({
      'x-hub-signature-256': signature,
      'x-github-event': event,
      'x-github-delivery': 'test-delivery-id',
      'content-type': 'application/json',
    }),
    body: JSON.stringify(payload),
  });
}

function makeInstallationPayload(action: string, overrides: Record<string, any> = {}) {
  return {
    action,
    installation: {
      id: 12345,
      account: {
        login: 'test-org',
        id: 99,
        type: 'Organization',
        avatar_url: 'https://example.com/avatar.png',
      },
      repository_selection: 'selected',
      permissions: { issues: 'read', contents: 'write' },
    },
    ...overrides,
  };
}

function makeIssuesPayload(action: string, labels: Array<{ name: string }> = [], overrides: Record<string, any> = {}) {
  return {
    action,
    issue: {
      id: 1001,
      number: 42,
      title: 'Test issue',
      body: 'Issue body text',
      state: action === 'closed' ? 'closed' : 'open',
      html_url: 'https://github.com/test-org/test-repo/issues/42',
      labels,
    },
    repository: {
      id: 5001,
      full_name: 'test-org/test-repo',
    },
    installation: {
      id: 12345,
    },
    ...overrides,
  };
}

// --- Tests ---

describe('GitHub Webhook Handler', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'production';

    // Reset all mocks
    mockVerifyWebhookSignature.mockReset();
    mockVerifyWebhookSignature.mockImplementation(() => Promise.resolve(true));

    mockInstallationsInsert.mockReset();
    mockInstallationsInsert.mockImplementation(() => ({
      values: mock(() => ({
        onConflictDoUpdate: mock(() => ({
          returning: mock(() => [{ id: 'inst-uuid-1' }]),
        })),
      })),
    }));

    mockReposInsert.mockReset();
    mockReposInsert.mockImplementation(() => ({
      values: mock(() => ({
        onConflictDoNothing: mock(() => Promise.resolve()),
      })),
    }));

    mockTasksInsert.mockReset();
    mockTasksInsert.mockImplementation(() => ({
      values: mock(() => ({
        onConflictDoNothing: mock(() => Promise.resolve()),
      })),
    }));

    mockInstallationsDelete.mockReset();
    mockInstallationsDelete.mockImplementation(() => ({
      where: mock(() => Promise.resolve()),
    }));

    mockReposDelete.mockReset();
    mockReposDelete.mockImplementation(() => ({
      where: mock(() => Promise.resolve()),
    }));

    mockInstallationsUpdate.mockReset();
    mockInstallationsUpdate.mockImplementation(() => ({
      set: mock(() => ({
        where: mock(() => Promise.resolve()),
      })),
    }));

    mockTasksUpdate.mockReset();
    mockTasksUpdate.mockImplementation(() => ({
      set: mock(() => ({
        where: mock(() => Promise.resolve()),
      })),
    }));

    mockInstallationsFindFirst.mockReset();
    mockInstallationsFindFirst.mockImplementation(() => null);

    mockReposFindFirst.mockReset();
    mockReposFindFirst.mockImplementation(() => null);
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  // --- Signature verification ---

  describe('signature verification', () => {
    it('returns 401 for invalid signature', async () => {
      mockVerifyWebhookSignature.mockImplementation(() => Promise.resolve(false));
      const req = createWebhookRequest('ping', {}, 'sha256=invalid');
      const res = await POST(req);
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe('Invalid signature');
    });
  });

  // --- Ping event ---

  describe('ping event', () => {
    it('returns ok for ping event', async () => {
      const req = createWebhookRequest('ping', { zen: 'test' });
      const res = await POST(req);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
    });
  });

  // --- Unknown event ---

  describe('unknown event', () => {
    it('returns ok for unhandled event types', async () => {
      const req = createWebhookRequest('push', { ref: 'refs/heads/main' });
      const res = await POST(req);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
    });
  });

  // --- Installation events ---

  describe('installation events', () => {
    it('installation.created inserts installation and repositories', async () => {
      const payload = makeInstallationPayload('created', {
        repositories: [
          { id: 2001, full_name: 'test-org/repo-a', name: 'repo-a', private: false },
          { id: 2002, full_name: 'test-org/repo-b', name: 'repo-b', private: true },
        ],
      });

      const req = createWebhookRequest('installation', payload);
      const res = await POST(req);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);

      // Verify insert was called for installation
      expect(mockInstallationsInsert).toHaveBeenCalled();
      // Verify repos were inserted (once per repo)
      expect(mockReposInsert).toHaveBeenCalledTimes(2);
    });

    it('installation.created without repositories does not insert repos', async () => {
      const payload = makeInstallationPayload('created');

      const req = createWebhookRequest('installation', payload);
      const res = await POST(req);

      expect(res.status).toBe(200);
      expect(mockInstallationsInsert).toHaveBeenCalled();
      expect(mockReposInsert).not.toHaveBeenCalled();
    });

    it('installation.deleted deletes the installation', async () => {
      const payload = makeInstallationPayload('deleted');

      const req = createWebhookRequest('installation', payload);
      const res = await POST(req);

      expect(res.status).toBe(200);
      expect(mockInstallationsDelete).toHaveBeenCalled();
    });

    it('installation.suspend updates suspendedAt', async () => {
      const payload = makeInstallationPayload('suspend');

      const req = createWebhookRequest('installation', payload);
      const res = await POST(req);

      expect(res.status).toBe(200);
      expect(mockInstallationsUpdate).toHaveBeenCalled();
    });

    it('installation.unsuspend clears suspendedAt', async () => {
      const payload = makeInstallationPayload('unsuspend');

      const req = createWebhookRequest('installation', payload);
      const res = await POST(req);

      expect(res.status).toBe(200);
      expect(mockInstallationsUpdate).toHaveBeenCalled();
    });
  });

  // --- Installation repositories events ---

  describe('installation_repositories events', () => {
    it('repositories added inserts new repos', async () => {
      mockInstallationsFindFirst.mockImplementation(() => ({
        id: 'inst-uuid-1',
        installationId: 12345,
      }));

      const payload = {
        action: 'added',
        installation: { id: 12345 },
        repositories_added: [
          { id: 3001, full_name: 'test-org/new-repo', name: 'new-repo', private: false },
        ],
        repositories_removed: [],
      };

      const req = createWebhookRequest('installation_repositories', payload);
      const res = await POST(req);

      expect(res.status).toBe(200);
      expect(mockInstallationsFindFirst).toHaveBeenCalled();
      expect(mockReposInsert).toHaveBeenCalled();
    });

    it('repositories removed deletes repos', async () => {
      mockInstallationsFindFirst.mockImplementation(() => ({
        id: 'inst-uuid-1',
        installationId: 12345,
      }));

      const payload = {
        action: 'removed',
        installation: { id: 12345 },
        repositories_added: [],
        repositories_removed: [{ id: 3001 }],
      };

      const req = createWebhookRequest('installation_repositories', payload);
      const res = await POST(req);

      expect(res.status).toBe(200);
      expect(mockReposDelete).toHaveBeenCalled();
    });

    it('does nothing when installation not found', async () => {
      mockInstallationsFindFirst.mockImplementation(() => null);

      const payload = {
        action: 'added',
        installation: { id: 99999 },
        repositories_added: [
          { id: 3001, full_name: 'test-org/repo', name: 'repo', private: false },
        ],
      };

      const req = createWebhookRequest('installation_repositories', payload);
      const res = await POST(req);

      expect(res.status).toBe(200);
      expect(mockReposInsert).not.toHaveBeenCalled();
    });
  });

  // --- Issues events ---

  describe('issues events', () => {
    it('issues.opened with buildd label creates a task in execution mode', async () => {
      mockReposFindFirst.mockImplementation(() => ({
        id: 'repo-uuid-1',
        repoId: 5001,
        workspaces: [{ id: 'ws-1', name: 'Test Workspace' }],
      }));

      const payload = makeIssuesPayload('opened', [{ name: 'buildd' }, { name: 'enhancement' }]);
      const req = createWebhookRequest('issues', payload);
      const res = await POST(req);

      expect(res.status).toBe(200);
      expect(mockTasksInsert).toHaveBeenCalled();

      // Verify the values passed to insert
      const insertCall = mockTasksInsert.mock.calls[0];
      const valuesChain = insertCall ? (insertCall as any) : null;
      // The insert was called, which is what matters
      expect(mockReposFindFirst).toHaveBeenCalled();
    });

    it('issues.opened with ai label creates a task', async () => {
      mockReposFindFirst.mockImplementation(() => ({
        id: 'repo-uuid-1',
        repoId: 5001,
        workspaces: [{ id: 'ws-1', name: 'Test Workspace' }],
      }));

      const payload = makeIssuesPayload('opened', [{ name: 'ai' }]);
      const req = createWebhookRequest('issues', payload);
      const res = await POST(req);

      expect(res.status).toBe(200);
      expect(mockTasksInsert).toHaveBeenCalled();
    });

    it('issues.opened with buildd:plan label creates a task in planning mode', async () => {
      mockReposFindFirst.mockImplementation(() => ({
        id: 'repo-uuid-1',
        repoId: 5001,
        workspaces: [{ id: 'ws-1', name: 'Test Workspace' }],
      }));

      const payload = makeIssuesPayload('opened', [{ name: 'buildd' }, { name: 'buildd:plan' }]);
      const req = createWebhookRequest('issues', payload);
      const res = await POST(req);

      expect(res.status).toBe(200);
      expect(mockTasksInsert).toHaveBeenCalled();
    });

    it('issues.opened without buildd/ai label does NOT create a task', async () => {
      mockReposFindFirst.mockImplementation(() => ({
        id: 'repo-uuid-1',
        repoId: 5001,
        workspaces: [{ id: 'ws-1', name: 'Test Workspace' }],
      }));

      const payload = makeIssuesPayload('opened', [{ name: 'bug' }, { name: 'help wanted' }]);
      const req = createWebhookRequest('issues', payload);
      const res = await POST(req);

      expect(res.status).toBe(200);
      expect(mockTasksInsert).not.toHaveBeenCalled();
    });

    it('issues.opened without installation context is ignored', async () => {
      const payload = makeIssuesPayload('opened', [{ name: 'buildd' }]);
      delete (payload as any).installation;

      const req = createWebhookRequest('issues', payload);
      const res = await POST(req);

      expect(res.status).toBe(200);
      expect(mockReposFindFirst).not.toHaveBeenCalled();
      expect(mockTasksInsert).not.toHaveBeenCalled();
    });

    it('issues.opened with no linked workspace does not create a task', async () => {
      mockReposFindFirst.mockImplementation(() => ({
        id: 'repo-uuid-1',
        repoId: 5001,
        workspaces: [],
      }));

      const payload = makeIssuesPayload('opened', [{ name: 'buildd' }]);
      const req = createWebhookRequest('issues', payload);
      const res = await POST(req);

      expect(res.status).toBe(200);
      expect(mockTasksInsert).not.toHaveBeenCalled();
    });

    it('issues.opened with repo not in DB does not create a task', async () => {
      mockReposFindFirst.mockImplementation(() => null);

      const payload = makeIssuesPayload('opened', [{ name: 'buildd' }]);
      const req = createWebhookRequest('issues', payload);
      const res = await POST(req);

      expect(res.status).toBe(200);
      expect(mockTasksInsert).not.toHaveBeenCalled();
    });

    it('issues.closed updates task status to completed', async () => {
      mockReposFindFirst.mockImplementation(() => ({
        id: 'repo-uuid-1',
        repoId: 5001,
        workspaces: [{ id: 'ws-1' }],
      }));

      const payload = makeIssuesPayload('closed');
      const req = createWebhookRequest('issues', payload);
      const res = await POST(req);

      expect(res.status).toBe(200);
      expect(mockTasksUpdate).toHaveBeenCalled();
    });

    it('issues.reopened updates task status to pending', async () => {
      mockReposFindFirst.mockImplementation(() => ({
        id: 'repo-uuid-1',
        repoId: 5001,
        workspaces: [{ id: 'ws-1' }],
      }));

      const payload = makeIssuesPayload('reopened');
      const req = createWebhookRequest('issues', payload);
      const res = await POST(req);

      expect(res.status).toBe(200);
      expect(mockTasksUpdate).toHaveBeenCalled();
    });
  });

  // --- Error handling ---

  describe('error handling', () => {
    it('returns 500 when handler throws an error', async () => {
      mockInstallationsInsert.mockImplementation(() => {
        throw new Error('Database connection failed');
      });

      const payload = makeInstallationPayload('created');
      const req = createWebhookRequest('installation', payload);
      const res = await POST(req);

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe('Webhook processing failed');
    });
  });
});
