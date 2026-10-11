import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { NextRequest } from 'next/server';
import { fakeCan } from '@/lib/connector-team-auth.fixtures';

const CONNECTOR_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const mockGetCurrentUser = mock(async () => ({ id: 'user-1' }) as any);
const mockAuthenticateApiKey = mock(async () => null as any);
const mockUserTeamIds = mock(async (_u: string) => ['team-1']);
const mockConnectorFindFirst = mock(async () => ({ id: CONNECTOR_ID, teamId: 'team-1' }) as any);
const mockSecretsFindMany = mock(async () => [{ id: 'secret-1' }] as any[]);
const mockProviderDelete = mock(async (_id: string) => undefined);

// The caller's role in the connector's team; null = no membership row.
let actorRole: string | null = 'owner';
mock.module('@/lib/permissions', () => ({ can: fakeCan(() => actorRole) }));
mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@/lib/team-access', () => ({ getUserTeamIds: mockUserTeamIds }));
mock.module('@buildd/core/secrets', () => ({
  getSecretsProvider: () => ({ delete: mockProviderDelete }),
}));
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      connectors: { findFirst: mockConnectorFindFirst },
      secrets: { findMany: mockSecretsFindMany },
    },
  },
}));

const originalNodeEnv = process.env.NODE_ENV;
const { POST } = await import('./route');

const call = (headers: Record<string, string> = {}) => POST(
  new NextRequest(`https://buildd.test/api/connectors/${CONNECTOR_ID}/disconnect`, { method: 'POST', headers: new Headers(headers) }),
  { params: Promise.resolve({ id: CONNECTOR_ID }) },
);

beforeEach(() => {
  process.env.NODE_ENV = 'production';
  actorRole = 'owner';
  mockGetCurrentUser.mockReset();
  mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
  mockAuthenticateApiKey.mockReset();
  mockAuthenticateApiKey.mockResolvedValue(null);
  mockUserTeamIds.mockReset();
  mockUserTeamIds.mockResolvedValue(['team-1']);
  mockConnectorFindFirst.mockReset();
  mockConnectorFindFirst.mockResolvedValue({ id: CONNECTOR_ID, teamId: 'team-1' });
  mockSecretsFindMany.mockReset();
  mockSecretsFindMany.mockResolvedValue([{ id: 'secret-1' }]);
  mockProviderDelete.mockClear();
});
afterAll(() => { process.env.NODE_ENV = originalNodeEnv; });

// Disconnecting deletes the connector's one team-wide credential (there is no
// per-user connector credential), so it is a manage_connectors act.
describe('POST /api/connectors/[id]/disconnect', () => {
  it('refuses a plain member and deletes nothing', async () => {
    actorRole = 'member';
    const res = await call();
    expect(res.status).toBe(403);
    expect(mockProviderDelete).not.toHaveBeenCalled();
  });

  it('refuses a user with no membership row in the owning team (fails closed)', async () => {
    actorRole = null;
    const res = await call();
    expect(res.status).toBe(403);
    expect(mockProviderDelete).not.toHaveBeenCalled();
  });

  for (const role of ['admin', 'owner']) {
    it(`lets an ${role} delete the team credential`, async () => {
      actorRole = role;
      const res = await call();
      expect(res.status).toBe(200);
      expect(mockProviderDelete).toHaveBeenCalledWith('secret-1');
    });
  }

  it('lets an admin-level API key of the owning team disconnect', async () => {
    actorRole = null;
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc-1', teamId: 'team-1', level: 'admin' });
    const res = await call({ authorization: 'Bearer bld_key' });
    expect(res.status).toBe(200);
    expect(mockProviderDelete).toHaveBeenCalledWith('secret-1');
  });

  it("hides another team's connector", async () => {
    mockConnectorFindFirst.mockResolvedValue({ id: CONNECTOR_ID, teamId: 'team-2' });
    const res = await call();
    expect(res.status).toBe(404);
    expect(mockProviderDelete).not.toHaveBeenCalled();
  });
});
