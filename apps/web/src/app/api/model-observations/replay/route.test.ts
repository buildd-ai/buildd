import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockAuth = mock(() => null as any);
const mockAccess = mock(() => Promise.resolve(false));
const mockIngest = mock(async (_ws: string, _runs: unknown[]) => ({ ingested: ['r1'], rejected: [] as any[] }));

mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuth }));
mock.module('@/lib/team-access', () => ({ verifyAccountWorkspaceAccess: mockAccess }));
mock.module('@/lib/model-observation-store', () => ({ ingestReplayRuns: mockIngest }));

import { POST } from './route';

const post = (body: unknown, key: string | null = 'bld_x') =>
  new NextRequest('http://localhost/api/model-observations/replay', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body),
  });

describe('POST /api/model-observations/replay', () => {
  beforeEach(() => {
    for (const m of [mockAuth, mockAccess, mockIngest]) m.mockReset();
    mockAuth.mockReturnValue({ id: 'a' });
    mockAccess.mockResolvedValue(true);
    mockIngest.mockResolvedValue({ ingested: ['r1'], rejected: [] });
  });

  it('requires an API key', async () => {
    expect((await POST(post({}, null))).status).toBe(401);
    mockAuth.mockReturnValue(null);
    expect((await POST(post({ workspaceId: 'w', runs: [{}] }))).status).toBe(401);
    expect(mockIngest).not.toHaveBeenCalled();
  });

  it('answers 404 and ingests nothing for a workspace the key cannot reach', async () => {
    mockAccess.mockResolvedValue(false);
    expect((await POST(post({ workspaceId: 'w', runs: [{}] }))).status).toBe(404);
    expect(mockIngest).not.toHaveBeenCalled();
  });

  it('rejects a missing workspace, empty runs and oversized batches', async () => {
    expect((await POST(post({ runs: [{}] }))).status).toBe(400);
    expect((await POST(post({ workspaceId: 'w', runs: [] }))).status).toBe(400);
    expect((await POST(post({ workspaceId: 'w', runs: new Array(201).fill({}) }))).status).toBe(400);
  });

  it('ingests and reports refusals; 422 when every record is refused', async () => {
    const ok = await POST(post({ workspaceId: 'w', runs: [{}] }));
    expect(ok.status).toBe(200);
    expect(mockIngest).toHaveBeenCalledWith('w', [{}]);
    mockIngest.mockResolvedValue({ ingested: [], rejected: [{ index: 0, errors: ['x'] }] });
    expect((await POST(post({ workspaceId: 'w', runs: [{}] }))).status).toBe(422);
  });
});
