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
const mockRevision = mock(() => Promise.resolve(null as any));
mock.module('@/lib/artifact-upload', () => ({
  finalizeArtifactUpload: mockFinalize,
  pendingRevisionOf: (m: any) => m?.pendingRevision ?? null,
}));
mock.module('@/lib/artifact-revisions', () => ({ getArtifactRevision: mockRevision }));
mock.module('@buildd/core/db', () => ({ db: { query: { artifacts: { findFirst: mockFindFirst } } } }));

import { POST } from './route';

const call = () =>
  POST(new NextRequest(`http://localhost/api/artifacts/${ID}/finalize`, { method: 'POST', headers: { authorization: 'Bearer k' }, body: '{}' }), { params: Promise.resolve({ artifactId: ID }) });

describe('POST /api/artifacts/[artifactId]/finalize', () => {
  beforeEach(() => {
    mockAuth.mockReset().mockResolvedValue({ id: 'acct-1' });
    mockFindFirst.mockReset();
    mockFinalize.mockClear();
    mockRevision.mockReset().mockResolvedValue(null);
  });

  // The revision trigger clears content_author once it records the body, so
  // the author a workerless upload keeps is its revision's.
  it('lets the author recorded on the revision finalize a workerless upload', async () => {
    mockFindFirst.mockResolvedValue({ id: ID, workspaceId: 'w', storageKey: 'k', worker: null, contentAuthor: null, currentRevision: 1 });
    mockRevision.mockResolvedValue({ author: 'account:acct-1' });
    expect((await call()).status).toBe(200);
    mockRevision.mockResolvedValue({ author: 'account:other' });
    expect((await call()).status).toBe(403);
  });

  it('a new revision is finalized by whoever started it, even on a worker\'s artifact', async () => {
    const pendingRevision = { author: 'account:acct-1' };
    mockFindFirst.mockResolvedValue({ workspaceId: 'w', storageKey: 'k', worker: { accountId: 'other' }, metadata: { pendingRevision } });
    expect((await call()).status).toBe(200);
    mockFindFirst.mockResolvedValue({ workspaceId: 'w', storageKey: 'k', worker: { accountId: 'acct-1' }, metadata: { pendingRevision: { author: 'account:other' } } });
    expect((await call()).status).toBe(403);
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
