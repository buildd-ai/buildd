/**
 * /api/model-tiers/platform: the read is open to whoever reads the tier map,
 * the write goes through the one shared function with the caller the gate
 * resolved, and refusals come back with the function's status and code.
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const TEAM = 'team-1';

const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockRead = mock(async (_caller: unknown, _deps: unknown) => ({ tiers: [], catalogChecked: true, canWrite: false }) as any);
const mockApply = mock(async (_caller: unknown, _change: unknown, _deps: unknown) => ({ ok: true, op: 'set', tier: 'premium' }) as any);
const mockDeps = mock(() => ({ marker: 'deps' }));

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@/lib/token-route-policy', () => ({ hasTokenRouteAdminAccess: (account: { level?: string }) => account.level === 'admin' }));
mock.module('@/lib/team-access', () => ({
  getUserTeamIds: async () => [TEAM],
  verifyWorkspaceAccess: async () => ({ teamId: TEAM, role: 'owner' }),
  verifyAccountWorkspaceAccess: async () => true,
  getUserTeamRole: async () => 'owner',
  resolveActiveTeamId: async () => TEAM,
}));
mock.module('@buildd/core/db', () => ({ db: { query: { workspaces: { findFirst: async () => ({ teamId: TEAM }) } } } }));
mock.module('@/lib/admin/platform-tier-defaults-deps', () => ({ platformTierDefaultsDeps: mockDeps }));

const realLib = await import('@/lib/admin/platform-tier-defaults');
mock.module('@/lib/admin/platform-tier-defaults', () => ({
  ...realLib,
  readPlatformTierDefaults: mockRead,
  applyPlatformTierDefaultChange: mockApply,
}));

const { GET, PUT } = await import('./route');

const req = (method: string, body?: unknown, headers: Record<string, string> = {}) =>
  new NextRequest('http://localhost/api/model-tiers/platform', {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });

beforeEach(() => {
  mockGetCurrentUser.mockReset();
  mockGetCurrentUser.mockResolvedValue({ id: 'user-1', email: 'member@example.com' });
  mockAuthenticateApiKey.mockReset();
  mockAuthenticateApiKey.mockResolvedValue(null);
  mockRead.mockClear();
  mockApply.mockClear();
  mockApply.mockResolvedValue({ ok: true, op: 'set', tier: 'premium' });
});

describe('GET /api/model-tiers/platform', () => {
  it('answers a signed-in member with the view, passing the session caller', async () => {
    const res = await GET(req('GET'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tiers: [], catalogChecked: true, canWrite: false });
    expect(mockRead.mock.calls[0][0]).toEqual({ user: { id: 'user-1', email: 'member@example.com' }, account: null, principal: 'person' });
    expect(mockRead.mock.calls[0][1]).toEqual({ marker: 'deps' });
  });

  it('refuses an unauthenticated caller with 401 and a below-admin key with 403', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    expect((await GET(req('GET'))).status).toBe(401);
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acct-worker', teamId: TEAM, level: 'worker' });
    expect((await GET(req('GET', undefined, { authorization: 'Bearer bld_x' }))).status).toBe(403);
    expect(mockRead).not.toHaveBeenCalled();
  });

  it('an admin-level key reads too, as the account caller', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acct-admin', teamId: TEAM, level: 'admin' });
    const res = await GET(req('GET', undefined, { authorization: 'Bearer bld_x' }));
    expect(res.status).toBe(200);
    expect(mockRead.mock.calls[0][0]).toMatchObject({ user: null, account: { id: 'acct-admin', level: 'admin' }, principal: 'key' });
  });
});

describe('PUT /api/model-tiers/platform', () => {
  it('parses the body into a change and hands it with the caller to the shared function', async () => {
    const res = await PUT(req('PUT', { op: 'set', tier: 'premium', model: 'claude-opus-5-5', confirm: true, via: 'ui', reason: 'x' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, op: 'set', tier: 'premium' });
    const [caller, change, deps] = mockApply.mock.calls[0];
    expect(caller).toMatchObject({ user: { id: 'user-1' }, principal: 'person' });
    expect(change).toEqual({ op: 'set', tier: 'premium', model: 'claude-opus-5-5', reason: 'x', confirm: true, confirmBandChange: false, via: 'ui' });
    expect(deps).toEqual({ marker: 'deps' });
  });

  it('a bad body is 400 before the shared function runs', async () => {
    expect((await PUT(req('PUT', { op: 'set', tier: 'premium' }))).status).toBe(400);
    expect((await PUT(req('PUT', 'not json'))).status).toBe(400);
    expect((await PUT(req('PUT', { op: 'explode', tier: 'premium' }))).status).toBe(400);
    expect(mockApply).not.toHaveBeenCalled();
  });

  it('a refusal from the shared function keeps its status, code and detail', async () => {
    mockApply.mockResolvedValue({ ok: false, status: 409, code: 'spend_band_change', error: 'below the band', detail: { direction: 'below' } });
    const res = await PUT(req('PUT', { op: 'set', tier: 'premium-plus', model: 'claude-opus-5-5', confirm: true }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'below the band', code: 'spend_band_change', detail: { direction: 'below' } });
    mockApply.mockResolvedValue({ ok: false, status: 403, code: 'operator_only', error: 'buildd manages this setting.' });
    expect((await PUT(req('PUT', { op: 'clear', tier: 'premium', confirm: true }))).status).toBe(403);
  });

  it('an unauthenticated write is 401 and never reaches the shared function', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    expect((await PUT(req('PUT', { op: 'clear', tier: 'premium', confirm: true }))).status).toBe(401);
    expect(mockApply).not.toHaveBeenCalled();
  });

  it('an admin key writes as the account caller (the shared function decides whether it is a platform admin)', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acct-admin', teamId: TEAM, level: 'admin', oauthUserId: 'person-9' });
    await PUT(req('PUT', { op: 'revert', tier: 'budget', confirm: true, via: 'mcp' }, { authorization: 'Bearer bld_x' }));
    expect(mockApply.mock.calls[0][0]).toMatchObject({ user: null, account: { id: 'acct-admin', oauthUserId: 'person-9' }, principal: 'key' });
    expect(mockApply.mock.calls[0][1]).toMatchObject({ op: 'revert', via: 'mcp' });
  });
});
