/**
 * /api/mcp-grants/[id] handler contract (real-Postgres behaviour is in
 * apps/web/tests/db/mcp-grant-management.test.ts): the signed-in person's id
 * is what reaches the library, a person upgrade is refused before anything
 * is read, and no refusal repeats an id from the request.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => Promise.resolve(null as unknown));
const mockUpdate = mock((..._a: unknown[]) => Promise.resolve({ ok: true, connection: { id: 'g' } } as unknown));
const mockRevoke = mock((..._a: unknown[]) => Promise.resolve(true));

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/mcp-grant-admin', () => ({ updateUserGrant: mockUpdate }));
mock.module('@/lib/mcp-grants', () => ({ revokeGrant: mockRevoke }));

const { PATCH, DELETE } = await import('./route');

const GRANT = '11111111-2222-4333-8444-555555555555';
const WS = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ctx = (id = GRANT) => ({ params: Promise.resolve({ id }) });
const patchReq = (body: unknown) => new NextRequest(`http://localhost/api/mcp-grants/${GRANT}`, {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});
const delReq = () => new NextRequest(`http://localhost/api/mcp-grants/${GRANT}`, { method: 'DELETE' });

beforeEach(() => {
  mockGetCurrentUser.mockReset();
  mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
  mockUpdate.mockClear();
  mockUpdate.mockResolvedValue({ ok: true, connection: { id: GRANT } });
  mockRevoke.mockClear();
  mockRevoke.mockResolvedValue(true);
});

describe('PATCH /api/mcp-grants/[id]', () => {
  it('401 without a dashboard session, and nothing is read', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    expect((await PATCH(patchReq({ access: 'read' }), ctx())).status).toBe(401);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('passes the session user, never an id from the body', async () => {
    const res = await PATCH(patchReq({ addWorkspaceIds: [WS], access: 'read' }), ctx());
    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith('user-1', GRANT, { addWorkspaceIds: [WS], removeWorkspaceIds: [], access: 'read', actsAs: undefined });
  });

  it('refuses agent to person with 403 before touching the grant', async () => {
    const res = await PATCH(patchReq({ actsAs: 'person' }), ctx());
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('person_needs_consent');
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('accepts the downgrade to agent', async () => {
    expect((await PATCH(patchReq({ actsAs: 'agent' }), ctx())).status).toBe(200);
    expect(mockUpdate.mock.calls[0][2]).toMatchObject({ actsAs: 'agent' });
  });

  it.each([
    ['not JSON', '{'],
    ['an unknown field', { userId: 'someone-else' }],
    ['an unknown kind', { actsAs: 'owner' }],
    ['an unknown access', { access: 'admin' }],
    ['ids that are not a list', { addWorkspaceIds: WS }],
    ['the same id added and removed', { addWorkspaceIds: [WS], removeWorkspaceIds: [WS] }],
    ['nothing to change', {}],
  ])('400 on %s, without echoing the body', async (_label, body) => {
    const res = await PATCH(patchReq(body), ctx());
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).not.toContain(WS);
    expect(text).not.toContain('someone-else');
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('passes the library refusal through as is', async () => {
    mockUpdate.mockResolvedValue({ ok: false, status: 403, code: 'workspace_not_accessible', error: 'One of the chosen workspaces is not available to you. Nothing was changed.' });
    const res = await PATCH(patchReq({ addWorkspaceIds: [WS] }), ctx());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('workspace_not_accessible');
    expect(JSON.stringify(body)).not.toContain(WS);
  });
});

describe('DELETE /api/mcp-grants/[id]', () => {
  it('401 without a dashboard session', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    expect((await DELETE(delReq(), ctx())).status).toBe(401);
    expect(mockRevoke).not.toHaveBeenCalled();
  });

  it('revokes as the session user', async () => {
    const res = await DELETE(delReq(), ctx());
    expect(res.status).toBe(200);
    expect(mockRevoke).toHaveBeenCalledWith(GRANT, 'user-1');
  });

  it('404 when it was not theirs, did not exist or was already revoked, naming no id', async () => {
    mockRevoke.mockResolvedValue(false);
    const res = await DELETE(delReq(), ctx());
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain(GRANT);
  });
});
