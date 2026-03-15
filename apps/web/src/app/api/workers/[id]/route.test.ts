import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockAuthenticateApiKey = mock(() => null as any);
const mockWorkersFindFirst = mock(() => null as any);
const mockWorkersUpdate = mock(() => ({
  set: mock(() => ({
    where: mock(() => ({
      returning: mock(() => []),
    })),
  })),
}));
const mockTasksUpdate = mock(() => ({
  set: mock(() => ({
    where: mock(() => Promise.resolve()),
  })),
}));
const mockTasksFindFirst = mock(() => Promise.resolve(null));
const mockArtifactsFindMany = mock(() => Promise.resolve([]));
const mockWorkspacesFindFirst = mock(() => Promise.resolve(null));
const mockGithubReposFindFirst = mock(() => Promise.resolve(null));
const mockGithubApi = mock(() => Promise.resolve([]));
const mockTriggerEvent = mock(() => Promise.resolve());

mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mockAuthenticateApiKey,
}));

mock.module('@/lib/pusher', () => ({
  triggerEvent: mockTriggerEvent,
  channels: {
    workspace: (id: string) => `workspace-${id}`,
    task: (id: string) => `task-${id}`,
    worker: (id: string) => `worker-${id}`,
  },
  events: {
    WORKER_STARTED: 'worker:started',
    WORKER_PROGRESS: 'worker:progress',
    WORKER_COMPLETED: 'worker:completed',
    WORKER_FAILED: 'worker:failed',
  },
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: { findFirst: mockWorkersFindFirst },
      tasks: { findFirst: mockTasksFindFirst },
      artifacts: { findMany: mockArtifactsFindMany },
      workspaces: { findFirst: mockWorkspacesFindFirst },
      githubRepos: { findFirst: mockGithubReposFindFirst },
    },
    update: (table: any) => {
      if (table === 'tasks') return mockTasksUpdate();
      return mockWorkersUpdate();
    },
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  workers: 'workers',
  tasks: 'tasks',
  artifacts: 'artifacts',
  workspaces: 'workspaces',
  githubRepos: 'githubRepos',
}));

mock.module('@/lib/github', () => ({
  githubApi: mockGithubApi,
}));

mock.module('@/lib/task-dependencies', () => ({
  resolveCompletedTask: mock(() => Promise.resolve()),
}));

const mockUpsertAutoArtifact = mock(() => Promise.resolve());
const mockFormatStructuredOutput = mock((structuredOutput?: any, summary?: string) => {
  if (structuredOutput) return '## Status: ok\nFormatted output';
  if (summary) return summary;
  return '';
});

mock.module('@/lib/artifact-helpers', () => ({
  upsertAutoArtifact: mockUpsertAutoArtifact,
  formatStructuredOutput: mockFormatStructuredOutput,
}));

import { GET, PATCH } from './route';

function createMockRequest(options: {
  method?: string;
  headers?: Record<string, string>;
  body?: any;
} = {}): NextRequest {
  const { method = 'GET', headers = {}, body } = options;
  const init: RequestInit = {
    method,
    headers: new Headers(headers),
  };
  if (body) {
    init.body = JSON.stringify(body);
    (init.headers as Headers).set('content-type', 'application/json');
  }
  return new NextRequest('http://localhost:3000/api/workers/worker-1', init);
}

const mockParams = Promise.resolve({ id: 'worker-1' });

describe('GET /api/workers/[id]', () => {
  beforeEach(() => {
    mockAuthenticateApiKey.mockReset();
    mockWorkersFindFirst.mockReset();
  });

  it('returns 401 when no API key', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);

    const req = createMockRequest();
    const res = await GET(req, { params: mockParams });

    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('returns 404 when worker not found', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue(null);

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
    });
    const res = await GET(req, { params: mockParams });

    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe('Worker not found');
  });

  it('returns 403 when worker belongs to different account', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'worker-1',
      accountId: 'account-2',
    });

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
    });
    const res = await GET(req, { params: mockParams });

    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toBe('Forbidden');
  });

  it('returns worker when authenticated and authorized', async () => {
    const mockWorker = {
      id: 'worker-1',
      accountId: 'account-1',
      status: 'running',
      task: { id: 'task-1', title: 'Test Task' },
      workspace: { id: 'ws-1' },
    };
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue(mockWorker);

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
    });
    const res = await GET(req, { params: mockParams });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBe('worker-1');
    expect(data.status).toBe('running');
  });
});

describe('PATCH /api/workers/[id]', () => {
  beforeEach(() => {
    mockAuthenticateApiKey.mockReset();
    mockWorkersFindFirst.mockReset();
    mockWorkersUpdate.mockReset();
    mockTasksUpdate.mockReset();
    mockTasksFindFirst.mockReset();
    mockArtifactsFindMany.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockGithubReposFindFirst.mockReset();
    mockGithubApi.mockReset();
    mockTriggerEvent.mockReset();
    mockUpsertAutoArtifact.mockReset();
    mockFormatStructuredOutput.mockReset();

    // Defaults
    mockUpsertAutoArtifact.mockResolvedValue(undefined);
    mockFormatStructuredOutput.mockImplementation((structuredOutput?: any, summary?: string) => {
      if (structuredOutput) return '## Status: ok\nFormatted output';
      if (summary) return summary;
      return '';
    });
    mockTasksFindFirst.mockResolvedValue(null);
    mockArtifactsFindMany.mockResolvedValue([]);
    mockWorkspacesFindFirst.mockResolvedValue(null);
    mockGithubReposFindFirst.mockResolvedValue(null);
    mockGithubApi.mockResolvedValue([]);

    // Default update chain
    const updatedWorker = { id: 'worker-1', status: 'running', accountId: 'account-1', workspaceId: 'ws-1' };
    mockWorkersUpdate.mockReturnValue({
      set: mock(() => ({
        where: mock(() => ({
          returning: mock(() => [updatedWorker]),
        })),
      })),
    });

    mockTasksUpdate.mockReturnValue({
      set: mock(() => ({
        where: mock(() => Promise.resolve()),
      })),
    });
  });

  it('returns 401 when no API key', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);

    const req = createMockRequest({
      method: 'PATCH',
      body: { status: 'running' },
    });
    const res = await PATCH(req, { params: mockParams });

    expect(res.status).toBe(401);
  });

  it('returns 404 when worker not found', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue(null);

    const req = createMockRequest({
      method: 'PATCH',
      headers: { Authorization: 'Bearer bld_test' },
      body: { status: 'running' },
    });
    const res = await PATCH(req, { params: mockParams });

    expect(res.status).toBe(404);
  });

  it('returns 403 when worker belongs to different account', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'worker-1',
      accountId: 'account-2',
      status: 'running',
    });

    const req = createMockRequest({
      method: 'PATCH',
      headers: { Authorization: 'Bearer bld_test' },
      body: { status: 'running' },
    });
    const res = await PATCH(req, { params: mockParams });

    expect(res.status).toBe(403);
  });

  it('returns 409 when worker is already completed and update is not reactivation', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'worker-1',
      accountId: 'account-1',
      status: 'completed',
      workspaceId: 'ws-1',
      pendingInstructions: null,
    });

    const req = createMockRequest({
      method: 'PATCH',
      headers: { Authorization: 'Bearer bld_test' },
      body: { status: 'completed' },
    });
    const res = await PATCH(req, { params: mockParams });

    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toBe('Worker already completed');
  });

  it('allows reactivation of completed worker with running status', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'worker-1',
      accountId: 'account-1',
      status: 'completed',
      workspaceId: 'ws-1',
      pendingInstructions: null,
      taskId: 'task-1',
    });

    const req = createMockRequest({
      method: 'PATCH',
      headers: { Authorization: 'Bearer bld_test' },
      body: { status: 'running', currentAction: 'Processing follow-up...' },
    });
    const res = await PATCH(req, { params: mockParams });

    expect(res.status).toBe(200);
  });

  it('returns 409 when worker has failed and update is not reactivation', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'worker-1',
      accountId: 'account-1',
      status: 'failed',
      error: 'Reassigned',
      workspaceId: 'ws-1',
      pendingInstructions: null,
    });

    const req = createMockRequest({
      method: 'PATCH',
      headers: { Authorization: 'Bearer bld_test' },
      body: { status: 'completed' },
    });
    const res = await PATCH(req, { params: mockParams });

    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.abort).toBe(true);
  });

  it('updates worker status successfully', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'worker-1',
      accountId: 'account-1',
      status: 'running',
      workspaceId: 'ws-1',
      pendingInstructions: null,
    });

    const req = createMockRequest({
      method: 'PATCH',
      headers: { Authorization: 'Bearer bld_test' },
      body: { status: 'running', currentAction: 'Editing files' },
    });
    const res = await PATCH(req, { params: mockParams });

    expect(res.status).toBe(200);
    expect(mockTriggerEvent).toHaveBeenCalled();
  });

  it('delivers and clears pending instructions', async () => {
    const updatedWorker = {
      id: 'worker-1',
      status: 'running',
      accountId: 'account-1',
      workspaceId: 'ws-1',
    };
    mockWorkersUpdate.mockReturnValue({
      set: mock(() => ({
        where: mock(() => ({
          returning: mock(() => [updatedWorker]),
        })),
      })),
    });

    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'worker-1',
      accountId: 'account-1',
      status: 'running',
      workspaceId: 'ws-1',
      pendingInstructions: 'Do something specific',
    });

    const req = createMockRequest({
      method: 'PATCH',
      headers: { Authorization: 'Bearer bld_test' },
      body: { status: 'running' },
    });
    const res = await PATCH(req, { params: mockParams });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.instructions).toBe('Do something specific');
  });

  it('merges appendMilestones with existing milestones', async () => {
    let capturedSet: any = null;
    mockWorkersUpdate.mockReturnValue({
      set: mock((updates: any) => {
        capturedSet = updates;
        return {
          where: mock(() => ({
            returning: mock(() => [{ id: 'worker-1', status: 'running', accountId: 'account-1', workspaceId: 'ws-1' }]),
          })),
        };
      }),
    });

    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'worker-1',
      accountId: 'account-1',
      status: 'running',
      workspaceId: 'ws-1',
      milestones: [{ type: 'status', label: 'Existing', ts: 1000 }],
      pendingInstructions: null,
    });

    const req = createMockRequest({
      method: 'PATCH',
      headers: { Authorization: 'Bearer bld_test' },
      body: {
        status: 'running',
        appendMilestones: [{ type: 'status', label: 'New milestone', progress: 50, ts: 2000 }],
      },
    });
    const res = await PATCH(req, { params: mockParams });

    expect(res.status).toBe(200);
    expect(capturedSet.milestones).toHaveLength(2);
    expect(capturedSet.milestones[0].label).toBe('Existing');
    expect(capturedSet.milestones[1].label).toBe('New milestone');
    expect(capturedSet.milestones[1].progress).toBe(50);
  });

  it('caps appendMilestones at 50 entries', async () => {
    let capturedSet: any = null;
    mockWorkersUpdate.mockReturnValue({
      set: mock((updates: any) => {
        capturedSet = updates;
        return {
          where: mock(() => ({
            returning: mock(() => [{ id: 'worker-1', status: 'running', accountId: 'account-1', workspaceId: 'ws-1' }]),
          })),
        };
      }),
    });

    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    // 48 existing milestones
    const existing = Array.from({ length: 48 }, (_, i) => ({ type: 'status', label: `m${i}`, ts: i }));
    mockWorkersFindFirst.mockResolvedValue({
      id: 'worker-1',
      accountId: 'account-1',
      status: 'running',
      workspaceId: 'ws-1',
      milestones: existing,
      pendingInstructions: null,
    });

    const req = createMockRequest({
      method: 'PATCH',
      headers: { Authorization: 'Bearer bld_test' },
      body: {
        status: 'running',
        appendMilestones: [
          { type: 'status', label: 'new1', ts: 100 },
          { type: 'status', label: 'new2', ts: 101 },
          { type: 'status', label: 'new3', ts: 102 },
        ],
      },
    });
    const res = await PATCH(req, { params: mockParams });

    expect(res.status).toBe(200);
    // 48 + 3 = 51, capped to last 50
    expect(capturedSet.milestones).toHaveLength(50);
    expect(capturedSet.milestones[49].label).toBe('new3');
  });

  it('appendMilestones handles null existing milestones', async () => {
    let capturedSet: any = null;
    mockWorkersUpdate.mockReturnValue({
      set: mock((updates: any) => {
        capturedSet = updates;
        return {
          where: mock(() => ({
            returning: mock(() => [{ id: 'worker-1', status: 'running', accountId: 'account-1', workspaceId: 'ws-1' }]),
          })),
        };
      }),
    });

    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'worker-1',
      accountId: 'account-1',
      status: 'running',
      workspaceId: 'ws-1',
      milestones: null,
      pendingInstructions: null,
    });

    const req = createMockRequest({
      method: 'PATCH',
      headers: { Authorization: 'Bearer bld_test' },
      body: {
        status: 'running',
        appendMilestones: [{ type: 'status', label: 'First milestone', ts: 1000 }],
      },
    });
    const res = await PATCH(req, { params: mockParams });

    expect(res.status).toBe(200);
    expect(capturedSet.milestones).toHaveLength(1);
    expect(capturedSet.milestones[0].label).toBe('First milestone');
  });

  it('includes phases and lastQuestion in task.result on completion', async () => {
    let capturedTaskSet: any = null;
    mockTasksUpdate.mockReturnValue({
      set: mock((updates: any) => {
        capturedTaskSet = updates;
        return {
          where: mock(() => Promise.resolve()),
        };
      }),
    });

    const updatedWorker = {
      id: 'worker-1',
      status: 'completed',
      accountId: 'account-1',
      workspaceId: 'ws-1',
    };
    mockWorkersUpdate.mockReturnValue({
      set: mock(() => ({
        where: mock(() => ({
          returning: mock(() => [updatedWorker]),
        })),
      })),
    });

    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'worker-1',
      accountId: 'account-1',
      status: 'running',
      workspaceId: 'ws-1',
      taskId: 'task-1',
      branch: 'feature/test',
      milestones: [
        { type: 'phase', label: 'Exploring codebase', toolCount: 5, ts: 1000 },
        { type: 'status', label: 'Commit: fix bug', ts: 2000 },
        { type: 'phase', label: 'Running tests', toolCount: 2, ts: 3000 },
      ],
      waitingFor: { prompt: 'Which auth method?', type: 'question' },
      pendingInstructions: null,
      commitCount: 1,
      filesChanged: 3,
      linesAdded: 20,
      linesRemoved: 5,
      lastCommitSha: 'abc1234',
      prUrl: 'https://github.com/test/repo/pull/1',
      prNumber: 1,
    });

    const req = createMockRequest({
      method: 'PATCH',
      headers: { Authorization: 'Bearer bld_test' },
      body: { status: 'completed' },
    });
    const res = await PATCH(req, { params: mockParams });

    expect(res.status).toBe(200);
    expect(capturedTaskSet).not.toBeNull();
    expect(capturedTaskSet.result.phases).toHaveLength(2);
    expect(capturedTaskSet.result.phases[0].label).toBe('Exploring codebase');
    expect(capturedTaskSet.result.phases[0].toolCount).toBe(5);
    expect(capturedTaskSet.result.phases[1].label).toBe('Running tests');
    expect(capturedTaskSet.result.phases[1].toolCount).toBe(2);
    expect(capturedTaskSet.result.lastQuestion).toBe('Which auth method?');
  });

  describe('output requirement validation ordering', () => {
    it('allows completion with warning when commits exist but no PR (auto mode)', async () => {
      const updatedWorker = { id: 'worker-1', status: 'completed', accountId: 'account-1', workspaceId: 'ws-1' };
      mockWorkersUpdate.mockReturnValue({
        set: mock(() => ({
          where: mock(() => ({
            returning: mock(() => [updatedWorker]),
          })),
        })),
      });

      mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
      mockWorkersFindFirst.mockResolvedValue({
        id: 'worker-1',
        accountId: 'account-1',
        status: 'running',
        workspaceId: 'ws-1',
        taskId: 'task-1',
        branch: 'feature/test',
        commitCount: 3,
        prUrl: null,
        prNumber: null,
        pendingInstructions: null,
      });
      mockTasksFindFirst.mockResolvedValue({ id: 'task-1', outputRequirement: 'auto' });
      mockArtifactsFindMany.mockResolvedValue([]);

      const req = createMockRequest({
        method: 'PATCH',
        headers: { Authorization: 'Bearer bld_test' },
        body: { status: 'completed' },
      });
      const res = await PATCH(req, { params: mockParams });

      // auto mode allows completion with a warning instead of blocking
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.outputWarning).toContain('no tracked PR or artifact');
    });

    it('returns 400 without updating task when pr_required and no PR', async () => {
      let taskUpdateCalled = false;
      mockTasksUpdate.mockReturnValue({
        set: mock(() => {
          taskUpdateCalled = true;
          return { where: mock(() => Promise.resolve()) };
        }),
      });

      mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
      mockWorkersFindFirst.mockResolvedValue({
        id: 'worker-1',
        accountId: 'account-1',
        status: 'running',
        workspaceId: 'ws-1',
        taskId: 'task-1',
        branch: 'feature/test',
        commitCount: 0,
        prUrl: null,
        prNumber: null,
        pendingInstructions: null,
      });
      mockTasksFindFirst.mockResolvedValue({ id: 'task-1', outputRequirement: 'pr_required' });

      const req = createMockRequest({
        method: 'PATCH',
        headers: { Authorization: 'Bearer bld_test' },
        body: { status: 'completed' },
      });
      const res = await PATCH(req, { params: mockParams });

      expect(res.status).toBe(400);
      expect(taskUpdateCalled).toBe(false);
    });
  });

  describe('PR auto-detection from GitHub', () => {
    const baseWorker = {
      id: 'worker-1',
      accountId: 'account-1',
      status: 'running',
      workspaceId: 'ws-1',
      taskId: 'task-1',
      branch: 'feature/auto-pr',
      commitCount: 2,
      prUrl: null,
      prNumber: null,
      pendingInstructions: null,
      milestones: null,
      waitingFor: null,
    };

    it('auto-detects PR from GitHub and allows completion', async () => {
      let capturedTaskSet: any = null;
      mockTasksUpdate.mockReturnValue({
        set: mock((updates: any) => {
          capturedTaskSet = updates;
          return { where: mock(() => Promise.resolve()) };
        }),
      });

      const updatedWorker = { id: 'worker-1', status: 'completed', accountId: 'account-1', workspaceId: 'ws-1' };
      mockWorkersUpdate.mockReturnValue({
        set: mock(() => ({
          where: mock(() => ({
            returning: mock(() => [updatedWorker]),
          })),
        })),
      });

      mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
      // First call: initial worker lookup. Subsequent calls: freshWorker re-read
      mockWorkersFindFirst
        .mockResolvedValueOnce(baseWorker)
        .mockResolvedValueOnce({ ...baseWorker, prUrl: 'https://github.com/org/repo/pull/42', prNumber: 42 });

      mockTasksFindFirst.mockResolvedValue({ id: 'task-1', outputRequirement: 'auto' });
      mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', githubRepoId: 'repo-1' });
      mockGithubReposFindFirst.mockResolvedValue({
        id: 'repo-1',
        fullName: 'org/repo',
        installation: { installationId: 123 },
      });
      mockGithubApi.mockResolvedValue([
        { html_url: 'https://github.com/org/repo/pull/42', number: 42, state: 'open' },
      ]);

      const req = createMockRequest({
        method: 'PATCH',
        headers: { Authorization: 'Bearer bld_test' },
        body: { status: 'completed' },
      });
      const res = await PATCH(req, { params: mockParams });

      expect(res.status).toBe(200);
      // Verify GitHub API was called with correct branch
      expect(mockGithubApi).toHaveBeenCalledWith(
        123,
        '/repos/org/repo/pulls?head=org%3Afeature%2Fauto-pr&state=open',
      );
      // Verify task result includes auto-detected PR
      expect(capturedTaskSet).not.toBeNull();
      expect(capturedTaskSet.result.prUrl).toBe('https://github.com/org/repo/pull/42');
      expect(capturedTaskSet.result.prNumber).toBe(42);
    });

    it('completes with warning when no PR found on GitHub either (auto mode)', async () => {
      const updatedWorker = { id: 'worker-1', status: 'completed', accountId: 'account-1', workspaceId: 'ws-1' };
      mockWorkersUpdate.mockReturnValue({
        set: mock(() => ({
          where: mock(() => ({
            returning: mock(() => [updatedWorker]),
          })),
        })),
      });

      mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
      mockWorkersFindFirst.mockResolvedValue(baseWorker);
      mockTasksFindFirst.mockResolvedValue({ id: 'task-1', outputRequirement: 'auto' });
      mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', githubRepoId: 'repo-1' });
      mockGithubReposFindFirst.mockResolvedValue({
        id: 'repo-1',
        fullName: 'org/repo',
        installation: { installationId: 123 },
      });
      mockGithubApi.mockResolvedValue([]);

      const req = createMockRequest({
        method: 'PATCH',
        headers: { Authorization: 'Bearer bld_test' },
        body: { status: 'completed' },
      });
      const res = await PATCH(req, { params: mockParams });

      // auto mode allows completion with warning
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.outputWarning).toContain('no tracked PR or artifact');
    });

    it('completes with warning when GitHub API fails (auto mode)', async () => {
      const updatedWorker = { id: 'worker-1', status: 'completed', accountId: 'account-1', workspaceId: 'ws-1' };
      mockWorkersUpdate.mockReturnValue({
        set: mock(() => ({
          where: mock(() => ({
            returning: mock(() => [updatedWorker]),
          })),
        })),
      });

      mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
      mockWorkersFindFirst.mockResolvedValue(baseWorker);
      mockTasksFindFirst.mockResolvedValue({ id: 'task-1', outputRequirement: 'auto' });
      mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', githubRepoId: 'repo-1' });
      mockGithubReposFindFirst.mockResolvedValue({
        id: 'repo-1',
        fullName: 'org/repo',
        installation: { installationId: 123 },
      });
      mockGithubApi.mockRejectedValue(new Error('GitHub API error'));

      const req = createMockRequest({
        method: 'PATCH',
        headers: { Authorization: 'Bearer bld_test' },
        body: { status: 'completed' },
      });
      const res = await PATCH(req, { params: mockParams });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.outputWarning).toContain('no tracked PR or artifact');
    });

    it('completes with warning when worker has no branch (auto mode)', async () => {
      const updatedWorker = { id: 'worker-1', status: 'completed', accountId: 'account-1', workspaceId: 'ws-1' };
      mockWorkersUpdate.mockReturnValue({
        set: mock(() => ({
          where: mock(() => ({
            returning: mock(() => [updatedWorker]),
          })),
        })),
      });

      mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
      mockWorkersFindFirst.mockResolvedValue({ ...baseWorker, branch: null });
      mockTasksFindFirst.mockResolvedValue({ id: 'task-1', outputRequirement: 'auto' });

      const req = createMockRequest({
        method: 'PATCH',
        headers: { Authorization: 'Bearer bld_test' },
        body: { status: 'completed' },
      });
      const res = await PATCH(req, { params: mockParams });

      expect(res.status).toBe(200);
      expect(mockGithubApi).not.toHaveBeenCalled();
    });

    it('completes with warning when workspace has no GitHub repo (auto mode)', async () => {
      const updatedWorker = { id: 'worker-1', status: 'completed', accountId: 'account-1', workspaceId: 'ws-1' };
      mockWorkersUpdate.mockReturnValue({
        set: mock(() => ({
          where: mock(() => ({
            returning: mock(() => [updatedWorker]),
          })),
        })),
      });

      mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
      mockWorkersFindFirst.mockResolvedValue(baseWorker);
      mockTasksFindFirst.mockResolvedValue({ id: 'task-1', outputRequirement: 'auto' });
      mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', githubRepoId: null });

      const req = createMockRequest({
        method: 'PATCH',
        headers: { Authorization: 'Bearer bld_test' },
        body: { status: 'completed' },
      });
      const res = await PATCH(req, { params: mockParams });

      expect(res.status).toBe(200);
      expect(mockGithubApi).not.toHaveBeenCalled();
    });

    it('auto-detects PR for pr_required output requirement', async () => {
      const updatedWorker = { id: 'worker-1', status: 'completed', accountId: 'account-1', workspaceId: 'ws-1' };
      mockWorkersUpdate.mockReturnValue({
        set: mock(() => ({
          where: mock(() => ({
            returning: mock(() => [updatedWorker]),
          })),
        })),
      });

      mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
      mockWorkersFindFirst
        .mockResolvedValueOnce({ ...baseWorker, commitCount: 0 })
        .mockResolvedValueOnce({ ...baseWorker, commitCount: 0, prUrl: 'https://github.com/org/repo/pull/10', prNumber: 10 });
      mockTasksFindFirst.mockResolvedValue({ id: 'task-1', outputRequirement: 'pr_required' });
      mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', githubRepoId: 'repo-1' });
      mockGithubReposFindFirst.mockResolvedValue({
        id: 'repo-1',
        fullName: 'org/repo',
        installation: { installationId: 123 },
      });
      mockGithubApi.mockResolvedValue([
        { html_url: 'https://github.com/org/repo/pull/10', number: 10, state: 'open' },
      ]);

      const req = createMockRequest({
        method: 'PATCH',
        headers: { Authorization: 'Bearer bld_test' },
        body: { status: 'completed' },
      });
      const res = await PATCH(req, { params: mockParams });

      expect(res.status).toBe(200);
    });
  });

  it('omits phases from task.result when there are no phase milestones', async () => {
    let capturedTaskSet: any = null;
    mockTasksUpdate.mockReturnValue({
      set: mock((updates: any) => {
        capturedTaskSet = updates;
        return {
          where: mock(() => Promise.resolve()),
        };
      }),
    });

    const updatedWorker = {
      id: 'worker-1',
      status: 'completed',
      accountId: 'account-1',
      workspaceId: 'ws-1',
    };
    mockWorkersUpdate.mockReturnValue({
      set: mock(() => ({
        where: mock(() => ({
          returning: mock(() => [updatedWorker]),
        })),
      })),
    });

    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'worker-1',
      accountId: 'account-1',
      status: 'running',
      workspaceId: 'ws-1',
      taskId: 'task-1',
      branch: 'feature/test',
      milestones: [
        { type: 'status', label: 'Commit: fix', ts: 1000 },
      ],
      waitingFor: null,
      pendingInstructions: null,
    });

    const req = createMockRequest({
      method: 'PATCH',
      headers: { Authorization: 'Bearer bld_test' },
      body: { status: 'completed' },
    });
    const res = await PATCH(req, { params: mockParams });

    expect(res.status).toBe(200);
    expect(capturedTaskSet.result.phases).toBeUndefined();
    expect(capturedTaskSet.result.lastQuestion).toBeUndefined();
  });

  describe('appendMcpCalls', () => {
    it('merges new MCP calls with existing', async () => {
      let capturedSet: any = null;
      mockWorkersUpdate.mockReturnValue({
        set: mock((updates: any) => {
          capturedSet = updates;
          return {
            where: mock(() => ({
              returning: mock(() => [{ id: 'worker-1', status: 'running', accountId: 'account-1', workspaceId: 'ws-1' }]),
            })),
          };
        }),
      });

      mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
      mockWorkersFindFirst.mockResolvedValue({
        id: 'worker-1',
        accountId: 'account-1',
        status: 'running',
        workspaceId: 'ws-1',
        mcpCalls: [{ server: 'github', tool: 'list_issues', ts: 1000, ok: true }],
        pendingInstructions: null,
      });

      const req = createMockRequest({
        method: 'PATCH',
        headers: { Authorization: 'Bearer bld_test' },
        body: {
          status: 'running',
          appendMcpCalls: [{ server: 'slack', tool: 'send_message', ts: 2000, ok: true, durationMs: 150 }],
        },
      });
      const res = await PATCH(req, { params: mockParams });

      expect(res.status).toBe(200);
      expect(capturedSet.mcpCalls).toHaveLength(2);
      expect(capturedSet.mcpCalls[0].server).toBe('github');
      expect(capturedSet.mcpCalls[1].server).toBe('slack');
      expect(capturedSet.mcpCalls[1].durationMs).toBe(150);
    });

    it('caps MCP calls at 100 entries', async () => {
      let capturedSet: any = null;
      mockWorkersUpdate.mockReturnValue({
        set: mock((updates: any) => {
          capturedSet = updates;
          return {
            where: mock(() => ({
              returning: mock(() => [{ id: 'worker-1', status: 'running', accountId: 'account-1', workspaceId: 'ws-1' }]),
            })),
          };
        }),
      });

      mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
      const existing = Array.from({ length: 98 }, (_, i) => ({ server: 'gh', tool: `t${i}`, ts: i, ok: true }));
      mockWorkersFindFirst.mockResolvedValue({
        id: 'worker-1',
        accountId: 'account-1',
        status: 'running',
        workspaceId: 'ws-1',
        mcpCalls: existing,
        pendingInstructions: null,
      });

      const req = createMockRequest({
        method: 'PATCH',
        headers: { Authorization: 'Bearer bld_test' },
        body: {
          status: 'running',
          appendMcpCalls: [
            { server: 'slack', tool: 'a', ts: 200, ok: true },
            { server: 'slack', tool: 'b', ts: 201, ok: true },
            { server: 'slack', tool: 'c', ts: 202, ok: false },
          ],
        },
      });
      const res = await PATCH(req, { params: mockParams });

      expect(res.status).toBe(200);
      // 98 + 3 = 101, capped to last 100
      expect(capturedSet.mcpCalls).toHaveLength(100);
      expect(capturedSet.mcpCalls[99].tool).toBe('c');
    });

    it('handles null existing mcpCalls', async () => {
      let capturedSet: any = null;
      mockWorkersUpdate.mockReturnValue({
        set: mock((updates: any) => {
          capturedSet = updates;
          return {
            where: mock(() => ({
              returning: mock(() => [{ id: 'worker-1', status: 'running', accountId: 'account-1', workspaceId: 'ws-1' }]),
            })),
          };
        }),
      });

      mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
      mockWorkersFindFirst.mockResolvedValue({
        id: 'worker-1',
        accountId: 'account-1',
        status: 'running',
        workspaceId: 'ws-1',
        mcpCalls: null,
        pendingInstructions: null,
      });

      const req = createMockRequest({
        method: 'PATCH',
        headers: { Authorization: 'Bearer bld_test' },
        body: {
          status: 'running',
          appendMcpCalls: [{ server: 'github', tool: 'create_pr', ts: 1000, ok: true }],
        },
      });
      const res = await PATCH(req, { params: mockParams });

      expect(res.status).toBe(200);
      expect(capturedSet.mcpCalls).toHaveLength(1);
      expect(capturedSet.mcpCalls[0].server).toBe('github');
    });

    it('snapshots unique mcpServers into task.result on completion', async () => {
      let capturedTaskSet: any = null;
      mockTasksUpdate.mockReturnValue({
        set: mock((updates: any) => {
          capturedTaskSet = updates;
          return {
            where: mock(() => Promise.resolve()),
          };
        }),
      });

      const updatedWorker = { id: 'worker-1', status: 'completed', accountId: 'account-1', workspaceId: 'ws-1' };
      mockWorkersUpdate.mockReturnValue({
        set: mock(() => ({
          where: mock(() => ({
            returning: mock(() => [updatedWorker]),
          })),
        })),
      });

      mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
      mockWorkersFindFirst.mockResolvedValue({
        id: 'worker-1',
        accountId: 'account-1',
        status: 'running',
        workspaceId: 'ws-1',
        taskId: 'task-1',
        branch: 'feature/test',
        mcpCalls: [
          { server: 'github', tool: 'list_issues', ts: 1000, ok: true },
          { server: 'slack', tool: 'send_message', ts: 2000, ok: true },
          { server: 'github', tool: 'create_pr', ts: 3000, ok: true },
        ],
        milestones: null,
        waitingFor: null,
        pendingInstructions: null,
      });

      const req = createMockRequest({
        method: 'PATCH',
        headers: { Authorization: 'Bearer bld_test' },
        body: { status: 'completed' },
      });
      const res = await PATCH(req, { params: mockParams });

      expect(res.status).toBe(200);
      expect(capturedTaskSet).not.toBeNull();
      expect(capturedTaskSet.result.mcpServers).toEqual(['github', 'slack']);
    });
  });

  describe('auto-artifact creation', () => {
    it('auto-creates artifact on heartbeat task completion', async () => {
      const updatedWorker = { id: 'worker-1', status: 'completed', accountId: 'account-1', workspaceId: 'ws-1' };
      mockWorkersUpdate.mockReturnValue({
        set: mock(() => ({
          where: mock(() => ({
            returning: mock(() => [updatedWorker]),
          })),
        })),
      });

      mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
      mockWorkersFindFirst.mockResolvedValue({
        id: 'worker-1',
        accountId: 'account-1',
        status: 'running',
        workspaceId: 'ws-1',
        taskId: 'task-1',
        pendingInstructions: null,
        milestones: null,
      });

      mockTasksFindFirst.mockResolvedValue({
        id: 'task-1',
        title: 'Heartbeat check',
        context: { heartbeat: true, objectiveTitle: 'My Objective' },
        objectiveId: 'obj-123',
      });

      const req = createMockRequest({
        method: 'PATCH',
        headers: { Authorization: 'Bearer bld_test' },
        body: {
          status: 'completed',
          structuredOutput: { status: 'ok', checksPerformed: ['CI check'], actionsPerformed: [] },
        },
      });
      const res = await PATCH(req, { params: mockParams });

      expect(res.status).toBe(200);
      expect(mockUpsertAutoArtifact).toHaveBeenCalledTimes(1);
      const call = mockUpsertAutoArtifact.mock.calls[0][0] as any;
      expect(call.key).toBe('heartbeat-obj-123');
      expect(call.title).toBe('Heartbeat: My Objective');
      expect(call.type).toBe('report');
      expect(call.metadata.autoGenerated).toBe(true);
      expect(call.metadata.heartbeatStatus).toBe('ok');
    });

    it('auto-creates artifact on schedule task completion', async () => {
      const updatedWorker = { id: 'worker-1', status: 'completed', accountId: 'account-1', workspaceId: 'ws-1' };
      mockWorkersUpdate.mockReturnValue({
        set: mock(() => ({
          where: mock(() => ({
            returning: mock(() => [updatedWorker]),
          })),
        })),
      });

      mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
      mockWorkersFindFirst.mockResolvedValue({
        id: 'worker-1',
        accountId: 'account-1',
        status: 'running',
        workspaceId: 'ws-1',
        taskId: 'task-1',
        pendingInstructions: null,
        milestones: null,
      });

      mockTasksFindFirst.mockResolvedValue({
        id: 'task-1',
        title: 'Scheduled check',
        context: { scheduleId: 'sched-456', scheduleName: 'Daily check' },
      });

      const req = createMockRequest({
        method: 'PATCH',
        headers: { Authorization: 'Bearer bld_test' },
        body: {
          status: 'completed',
          summary: 'Everything looks good',
        },
      });
      const res = await PATCH(req, { params: mockParams });

      expect(res.status).toBe(200);
      expect(mockUpsertAutoArtifact).toHaveBeenCalledTimes(1);
      const call = mockUpsertAutoArtifact.mock.calls[0][0] as any;
      expect(call.key).toBe('schedule-sched-456');
      expect(call.title).toContain('Daily check');
      expect(call.type).toBe('summary');
    });

    it('does not auto-create artifact for regular tasks', async () => {
      const updatedWorker = { id: 'worker-1', status: 'completed', accountId: 'account-1', workspaceId: 'ws-1' };
      mockWorkersUpdate.mockReturnValue({
        set: mock(() => ({
          where: mock(() => ({
            returning: mock(() => [updatedWorker]),
          })),
        })),
      });

      mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
      mockWorkersFindFirst.mockResolvedValue({
        id: 'worker-1',
        accountId: 'account-1',
        status: 'running',
        workspaceId: 'ws-1',
        taskId: 'task-1',
        pendingInstructions: null,
        milestones: null,
      });

      mockTasksFindFirst.mockResolvedValue({
        id: 'task-1',
        title: 'Regular task',
        context: {},
      });

      const req = createMockRequest({
        method: 'PATCH',
        headers: { Authorization: 'Bearer bld_test' },
        body: {
          status: 'completed',
          summary: 'Done',
        },
      });
      const res = await PATCH(req, { params: mockParams });

      expect(res.status).toBe(200);
      expect(mockUpsertAutoArtifact).not.toHaveBeenCalled();
    });

    it('auto-artifact failure does not block completion', async () => {
      const updatedWorker = { id: 'worker-1', status: 'completed', accountId: 'account-1', workspaceId: 'ws-1' };
      mockWorkersUpdate.mockReturnValue({
        set: mock(() => ({
          where: mock(() => ({
            returning: mock(() => [updatedWorker]),
          })),
        })),
      });

      mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
      mockWorkersFindFirst.mockResolvedValue({
        id: 'worker-1',
        accountId: 'account-1',
        status: 'running',
        workspaceId: 'ws-1',
        taskId: 'task-1',
        pendingInstructions: null,
        milestones: null,
      });

      mockTasksFindFirst.mockResolvedValue({
        id: 'task-1',
        title: 'Heartbeat check',
        context: { heartbeat: true },
        objectiveId: 'obj-123',
      });

      mockUpsertAutoArtifact.mockRejectedValue(new Error('DB exploded'));

      const req = createMockRequest({
        method: 'PATCH',
        headers: { Authorization: 'Bearer bld_test' },
        body: {
          status: 'completed',
          structuredOutput: { status: 'ok' },
        },
      });
      const res = await PATCH(req, { params: mockParams });

      expect(res.status).toBe(200);
    });
  });
});
