import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const loaders = {
  mission: mock((_id: string, _u: string) => Promise.resolve(null as any)),
  task: mock((_id: string, _u: string) => Promise.resolve(null as any)),
  pr: mock((_id: string, _u: string) => Promise.resolve(null as any)),
  question: mock((_id: string, _u: string) => Promise.resolve(null as any)),
};

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/chat-objects/load-mission-object', () => ({ loadMissionObject: loaders.mission }));
mock.module('@/lib/chat-objects/load-task-object', () => ({ loadTaskObject: loaders.task }));
mock.module('@/lib/chat-objects/load-pr-object', () => ({
  loadPrObject: loaders.pr,
  parsePrRefId: (id: string) => (/^[\w.-]+\/[\w.-]+#\d+$/.test(id) ? { repo: id.split('#')[0], number: Number(id.split('#')[1]) } : null),
}));
mock.module('@/lib/chat-objects/load-question-object', () => ({ loadQuestionObject: loaders.question }));

const { GET } = await import('./route');

const ID = '00000000-0000-4000-8000-000000000001';

function call(kind: string, id: string, query = '') {
  return GET(new NextRequest(`http://localhost:3000/api/objects/${kind}/${id}${query}`), { params: Promise.resolve({ kind, id }) });
}

describe('GET /api/objects/[kind]/[id]', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    for (const l of Object.values(loaders)) {
      l.mockReset();
      l.mockResolvedValue(null);
    }
  });

  it('401 without a session, and loads nothing', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const res = await call('mission', ID);
    expect(res.status).toBe(401);
    expect(loaders.mission).not.toHaveBeenCalled();
  });

  it('400 for a kind with no renderer', async () => {
    for (const kind of ['schedule', 'directive', 'constructor', '__proto__']) {
      const res = await call(kind, ID);
      expect(res.status).toBe(400);
    }
  });

  it('400 for a non-uuid id, before any query', async () => {
    const res = await call('task', 'not-a-uuid');
    expect(res.status).toBe(400);
    expect(loaders.task).not.toHaveBeenCalled();
  });

  it('404 when the loader finds nothing the user can see', async () => {
    const res = await call('question', ID);
    expect(res.status).toBe(404);
  });

  it.each(['mission', 'task', 'pr', 'question'] as const)('%s dispatches to its own loader with (id, userId)', async (kind) => {
    loaders[kind].mockResolvedValue({ kind, id: ID });
    const res = await call(kind, ID);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kind, id: ID });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(loaders[kind]).toHaveBeenCalledWith(ID, 'user-1');
    for (const other of Object.keys(loaders) as Array<keyof typeof loaders>) {
      if (other !== kind) expect(loaders[other]).not.toHaveBeenCalled();
    }
  });

  it('500 when a loader throws', async () => {
    loaders.mission.mockRejectedValue(new Error('db down'));
    const res = await call('mission', ID);
    expect(res.status).toBe(500);
  });

  it('a PR named by its owner/repo#n arrives as ?ref= and reaches the PR loader', async () => {
    loaders.pr.mockResolvedValue({ kind: 'pr', id: 'harborline/billing-web#413' });
    const res = await call('pr', 'ref', `?ref=${encodeURIComponent('harborline/billing-web#413')}`);
    expect(res.status).toBe(200);
    expect(loaders.pr).toHaveBeenCalledWith('harborline/billing-web#413', 'user-1');
  });

  it('the repo#n form is only accepted for PRs, and junk refs are 400', async () => {
    expect((await call('task', 'ref', '?ref=a%2Fb%231')).status).toBe(400);
    expect((await call('pr', 'ref', '?ref=not%20a%20pr')).status).toBe(400);
    expect((await call('pr', 'ref')).status).toBe(400);
    expect(loaders.pr).not.toHaveBeenCalled();
  });
});
