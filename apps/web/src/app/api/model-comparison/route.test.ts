import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockVerifyWorkspaceAccess = mock(() => Promise.resolve(null as any));
const mockVerifyAccountWorkspaceAccess = mock(() => Promise.resolve(false));
const mockList = mock(async (_ws: string, _since: Date | null, _until: Date | null) => [] as any[]);

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@/lib/team-access', () => ({
  verifyWorkspaceAccess: mockVerifyWorkspaceAccess,
  verifyAccountWorkspaceAccess: mockVerifyAccountWorkspaceAccess,
}));
mock.module('@/lib/model-observation-store', () => ({ listObservationsForComparison: mockList }));

import { GET } from './route';

const req = (qs: string, headers: Record<string, string> = {}) =>
  new NextRequest(`http://localhost/api/model-comparison${qs}`, { headers });

const obs = (over: Record<string, unknown> = {}) => ({
  workerId: 'w', taskId: 't', chainId: null, resolvedModel: 'model-a', endpointKind: 'anthropic_api',
  modelVersion: null, quantization: null, backend: null, harnessVersion: null, runtime: null, taskClass: null,
  startedAt: new Date(), endedAt: null, createdAt: new Date(), durationMs: 1000, inputTokens: null, outputTokens: null,
  tokensPerSecond: null, terminalOutcome: 'completed', failureOrigin: 'none', costUsd: null,
  reviewVerdict: null, ciState: null, specVerdict: null, prOutcome: null, reworked: false, ...over,
});

describe('GET /api/model-comparison', () => {
  beforeEach(() => {
    for (const m of [mockGetCurrentUser, mockAuthenticateApiKey, mockVerifyWorkspaceAccess, mockVerifyAccountWorkspaceAccess, mockList]) m.mockReset();
    mockList.mockResolvedValue([]);
  });

  it('requires a workspaceId', async () => {
    expect((await GET(req(''))).status).toBe(400);
  });

  it('401 without a session or key', async () => {
    expect((await GET(req('?workspaceId=ws-1'))).status).toBe(401);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('404 for a workspace the session cannot reach, without reading rows', async () => {
    mockGetCurrentUser.mockReturnValue({ id: 'u' });
    mockVerifyWorkspaceAccess.mockResolvedValue(null);
    expect((await GET(req('?workspaceId=ws-other'))).status).toBe(404);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('404 for a key whose account cannot reach the workspace', async () => {
    mockAuthenticateApiKey.mockReturnValue({ id: 'acct' });
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(false);
    expect((await GET(req('?workspaceId=ws-other', { authorization: 'Bearer bld_x' }))).status).toBe(404);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('401 for an invalid key', async () => {
    mockAuthenticateApiKey.mockReturnValue(null);
    expect((await GET(req('?workspaceId=ws-1', { authorization: 'Bearer bad' }))).status).toBe(401);
  });

  it('rejects a bad window or date', async () => {
    mockGetCurrentUser.mockReturnValue({ id: 'u' });
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 't' });
    expect((await GET(req('?workspaceId=ws-1&window=1y'))).status).toBe(400);
    expect((await GET(req('?workspaceId=ws-1&since=nope'))).status).toBe(400);
  });

  it('reads only the requested workspace and returns an observational, non-promoting comparison', async () => {
    mockGetCurrentUser.mockReturnValue({ id: 'u' });
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 't' });
    mockList.mockResolvedValue([obs(), obs({ workerId: 'x', resolvedModel: 'model-b', ciState: 'passed' })]);
    const res = await GET(req('?workspaceId=ws-1&model=model-a'));
    expect(res.status).toBe(200);
    expect(mockList.mock.calls[0][0]).toBe('ws-1');
    const body = await res.json();
    expect(body.autoPromote).toBe(false);
    expect(body.evidence.design).toBe('observational');
    expect(body.configs.map((c: any) => c.identity.model)).toEqual(['model-a']);
    // A completed attempt with no outside evidence renders as unknown, not as a success.
    expect(body.configs[0].quality.unknown).toBe(1);
    expect(body.configs[0].quality.rate).toBeNull();
    expect(body.priors.entries).toEqual([]);
  });
});
