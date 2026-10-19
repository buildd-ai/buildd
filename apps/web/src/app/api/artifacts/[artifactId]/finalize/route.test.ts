/**
 * Finalize authorization: a worker's upload is finalized by that worker's
 * account; a workerless one (a spec attachment a person started over MCP) by
 * the account recorded as its author. Anyone else gets 403.
 *
 * Run: bun run scripts/run-unit-tests.ts "apps/web/src/app/api/artifacts/[artifactId]/finalize/route.test.ts"
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const ID = '11111111-1111-4111-8111-111111111111';
const mockAuth = mock(() => null as any);
const mockFindFirst = mock(() => null as any);
const mockFinalize = mock(() => Promise.resolve({ state: 'ready' }));

mock.module('@/lib/task-token-auth', () => ({
  authenticateTaskScopedCaller: mockAuth,
  taskScopeAllowsWorker: () => true,
  taskScopeAllowsWorkspace: () => true,
}));
mock.module('@/lib/storage', () => ({ isStorageConfigured: () => true }));
mock.module('@/lib/artifact-upload', () => ({ finalizeArtifactUpload: mockFinalize }));
mock.module('@buildd/core/db', () => ({ db: { query: { artifacts: { findFirst: mockFindFirst } } } }));

import { POST } from './route';

const call = () =>
  POST(new NextRequest(`http://localhost/api/artifacts/${ID}/finalize`, { method: 'POST', headers: { authorization: 'Bearer k' }, body: '{}' }), { params: Promise.resolve({ artifactId: ID }) });

describe('POST /api/artifacts/[artifactId]/finalize', () => {
  beforeEach(() => {
    mockAuth.mockReset().mockResolvedValue({ id: 'acct-1' });
    mockFindFirst.mockReset();
    mockFinalize.mockClear();
  });

  it('lets the author of a workerless upload finalize it', async () => {
    mockFindFirst.mockResolvedValue({ workspaceId: 'w', storageKey: 'k', worker: null, contentAuthor: 'account:acct-1' });
    expect((await call()).status).toBe(200);
    expect(mockFinalize).toHaveBeenCalled();
  });

  it('refuses another account on a workerless upload', async () => {
    mockFindFirst.mockResolvedValue({ workspaceId: 'w', storageKey: 'k', worker: null, contentAuthor: 'account:other' });
    expect((await call()).status).toBe(403);
  });

  it('still requires the worker\'s account for a worker upload', async () => {
    mockFindFirst.mockResolvedValue({ workspaceId: 'w', storageKey: 'k', worker: { accountId: 'other' }, contentAuthor: 'account:acct-1' });
    expect((await call()).status).toBe(403);
  });
});
