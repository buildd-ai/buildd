import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockLoad = mock(async (_userId: string, _opts: { fresh?: boolean }) => [] as any[]);

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
// The query, its scoping and admission are tested in lib/waiting-input.test.ts.
mock.module('@/lib/waiting-input', () => ({ loadWaitingInput: mockLoad }));

const { GET } = await import('./route');
const req = (qs = '') => new NextRequest(`http://localhost/api/tasks/waiting-input${qs}`);

describe('GET /api/tasks/waiting-input', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockLoad.mockReset();
    mockLoad.mockImplementation(async () => []);
  });

  it('returns 401 when not authenticated', async () => {
    mockGetCurrentUser.mockReturnValue(null);
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('Unauthorized');
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it("returns the signed-in user's waiting tasks, from the cache unless asked fresh", async () => {
    mockGetCurrentUser.mockReturnValue({ id: 'user-1', email: 'test@test.com' });
    mockLoad.mockImplementation(async () => [{ id: 'task-1', title: 'T', answerSent: false }]);
    const data = await (await GET(req())).json();
    expect(data.tasks.map((t: { id: string }) => t.id)).toEqual(['task-1']);
    expect(mockLoad).toHaveBeenCalledWith('user-1', { fresh: false });
  });

  it('fresh=1 skips the cached answer (an event said a task started or stopped waiting)', async () => {
    mockGetCurrentUser.mockReturnValue({ id: 'user-1', email: 'test@test.com' });
    await GET(req('?fresh=1'));
    expect(mockLoad).toHaveBeenCalledWith('user-1', { fresh: true });
  });

  it('returns 500 on a database error', async () => {
    mockGetCurrentUser.mockReturnValue({ id: 'user-1', email: 'test@test.com' });
    mockLoad.mockImplementation(async () => { throw new Error('db down'); });
    const res = await GET(req());
    expect(res.status).toBe(500);
  });
});
