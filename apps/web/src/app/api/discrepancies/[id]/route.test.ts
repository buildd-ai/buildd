import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// GET /api/discrepancies/[id] — §13 get_discrepancy backing route.

let currentUser: any = { id: 'u-1', email: 'max@example.com' };
let apiAccountRow: any = null;
let discrepancyRow: any = null;
let workspaceAccessResult: any = { teamId: 'team-1', role: 'owner' };
let accountWorkspaceAccess = true;

mock.module('drizzle-orm', () => ({
  eq: (...args: any[]) => ({ _op: 'eq', args }),
}));

mock.module('@buildd/core/db/schema', () => ({
  specDiscrepancies: { id: 'id' },
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      specDiscrepancies: { findFirst: () => Promise.resolve(discrepancyRow) },
    },
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
  discrepancyRow = {
    id: 'd1',
    workspaceId: 'ws-1',
    specPath: 'docs/design/x.md',
    assertionId: 'a1',
    direction: 'code_ahead',
    status: 'open',
    evidence: { assertionType: 'symbol', outcome: 'pass' },
  };
  workspaceAccessResult = { teamId: 'team-1', role: 'owner' };
  accountWorkspaceAccess = true;
}

const req = () => new NextRequest('http://localhost/api/discrepancies/d1');
const params = (id: string) => Promise.resolve({ id });

describe('GET /api/discrepancies/[id]', () => {
  beforeEach(reset);

  it('401s with neither a session nor an API key', async () => {
    currentUser = null;
    apiAccountRow = null;
    const res = await GET(req(), { params: params('d1') });
    expect(res.status).toBe(401);
  });

  it('404s when the row does not exist', async () => {
    discrepancyRow = null;
    const res = await GET(req(), { params: params('missing') });
    expect(res.status).toBe(404);
  });

  it('404s when the user lacks access to the row\'s workspace', async () => {
    workspaceAccessResult = null;
    const res = await GET(req(), { params: params('d1') });
    expect(res.status).toBe(404);
  });

  it('returns the row including evidence', async () => {
    const res = await GET(req(), { params: params('d1') });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.discrepancy).toEqual(discrepancyRow);
  });
});
