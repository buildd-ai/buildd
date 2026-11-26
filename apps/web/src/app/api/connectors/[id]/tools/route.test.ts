/**
 * GET /api/connectors/[id]/tools: a connector's tools with the gateway's
 * class and where it came from, for Settings › Team › Apps. Team members read;
 * `canManage` says whether the toggles (PATCH /api/connectors/[id]) apply.
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockGetUserTeamIds = mock(() => Promise.resolve(['team-1'] as string[]));
const mockFindFirst = mock(() => null as any);
const mockCanManage = mock(async () => true);
const mockRecent = mock(async () => [] as string[]);

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/team-access', () => ({ getUserTeamIds: mockGetUserTeamIds }));
mock.module('@/lib/connector-team-auth', () => ({ canManageTeamConnectors: mockCanManage }));
mock.module('@buildd/core/db', () => ({ db: { query: { connectors: { findFirst: mockFindFirst } } } }));
mock.module('@buildd/core/db/schema', () => ({ connectors: { id: 'id' } }));
mock.module('@/lib/connector-gateway-store', () => ({ providerSlugFor: async () => null }));
mock.module('@/lib/connector-tool-review-store', () => ({ recentUnvettedTools: mockRecent }));

const { GET } = await import('./route');

const ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const params = (id = ID) => ({ params: Promise.resolve({ id }) });
const req = (headers: Record<string, string> = {}) => new NextRequest(`http://localhost/api/connectors/${ID}/tools`, { headers });
const CONNECTOR = {
  id: ID, teamId: 'team-1', name: 'Axiom', url: 'https://mcp.axiom.co/mcp',
  discoveredMetadata: { toolPolicy: { readOnlyTools: ['otel-x'], denyTools: [] }, toolSnapshot: { at: '2026-11-25T00:00:00.000Z', tools: { 'list-things': { r: true }, 'otel-x': {} } } },
};

beforeEach(() => {
  mockGetCurrentUser.mockReset();
  mockFindFirst.mockReset();
  mockCanManage.mockReset();
  mockCanManage.mockResolvedValue(true);
  mockRecent.mockReset();
  mockRecent.mockResolvedValue(['otel-new']);
});

describe('GET /api/connectors/[id]/tools', () => {
  it('401 without a session; a key is not a session', async () => {
    expect((await GET(req(), params())).status).toBe(401);
    mockGetCurrentUser.mockResolvedValue({ id: 'u1' });
    expect((await GET(req({ authorization: 'Bearer bld_x' }), params())).status).toBe(401);
  });

  it('404 for a bad id or another team\'s connector', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u1' });
    expect((await GET(req(), params('nope'))).status).toBe(404);
    mockFindFirst.mockResolvedValue({ ...CONNECTOR, teamId: 'team-2' });
    expect((await GET(req(), params())).status).toBe(404);
  });

  it('lists each tool with class and source, refused ones included', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u1' });
    mockFindFirst.mockResolvedValue(CONNECTOR);
    const res = await GET(req(), params());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.canManage).toBe(true);
    expect(body.snapshotAt).toBe('2026-11-25T00:00:00.000Z');
    expect(body.tools.map((t: any) => [t.name, t.cls, t.source])).toEqual([
      ['list-things', 'read', 'provider'],
      ['otel-new', 'write', 'default'],
      ['otel-x', 'read', 'admin'],
    ]);
    expect(mockRecent).toHaveBeenCalledWith(ID);
  });

  it('a member reads without the toggles', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u1' });
    mockFindFirst.mockResolvedValue(CONNECTOR);
    mockCanManage.mockResolvedValue(false);
    expect((await (await GET(req(), params())).json()).canManage).toBe(false);
  });
});
