import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// POST /api/discrepancies/[id]/adjudicate — §13 adjudicate_discrepancy backing route.

let currentUser: any = { id: 'u-1', email: 'max@example.com' };
let apiAccountRow: any = null;
let discrepancyRow: any = null;
let workspaceAccessResult: any = { teamId: 'team-1', role: 'owner' };
let accountWorkspaceAccess = true;
let updateReturnRows: any[] = [];
let refetchedRow: any = null;
let lastUpdateSet: any = null;
let lastUpdateWhere: any = null;

mock.module('drizzle-orm', () => ({
  eq: (...args: any[]) => ({ _op: 'eq', args }),
  and: (...args: any[]) => ({ _op: 'and', args }),
}));

mock.module('@buildd/core/db/schema', () => ({
  specDiscrepancies: { id: 'id', status: 'status', direction: 'direction' },
}));

let findFirstCallCount = 0;
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      specDiscrepancies: {
        findFirst: () => {
          findFirstCallCount++;
          // First call reads the row for auth/precondition; the route's
          // race-lost path re-fetches after a failed conditional update.
          return Promise.resolve(findFirstCallCount === 1 ? discrepancyRow : refetchedRow);
        },
      },
    },
    update: (_table: any) => ({
      set: (data: any) => {
        lastUpdateSet = data;
        return {
          where: (cond: any) => {
            lastUpdateWhere = cond;
            return { returning: () => Promise.resolve(updateReturnRows) };
          },
        };
      },
    }),
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

import { POST } from './route';

function reset() {
  currentUser = { id: 'u-1', email: 'max@example.com' };
  apiAccountRow = null;
  discrepancyRow = {
    id: 'd1',
    workspaceId: 'ws-1',
    specPath: 'docs/design/x.md',
    assertionId: 'a1',
    direction: 'contradicted',
    status: 'open',
  };
  workspaceAccessResult = { teamId: 'team-1', role: 'owner' };
  accountWorkspaceAccess = true;
  updateReturnRows = [{ ...discrepancyRow }];
  refetchedRow = { ...discrepancyRow };
  findFirstCallCount = 0;
  lastUpdateSet = null;
  lastUpdateWhere = null;
}

function req(body: any) {
  return new NextRequest('http://localhost/api/discrepancies/d1/adjudicate', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}
const params = (id: string) => Promise.resolve({ id });

describe('POST /api/discrepancies/[id]/adjudicate', () => {
  beforeEach(reset);

  it('401s with neither a session nor an API key', async () => {
    currentUser = null;
    apiAccountRow = null;
    const res = await POST(req({ action: 'accept', reason: 'x' }), { params: params('d1') });
    expect(res.status).toBe(401);
  });

  it('403s for a non-admin API key', async () => {
    currentUser = null;
    apiAccountRow = { id: 'acct-1', level: 'worker' };
    const res = await POST(req({ action: 'accept', reason: 'x' }), { params: params('d1') });
    expect(res.status).toBe(403);
  });

  it('404s when the row does not exist', async () => {
    discrepancyRow = null;
    const res = await POST(req({ action: 'accept', reason: 'x' }), { params: params('missing') });
    expect(res.status).toBe(404);
  });

  it('404s when the user lacks access to the row\'s workspace', async () => {
    workspaceAccessResult = null;
    const res = await POST(req({ action: 'accept', reason: 'x' }), { params: params('d1') });
    expect(res.status).toBe(404);
  });

  it('400s accept without a reason', async () => {
    const res = await POST(req({ action: 'accept' }), { params: params('d1') });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/non-blank/);
  });

  it('accepts with a reason', async () => {
    updateReturnRows = [{ ...discrepancyRow, status: 'accepted', acceptedReason: 'deferred' }];
    const res = await POST(req({ action: 'accept', reason: 'deferred' }), { params: params('d1') });
    expect(res.status).toBe(200);
    expect(lastUpdateSet).toEqual({ status: 'accepted', acceptedReason: 'deferred' });
    const data = await res.json();
    expect(data.discrepancy.status).toBe('accepted');
  });

  it('400s flip_direction on a non-contradicted row', async () => {
    discrepancyRow.direction = 'code_ahead';
    const res = await POST(req({ action: 'flip_direction', newDirection: 'spec_ahead' }), { params: params('d1') });
    expect(res.status).toBe(400);
  });

  it('flips a contradicted row to spec_ahead', async () => {
    updateReturnRows = [{ ...discrepancyRow, direction: 'spec_ahead' }];
    const res = await POST(req({ action: 'flip_direction', newDirection: 'spec_ahead' }), { params: params('d1') });
    expect(res.status).toBe(200);
    expect(lastUpdateSet).toEqual({ direction: 'spec_ahead' });
    const data = await res.json();
    expect(data.discrepancy.direction).toBe('spec_ahead');
  });

  it('409s when the conditional update finds no matching row (race)', async () => {
    updateReturnRows = [];
    refetchedRow = { ...discrepancyRow, direction: 'code_ahead' };
    const res = await POST(req({ action: 'flip_direction', newDirection: 'spec_ahead' }), { params: params('d1') });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.discrepancy.direction).toBe('code_ahead');
  });
});
