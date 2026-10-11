/** GET /api/mcp-grants: the signed-in person's own connections only. */
import { beforeEach, describe, expect, it, mock } from 'bun:test';

const mockGetCurrentUser = mock(() => Promise.resolve(null as unknown));
const mockList = mock((..._a: unknown[]) => Promise.resolve({ connections: [], legacy: [] }));
const mockTeams = mock((..._a: unknown[]) => Promise.resolve([]));

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/mcp-grant-admin', () => ({ listUserConnections: mockList, consentTeamsForUser: mockTeams }));

const { GET } = await import('./route');

beforeEach(() => {
  mockGetCurrentUser.mockReset();
  mockList.mockClear();
  mockTeams.mockClear();
});

describe('GET /api/mcp-grants', () => {
  it('401 without a dashboard session, and nothing is read', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('reads the session user\'s connections and teams, uncached', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(mockList).toHaveBeenCalledWith('user-1');
    expect(mockTeams).toHaveBeenCalledWith('user-1');
    expect(await res.json()).toEqual({ connections: [], legacy: [], teams: [] });
  });
});
