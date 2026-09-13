import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// POST /api/discrepancies/[id]/promote — §13 promote_discrepancy backing route.

let currentUser: any = { id: 'u-1', email: 'max@example.com' };
let apiAccountRow: any = null;
let discrepancyRow: any = null;
let missionRow: any = null;
let workspaceAccessResult: any = { teamId: 'team-1', role: 'owner' };
let accountWorkspaceAccess = true;
let updateReturnRows: any[] = [];
let refetchedRow: any = null;
let lastUpdateSet: any = null;

mock.module('drizzle-orm', () => ({
  eq: (...args: any[]) => ({ _op: 'eq', args }),
  and: (...args: any[]) => ({ _op: 'and', args }),
  isNull: (...args: any[]) => ({ _op: 'isNull', args }),
}));

mock.module('@buildd/core/db/schema', () => ({
  specDiscrepancies: { id: 'id', promotedMissionId: 'promoted_mission_id', direction: 'direction' },
  missions: { id: 'id' },
}));

mock.module('@buildd/core/spec-discrepancy-ledger', () => ({
  assertPromotable: (direction: string) => {
    if (direction !== 'spec_ahead') {
      throw new Error(`Cannot promote a '${direction}' discrepancy into a mission — only spec_ahead rows may be promoted.`);
    }
  },
}));

let discrepancyFindFirstCallCount = 0;
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      specDiscrepancies: {
        findFirst: () => {
          discrepancyFindFirstCallCount++;
          return Promise.resolve(discrepancyFindFirstCallCount === 1 ? discrepancyRow : refetchedRow);
        },
      },
      missions: { findFirst: () => Promise.resolve(missionRow) },
    },
    update: (_table: any) => ({
      set: (data: any) => {
        lastUpdateSet = data;
        return { where: () => ({ returning: () => Promise.resolve(updateReturnRows) }) };
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
    direction: 'spec_ahead',
    status: 'open',
    promotedMissionId: null,
  };
  missionRow = { id: 'm1', workspaceId: 'ws-1' };
  workspaceAccessResult = { teamId: 'team-1', role: 'owner' };
  accountWorkspaceAccess = true;
  updateReturnRows = [{ ...discrepancyRow, promotedMissionId: 'm1' }];
  refetchedRow = { ...discrepancyRow };
  discrepancyFindFirstCallCount = 0;
  lastUpdateSet = null;
}

function req(body?: any) {
  return new NextRequest('http://localhost/api/discrepancies/d1/promote', {
    method: 'POST',
    body: JSON.stringify(body ?? { missionId: 'm1' }),
    headers: { 'content-type': 'application/json' },
  });
}
const params = (id: string) => Promise.resolve({ id });

describe('POST /api/discrepancies/[id]/promote', () => {
  beforeEach(reset);

  it('401s with neither a session nor an API key', async () => {
    currentUser = null;
    apiAccountRow = null;
    const res = await POST(req(), { params: params('d1') });
    expect(res.status).toBe(401);
  });

  it('403s for a non-admin API key', async () => {
    currentUser = null;
    apiAccountRow = { id: 'acct-1', level: 'worker' };
    const res = await POST(req(), { params: params('d1') });
    expect(res.status).toBe(403);
  });

  it('404s when the row does not exist', async () => {
    discrepancyRow = null;
    const res = await POST(req(), { params: params('missing') });
    expect(res.status).toBe(404);
  });

  it('404s when the user lacks access to the row\'s workspace', async () => {
    workspaceAccessResult = null;
    const res = await POST(req(), { params: params('d1') });
    expect(res.status).toBe(404);
  });

  it('is idempotent when the row is already promoted', async () => {
    discrepancyRow.promotedMissionId = 'existing-mission';
    const res = await POST(req(), { params: params('d1') });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.alreadyPromoted).toBe(true);
    expect(data.missionId).toBe('existing-mission');
  });

  it('400s without missionId', async () => {
    const res = await POST(req({}), { params: params('d1') });
    expect(res.status).toBe(400);
  });

  it('400s a code_ahead row — never promotable (§8 gate)', async () => {
    discrepancyRow.direction = 'code_ahead';
    const res = await POST(req(), { params: params('d1') });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/code_ahead/);
  });

  it('400s a contradicted row — needs adjudication first', async () => {
    discrepancyRow.direction = 'contradicted';
    const res = await POST(req(), { params: params('d1') });
    expect(res.status).toBe(400);
  });

  it('404s when the given missionId does not exist', async () => {
    missionRow = null;
    const res = await POST(req(), { params: params('d1') });
    expect(res.status).toBe(404);
  });

  it('400s when the mission belongs to a different workspace', async () => {
    missionRow = { id: 'm1', workspaceId: 'other-ws' };
    const res = await POST(req(), { params: params('d1') });
    expect(res.status).toBe(400);
  });

  it('links a spec_ahead row to the given mission', async () => {
    const res = await POST(req(), { params: params('d1') });
    expect(res.status).toBe(200);
    expect(lastUpdateSet).toEqual({ promotedMissionId: 'm1' });
    const data = await res.json();
    expect(data.missionId).toBe('m1');
    expect(data.alreadyPromoted).toBe(false);
  });

  it('409s when the conditional link write finds no matching row (race)', async () => {
    updateReturnRows = [];
    refetchedRow = { ...discrepancyRow, direction: 'contradicted', promotedMissionId: null };
    const res = await POST(req(), { params: params('d1') });
    expect(res.status).toBe(409);
  });

  it('reports already-promoted (not an error) when the race loser sees the winner\'s write', async () => {
    updateReturnRows = [];
    refetchedRow = { ...discrepancyRow, promotedMissionId: 'm1' };
    const res = await POST(req(), { params: params('d1') });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.alreadyPromoted).toBe(true);
  });
});
