import { beforeEach, expect, mock, test } from 'bun:test';
import { NextRequest, NextResponse } from 'next/server';

let denied = false;
let failed = false;
let reads = 0;
const panel = { cells: [{ gate: 'advisory', area: 'other', revision: 1 }] };
mock.module('@/lib/admin/scope', () => ({ beginAdminRead: async (req: NextRequest) => denied
  ? { response: NextResponse.json({ error: 'Not found' }, { status: 404 }) }
  : { params: req.nextUrl.searchParams, scope: { window: '7d', since: new Date(0), teamId: null, workspaceId: null }, workspaceIds: [], viewer: {} },
}));
mock.module('@/lib/admin/owner-gate', () => ({ requirePlatformOwner: async () => denied
  ? { response: NextResponse.json({ error: 'Not found' }, { status: 404 }) }
  : { account: { id: 'owner' } },
}));
mock.module('@/lib/admin/tenant-privacy', () => ({ viewOperator: async () => ({ failures: [] }) }));
mock.module('@/lib/admin/data', () => ({
  loadRecoveryQueue: async () => null, loadRecoveryCause: async () => null,
  loadClaimLearningPanel: async () => { reads++; if (failed) throw new Error('unavailable'); return panel; },
}));
const { GET, POST } = await import('./route');
beforeEach(() => { denied = false; failed = false; reads = 0; });
const request = (query = '') => new NextRequest(`http://localhost/api/admin/operator${query}`);
test('owner receives requested claim learning panel', async () => {
  const response = await GET(request('?claimLearning=1'));
  expect(response.status).toBe(200);
  expect((await response.json()).claimLearning).toEqual(panel);
});
test('panel is opt-in', async () => {
  const response = await GET(request());
  expect((await response.json()).claimLearning).toBeUndefined();
  expect(reads).toBe(0);
});
test('non-owner receives 404 without reading or writing policy', async () => {
  denied = true;
  expect((await GET(request('?claimLearning=1'))).status).toBe(404);
  expect((await POST(request())).status).toBe(404);
  expect(reads).toBe(0);
});
test('panel failure returns null without failing other panels', async () => {
  failed = true;
  const response = await GET(request('?claimLearning=1'));
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.claimLearning).toBeNull();
  expect(body.failures).toEqual([]);
});
