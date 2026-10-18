/**
 * GET /api/workers/queue (spec c7410e76 R-26, AC-12): who may ask, that the
 * read is bounded by the claim's own reach (claimableWorkspaceIds), and that
 * the runner's identity (runner id, advertised roles, executor) reaches the
 * gate builder as the claim body would carry it.
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockAuthenticateApiKey = mock(async (_key: string | null, _req?: unknown): Promise<any> => null);
const mockClaimable = mock(async (_account: unknown, _ws?: string | null): Promise<string[]> => []);
const mockLoadQueue = mock(async (_input: any): Promise<any> => ({ teams: [], truncated: false }));

mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@/lib/claim-order', () => ({ claimableWorkspaceIds: mockClaimable }));
mock.module('@/lib/claim-order-queue', () => ({ loadRunnerQueue: mockLoadQueue }));

const { GET } = await import('./route');

function req(query = '', headers: Record<string, string> = { authorization: 'Bearer bld_x' }) {
  return new NextRequest(new URL(`http://localhost:3000/api/workers/queue${query}`), { headers });
}

const account = { id: 'acc-1', teamId: 'team-1', type: 'service', level: 'worker' };

describe('GET /api/workers/queue', () => {
  beforeEach(() => {
    for (const m of [mockAuthenticateApiKey, mockClaimable, mockLoadQueue]) m.mockClear();
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockClaimable.mockResolvedValue([]);
    mockLoadQueue.mockResolvedValue({ teams: [], truncated: false });
  });

  it('401 without a valid key, and reads nothing', async () => {
    const res = await GET(req('', {}));
    expect(res.status).toBe(401);
    expect(mockClaimable).not.toHaveBeenCalled();
    expect(mockLoadQueue).not.toHaveBeenCalled();
  });

  it('403 for a trigger-level key, which cannot claim either', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ ...account, level: 'trigger' });
    const res = await GET(req());
    expect(res.status).toBe(403);
    expect(mockLoadQueue).not.toHaveBeenCalled();
  });

  it('403 for a per-task token: it claims its own task and has no queue', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ ...account, taskScope: { taskId: 't-1' } });
    const res = await GET(req());
    expect(res.status).toBe(403);
    expect(mockLoadQueue).not.toHaveBeenCalled();
  });

  it('no claimable workspace: an empty queue, and no read', async () => {
    mockAuthenticateApiKey.mockResolvedValue(account);
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ teams: [], truncated: false });
    expect(mockLoadQueue).not.toHaveBeenCalled();
  });

  it('reads only the claim reach of this account, never a workspace it names', async () => {
    mockAuthenticateApiKey.mockResolvedValue(account);
    mockClaimable.mockResolvedValue(['ws-1', 'ws-2']);
    await GET(req('?workspaceId=ws-other'));
    // The whole reach, as a broad claim sees it; a query param cannot widen or move it.
    expect(mockClaimable.mock.calls[0]).toEqual([account, null]);
    expect(mockLoadQueue.mock.calls[0]![0].workspaceIds).toEqual(['ws-1', 'ws-2']);
  });

  it('passes the runner id, the advertised roles and the executor through as the claim body would', async () => {
    mockAuthenticateApiKey.mockResolvedValue(account);
    mockClaimable.mockResolvedValue(['ws-1']);
    const body = { teams: [{ teamId: 'team-1', teamName: 'Acme', estimatesOn: false, queue: [], notForRunner: [] }], truncated: false };
    mockLoadQueue.mockResolvedValue(body);
    const res = await GET(req('?runner=http%3A%2F%2Flocalhost%3A8766&skills=builder,%20writer,,&executor=host'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(body);
    expect(mockLoadQueue.mock.calls[0]![0].caller).toEqual({
      accountType: 'service', runner: 'http://localhost:8766', availableSkills: ['builder', 'writer'], executor: 'host',
    });
  });

  it('defaults to a host runner with no roles and no runner id', async () => {
    mockAuthenticateApiKey.mockResolvedValue(account);
    mockClaimable.mockResolvedValue(['ws-1']);
    await GET(req());
    expect(mockLoadQueue.mock.calls[0]![0].caller).toEqual({ accountType: 'service', runner: null, availableSkills: [], executor: 'host' });
  });

  it("names the person behind the runner key, so the queue can mark that person's own work (R-58)", async () => {
    mockAuthenticateApiKey.mockResolvedValue({ ...account, createdByUserId: 'user-1' });
    mockClaimable.mockResolvedValue(['ws-1']);
    await GET(req());
    expect(mockLoadQueue.mock.calls[0]![0].viewerUserId).toBe('user-1');
  });

  it('400 on an executor it does not know, as the claim route refuses one', async () => {
    mockAuthenticateApiKey.mockResolvedValue(account);
    mockClaimable.mockResolvedValue(['ws-1']);
    const res = await GET(req('?executor=moon'));
    expect(res.status).toBe(400);
    expect(mockLoadQueue).not.toHaveBeenCalled();
  });

  it('500 with a plain message when the read fails', async () => {
    mockAuthenticateApiKey.mockResolvedValue(account);
    mockClaimable.mockResolvedValue(['ws-1']);
    mockLoadQueue.mockRejectedValue(new Error('boom'));
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('Failed to load the queue');
  });
});
