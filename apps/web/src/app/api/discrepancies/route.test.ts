import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// GET /api/discrepancies — §13 list_discrepancies backing route.

let currentUser: any = { id: 'u-1', email: 'max@example.com' };
let apiAccountRow: any = null;
let workspaceAccessResult: any = { teamId: 'team-1', role: 'owner' };
let accountWorkspaceAccess = true;
let selectRows: any[] = [];

mock.module('drizzle-orm', () => ({
  eq: (...args: any[]) => ({ _op: 'eq', args }),
  and: (...args: any[]) => ({ _op: 'and', args }),
  asc: (...args: any[]) => ({ _op: 'asc', args }),
}));

mock.module('@buildd/core/db/schema', () => ({
  specDiscrepancies: {
    workspaceId: 'workspace_id',
    direction: 'direction',
    status: 'status',
    firstSeenAt: 'first_seen_at',
  },
}));

mock.module('@buildd/core/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ orderBy: () => Promise.resolve(selectRows) }) }) }),
  },
}));

mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: () => Promise.resolve(currentUser),
}));

mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: () => Promise.resolve(apiAccountRow),
}));

mock.module('@/lib/team-access', () => ({
  verifyWorkspaceAccess: () => Promise.resolve(workspaceAccessResult),
  verifyAccountWorkspaceAccess: () => Promise.resolve(accountWorkspaceAccess),
}));

import { GET } from './route';

function reset() {
  currentUser = { id: 'u-1', email: 'max@example.com' };
  apiAccountRow = null;
  workspaceAccessResult = { teamId: 'team-1', role: 'owner' };
  accountWorkspaceAccess = true;
  selectRows = [];
}

function req(qs: string) {
  return new NextRequest(`http://localhost/api/discrepancies${qs}`);
}

describe('GET /api/discrepancies', () => {
  beforeEach(reset);

  it('401s with neither a session nor an API key', async () => {
    currentUser = null;
    apiAccountRow = null;
    const res = await GET(req('?workspaceId=ws-1'));
    expect(res.status).toBe(401);
  });

  it('400s without workspaceId', async () => {
    const res = await GET(req(''));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/workspaceId/);
  });

  it('404s when the user lacks workspace access', async () => {
    workspaceAccessResult = null;
    const res = await GET(req('?workspaceId=ws-1'));
    expect(res.status).toBe(404);
  });

  it('404s when the API key lacks workspace access', async () => {
    currentUser = null;
    apiAccountRow = { id: 'acct-1', level: 'worker' };
    accountWorkspaceAccess = false;
    const res = await GET(req('?workspaceId=ws-1'));
    expect(res.status).toBe(404);
  });

  it('400s on an invalid direction filter', async () => {
    const res = await GET(req('?workspaceId=ws-1&direction=bogus'));
    expect(res.status).toBe(400);
  });

  it('400s on an invalid status filter', async () => {
    const res = await GET(req('?workspaceId=ws-1&status=bogus'));
    expect(res.status).toBe(400);
  });

  it('returns rows for a valid workspace + filters', async () => {
    selectRows = [{ id: 'd1', specPath: 'docs/x.md', assertionId: 'a1', direction: 'code_ahead', status: 'open' }];
    const res = await GET(req('?workspaceId=ws-1&direction=code_ahead&status=open'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.discrepancies).toEqual(selectRows);
  });

  it('a worker-level API key can list (read-only, not admin-gated)', async () => {
    currentUser = null;
    apiAccountRow = { id: 'acct-1', level: 'worker' };
    selectRows = [];
    const res = await GET(req('?workspaceId=ws-1'));
    expect(res.status).toBe(200);
  });
});
