import { describe, it, expect, mock, beforeEach } from 'bun:test';

const mockEnqueue = mock(async (_p: any) => 'job-1' as string | null);
const mockSkip = mock((_site: string, _ctx: any) => {});
mock.module('@/lib/knowledge-ingest', () => ({ enqueueFullIngestJob: mockEnqueue, logIngestSkip: mockSkip }));
mock.module('@/lib/task-evidence-store', () => ({ persistTaskEvidence: async () => {} }));
mock.module('@/lib/memory-decisions', () => ({ scheduleMemoryUseLabels: () => {}, shouldLabelMemoryUses: () => false }));
mock.module('@/lib/specs/knowledge', () => ({ indexApprovedSpec: async () => {} }));
mock.module('@buildd/core/report-ops', () => ({ reportOps: mock(async () => {}) }));
mock.module('@/modules', () => ({ SUBSCRIBERS: [] }));

const { emit } = await import('./core-emit');
const { knowledgeSubscribers } = await import('./knowledge-subscribers');

const created = (over: Record<string, unknown>) =>
  emit({ type: 'workspace.created', workspaceId: 'ws-1', teamId: 't1', origin: 'o', repoUrl: null, knowledgeIngest: true, ...over } as any, { subscribers: knowledgeSubscribers });

describe('workspace.created → repo-link ingest', () => {
  beforeEach(() => { mockEnqueue.mockClear(); mockSkip.mockClear(); });

  it('queues a full ingest of the linked repo when ingest is on', async () => {
    await created({ repoUrl: 'https://github.com/user/r' });
    expect(mockEnqueue).toHaveBeenCalledWith({ workspaceId: 'ws-1', repo: 'user/r', trigger: 'repo_link' });
    expect(mockSkip).not.toHaveBeenCalled();
  });

  it('logs the skip and queues nothing when ingest is off', async () => {
    await created({ repoUrl: 'https://github.com/user/r', knowledgeIngest: false });
    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(mockSkip).toHaveBeenCalledWith('workspace_create', { workspaceId: 'ws-1' });
  });

  it('does nothing for a workspace with no repo', async () => {
    await created({});
    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(mockSkip).not.toHaveBeenCalled();
  });

  it('a failed enqueue never fails the create', async () => {
    mockEnqueue.mockImplementationOnce(async () => { throw new Error('db down'); });
    await expect(created({ repoUrl: 'https://github.com/user/r' })).resolves.toBeUndefined();
  });
});
