import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { NextRequest } from 'next/server';

const mockAuth = mock(async () => null as any);
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuth }));
mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mock(async () => null) }));
const mockAccess = mock(async () => true);
mock.module('@/lib/team-access', () => ({
  verifyAccountWorkspaceAccess: mockAccess,
  verifyWorkspaceAccess: mockAccess,
}));
const mockFind = mock(async () => ({ id: 'x', workspaceId: 'w' }) as any);
mock.module('@buildd/core/db', () => ({ db: { query: { failureIncidents: { findFirst: mockFind } } } }));
const mockUpdate = mock(async (..._a: any[]) => ({ id: 'x', status: 'resolved' }) as any);
mock.module('@/lib/failure-incident-store', () => ({
  createDbIncidentPort: async () => ({}),
  updateIncidentState: mockUpdate,
}));

import { POST } from './route';

const ID = '11111111-1111-4111-8111-111111111111';
const call = (body: unknown, id = ID) =>
  POST(
    new NextRequest(`http://localhost/api/health/incidents/${id}`, {
      method: 'POST',
      headers: { authorization: 'Bearer bld_x' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );

describe('POST /api/health/incidents/[id]', () => {
  beforeEach(() => {
    mockAuth.mockImplementation(async () => ({ id: 'a', level: 'admin', scopes: null }));
    mockAccess.mockImplementation(async () => true);
    mockFind.mockImplementation(async () => ({ id: ID, workspaceId: 'w' }));
    mockUpdate.mockClear();
  });

  it('401 without auth', async () => {
    mockAuth.mockImplementation(async () => null);
    expect((await call({ action: 'resolve' })).status).toBe(401);
  });

  it('403 for a non-admin token', async () => {
    mockAuth.mockImplementation(async () => ({ id: 'a', level: 'worker', scopes: null }));
    expect((await call({ action: 'resolve' })).status).toBe(403);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('400 on a bad action', async () => {
    expect((await call({ action: 'delete' })).status).toBe(400);
  });

  it('404 when the incident is in another team', async () => {
    mockAccess.mockImplementation(async () => false);
    expect((await call({ action: 'resolve' })).status).toBe(404);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('resolves through updateIncidentState', async () => {
    const res = await call({ action: 'resolve' });
    expect(res.status).toBe(200);
    expect(mockUpdate.mock.calls[0][1]).toBe(ID);
    expect(mockUpdate.mock.calls[0][2]).toEqual({ type: 'resolve' });
  });
});
