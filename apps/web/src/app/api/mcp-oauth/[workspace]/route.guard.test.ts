import { describe, it, expect, mock } from 'bun:test';

const mockVerifyAccessToken = mock(() => Promise.resolve(null as any));
const mockWorkspacesFindFirst = mock(() => Promise.resolve(null as any));

mock.module('@/lib/oauth/tokens', () => ({ verifyAccessToken: mockVerifyAccessToken }));
mock.module('@/lib/oauth/config', () => ({ getIssuer: () => 'https://buildd.dev' }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: async () => null }));
mock.module('@/lib/memory-helper', () => ({ getMemoryStoreForTeam: async () => ({}) }));
mock.module('@buildd/core/db', () => ({
  db: { query: { workspaces: { findFirst: mockWorkspacesFindFirst } } },
}));
mock.module('@buildd/core/knowledge-store', () => ({
  PgVectorStore: class {},
  getVoyageEmbedder: () => null,
  getVoyageReranker: () => null,
}));

import { POST, DELETE } from './route';

function req(method: string) {
  return new Request('http://localhost/api/mcp-oauth/not-a-uuid', {
    method,
    headers: { Authorization: 'Bearer aaa.bbb.ccc' },
    body: method === 'POST' ? JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) : undefined,
  });
}

describe('POST/DELETE /api/mcp-oauth/[workspace] — non-UUID guard', () => {
  it('POST returns 404 for a non-UUID workspace without verifying the token or querying the db', async () => {
    const res = await POST(req('POST'), { params: Promise.resolve({ workspace: 'not-a-uuid' }) });
    expect(res.status).toBe(404);
    expect(mockVerifyAccessToken).not.toHaveBeenCalled();
    expect(mockWorkspacesFindFirst).not.toHaveBeenCalled();
  });

  it('DELETE returns 404 for a non-UUID workspace without verifying the token or querying the db', async () => {
    const res = await DELETE(req('DELETE'), { params: Promise.resolve({ workspace: 'not-a-uuid' }) });
    expect(res.status).toBe(404);
    expect(mockVerifyAccessToken).not.toHaveBeenCalled();
    expect(mockWorkspacesFindFirst).not.toHaveBeenCalled();
  });
});
