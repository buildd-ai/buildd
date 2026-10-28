/**
 * GET /api/health/queue (spec "Health › Queue", R-1, R-2, R-14): a signed-in
 * member's team queue, with the tab's own filters passed through to the one
 * read the page also uses.
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockUser = mock(async (): Promise<any> => null);
const mockLoad = mock(async (..._args: any[]): Promise<any> => ({ kind: 'no-team' }));

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockUser }));
mock.module('@/lib/health-queue-scope', () => ({ loadHealthQueueFor: mockLoad }));

const { GET } = await import('./route');

function req(query = '', cookie?: string) {
  return new NextRequest(new URL(`http://localhost:3000/api/health/queue${query}`), cookie ? { headers: { cookie } } : {});
}

const view = { tiles: { running: 1, slots: 2, ready: 0, waiting: 0, parked: 0, waitingByReason: { declared: 0, lane: 0, limit: 0 } } };

describe('GET /api/health/queue', () => {
  beforeEach(() => {
    mockUser.mockReset();
    mockLoad.mockReset();
    mockUser.mockResolvedValue(null);
    mockLoad.mockResolvedValue({ kind: 'no-team' });
  });

  it('401 when not signed in, and reads nothing', async () => {
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it('passes the active team cookie and the filters to the one read', async () => {
    mockUser.mockResolvedValue({ id: 'u-1' });
    mockLoad.mockResolvedValue({ kind: 'ok', view, workspace: 'ws-1', mission: 'm-1', workspaces: [] });
    const res = await GET(req('?workspace=ws-1&mission=m-1&reason=limit&page=2', 'buildd-team=team-1'));
    expect(res.status).toBe(200);
    expect(mockLoad).toHaveBeenCalledTimes(1);
    expect(mockLoad.mock.calls[0]).toEqual(['u-1', 'team-1', { workspace: 'ws-1', mission: 'm-1', reason: 'limit', page: '2' }]);
    expect(await res.json()).toEqual(view);
  });

  it('404 with no team, an empty queue with no workspaces', async () => {
    mockUser.mockResolvedValue({ id: 'u-1' });
    expect((await GET(req())).status).toBe(404);
    mockLoad.mockResolvedValue({ kind: 'no-workspaces' });
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect((await res.json()).tiles.waiting).toBe(0);
  });

  it('500 when the read fails', async () => {
    mockUser.mockResolvedValue({ id: 'u-1' });
    mockLoad.mockRejectedValue(new Error('db down'));
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('Could not load the queue. Try again.');
  });
});
