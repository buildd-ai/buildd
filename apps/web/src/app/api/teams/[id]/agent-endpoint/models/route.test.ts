import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const TEAM = '11111111-1111-4111-8111-111111111111';
const WS = '22222222-2222-4222-8222-222222222222';
const KEY = 'sk-agent-example-1234';
const mockRequireSessionUser = mock(async () => ({ user: { id: 'u-1' } }) as any);
const mockGetUserTeamIds = mock(async () => [TEAM] as string[]);
const mockGetUserAdminTeamIds = mock(async () => [] as string[]);
const preview = { ok: true, available: true, listed: ['claude-haiku-4-5'], rows: [{ model: 'claude-haiku-4-5-20251001', tiers: ['budget'], value: 'claude-haiku-4-5', source: 'equivalent', served: true }] };
const mockPreview = mock(async (_input: any) => preview as any);
const mockSuggest = mock(async (_input: any) => [{ model: 'claude-opus-5', suggested: 'team-smart', confidence: 0.9 }] as any[]);

mock.module('@/lib/auth-helpers', () => ({ requireSessionUser: mockRequireSessionUser }));
mock.module('@/lib/team-access', () => ({ getUserTeamIds: mockGetUserTeamIds, getUserAdminTeamIds: mockGetUserAdminTeamIds }));
mock.module('@/lib/agent-endpoint-settings', () => ({ previewAgentEndpointModels: mockPreview }));
mock.module('@/lib/endpoint-model-suggest', () => ({ suggestEndpointModels: mockSuggest }));

const { POST } = await import('./route');
const { POST: SUGGEST } = await import('./suggest/route');
const ctx = (id = TEAM) => ({ params: Promise.resolve({ id }) });
const req = (body: unknown, path = 'models') => new NextRequest(`http://localhost:3000/api/teams/${TEAM}/agent-endpoint/${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const body = { kind: 'anthropic-compatible', baseUrl: 'https://litellm.example.com', apiKey: KEY, authHeader: 'authorization' };

beforeEach(() => {
  mockGetUserTeamIds.mockResolvedValue([TEAM]);
  mockGetUserAdminTeamIds.mockResolvedValue([]);
  mockPreview.mockClear();
  mockSuggest.mockClear();
});

describe('POST /api/teams/[id]/agent-endpoint/models', () => {
  it('404s a non-member and a non-UUID id; 403s a member who is not an owner/admin', async () => {
    mockGetUserTeamIds.mockResolvedValue([]);
    expect((await POST(req(body), ctx())).status).toBe(404);
    expect((await POST(req(body), ctx('short'))).status).toBe(404);
    mockGetUserTeamIds.mockResolvedValue([TEAM]);
    expect((await POST(req(body), ctx())).status).toBe(403);
    expect(mockPreview).not.toHaveBeenCalled();
  });

  it('an admin gets the model ids and rows, no-store; workspaceId is the scope; the key is never echoed', async () => {
    mockGetUserAdminTeamIds.mockResolvedValue([TEAM]);
    const res = await POST(req({ ...body, workspaceId: WS }), ctx());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(mockPreview).toHaveBeenCalledWith({ teamId: TEAM, workspaceId: WS, endpoint: body });
    const json = await res.json();
    expect(json).toEqual({ available: true, listed: preview.listed, rows: preview.rows });
    expect(JSON.stringify(json)).not.toContain(KEY);
  });

  it('a refusal passes through; a throw is a generic 500 without the key', async () => {
    mockGetUserAdminTeamIds.mockResolvedValue([TEAM]);
    mockPreview.mockResolvedValueOnce({ ok: false, status: 400, error: 'Enter the key to list this endpoint\'s models.' });
    expect((await POST(req(body), ctx())).status).toBe(400);
    mockPreview.mockRejectedValueOnce(new Error(`boom ${KEY}`));
    const res = await POST(req(body), ctx());
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain(KEY);
  });

  it('invalid JSON is a 400', async () => {
    mockGetUserAdminTeamIds.mockResolvedValue([TEAM]);
    const bad = new NextRequest(`http://localhost:3000/api/teams/${TEAM}/agent-endpoint/models`, { method: 'POST', body: 'nope' });
    expect((await POST(bad, ctx())).status).toBe(400);
  });
});

describe('POST /api/teams/[id]/agent-endpoint/models/suggest', () => {
  it('owner/admin only', async () => {
    expect((await SUGGEST(req({ listed: ['a', 'b'], models: ['m'] }, 'models/suggest'), ctx())).status).toBe(403);
    expect(mockSuggest).not.toHaveBeenCalled();
  });

  it('returns the suggestions for the session user, scoped', async () => {
    mockGetUserAdminTeamIds.mockResolvedValue([TEAM]);
    const res = await SUGGEST(req({ listed: ['a', 'b'], models: ['m'], workspaceId: WS }, 'models/suggest'), ctx());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ suggestions: [{ model: 'claude-opus-5', suggested: 'team-smart', confidence: 0.9 }] });
    expect(mockSuggest).toHaveBeenCalledWith({ teamId: TEAM, workspaceId: WS, userId: 'u-1', listed: ['a', 'b'], models: ['m'] });
  });

  it('a non-array list or a non-UUID workspace is a 400', async () => {
    mockGetUserAdminTeamIds.mockResolvedValue([TEAM]);
    expect((await SUGGEST(req({ listed: 'a', models: [] }, 'models/suggest'), ctx())).status).toBe(400);
    expect((await SUGGEST(req({ listed: [], models: [], workspaceId: 'x' }, 'models/suggest'), ctx())).status).toBe(400);
  });
});
