/**
 * Regression tests for POST /api/workspaces/[id]/artifacts — the workspace-level,
 * no-owning-entity artifact upsert route added for the §4 delta gate's
 * `spec-conformance-last-sha` keyed artifact (docs/design/spec-conformance.md).
 *
 * Run: bun run scripts/run-unit-tests.ts apps/web/src/app/api/workspaces/[id]/artifacts/route.test.ts
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockVerifyWorkspaceAccess = mock(() => false as any);
const mockVerifyAccountWorkspaceAccess = mock(() => false as any);
const mockArtifactsFindFirst = mock(() => null as any);
const mockArtifactsInsert = mock(() => [] as any);
const mockArtifactsUpdate = mock(() => [] as any);

mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mockAuthenticateApiKey,
}));

mock.module('@/lib/team-access', () => ({
  verifyWorkspaceAccess: mockVerifyWorkspaceAccess,
  verifyAccountWorkspaceAccess: mockVerifyAccountWorkspaceAccess,
}));

mock.module('@/lib/app-url', () => ({
  appBaseUrl: () => 'https://buildd.test',
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      artifacts: { findFirst: mockArtifactsFindFirst },
    },
    insert: () => ({
      values: () => ({
        returning: mockArtifactsInsert,
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: mockArtifactsUpdate,
        }),
      }),
    }),
  },
}));

// This mock is why the GET route's `review=true` filter is asserted in
// `review-filter.test.ts` instead of here: under it every column is a string
// and no WHERE clause is observable. The extra builders below exist only so
// `@/lib/artifact-scope` (imported by the route) resolves its imports.
mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...conditions: any[]) => ({ conditions, type: 'and' }),
  or: (...conditions: any[]) => ({ conditions, type: 'or' }),
  desc: (field: any) => ({ field, type: 'desc' }),
  inArray: (field: any, values: any[]) => ({ field, values, type: 'inArray' }),
  notInArray: (field: any, values: any[]) => ({ field, values, type: 'notInArray' }),
  isNotNull: (field: any) => ({ field, type: 'isNotNull' }),
  like: (field: any, value: any) => ({ field, value, type: 'like' }),
  sql: (strings: TemplateStringsArray) => ({ strings, type: 'sql' }),
}));

// Every column `@/lib/artifact-scope` references must exist here, including
// `workers` (its worker-arm subquery): a missing named export fails the whole
// file at link time, before a single test runs.
mock.module('@buildd/core/db/schema', () => ({
  artifacts: {
    id: 'id',
    workspaceId: 'workspaceId',
    workerId: 'workerId',
    key: 'key',
    type: 'type',
    visibility: 'visibility',
    missionId: 'missionId',
    initiativeId: 'initiativeId',
    storageKey: 'storageKey',
    metadata: 'metadata',
  },
  workers: { id: 'id', workspaceId: 'workspaceId' },
}));

const { POST } = await import('./route');

function req(body: unknown, authHeader = 'Bearer test-key'): NextRequest {
  return new NextRequest('http://localhost:3000/api/workspaces/ws-1/artifacts', {
    method: 'POST',
    headers: { authorization: authHeader, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function params(id = 'ws-1') {
  return { params: Promise.resolve({ id }) };
}

describe('POST /api/workspaces/[id]/artifacts', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockVerifyWorkspaceAccess.mockReset();
    mockVerifyAccountWorkspaceAccess.mockReset();
    mockArtifactsFindFirst.mockReset();
    mockArtifactsInsert.mockReset();
    mockArtifactsUpdate.mockReset();

    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1', level: 'admin' });
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(true);
    mockArtifactsFindFirst.mockResolvedValue(null);
    mockArtifactsInsert.mockResolvedValue([{ id: 'artifact-1', workspaceId: 'ws-1', key: 'my-key', type: 'data', title: 't' }]);
  });

  it('returns 401 with no API key', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);
    const res = await POST(req({ type: 'data', title: 't', key: 'k' }, ''), params());
    expect(res.status).toBe(401);
  });

  it('returns 403 for a non-admin API key', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1', level: 'worker' });
    const res = await POST(req({ type: 'data', title: 't', key: 'k' }), params());
    expect(res.status).toBe(403);
  });

  it('returns 404 when the account cannot access the workspace', async () => {
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(false);
    const res = await POST(req({ type: 'data', title: 't', key: 'k' }), params());
    expect(res.status).toBe(404);
  });

  it('rejects a missing key — every workspace-level artifact must be addressable', async () => {
    const res = await POST(req({ type: 'data', title: 't' }), params());
    expect(res.status).toBe(400);
  });

  it('rejects an invalid type', async () => {
    const res = await POST(req({ type: 'not-a-real-type', title: 't', key: 'k' }), params());
    expect(res.status).toBe(400);
  });

  it('inserts a new keyed artifact when none exists', async () => {
    const res = await POST(req({ type: 'data', title: 'spec-conformance-last-sha', content: 'abc123', key: 'spec-conformance-last-sha' }), params());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.upserted).toBeFalsy();
    expect(mockArtifactsInsert).toHaveBeenCalled();
  });

  it('upserts (updates) when a row with the same (workspaceId, key) already exists', async () => {
    mockArtifactsFindFirst.mockResolvedValue({ id: 'artifact-existing', workspaceId: 'ws-1', key: 'spec-conformance-last-sha' });
    mockArtifactsUpdate.mockResolvedValue([{ id: 'artifact-existing', workspaceId: 'ws-1', key: 'spec-conformance-last-sha', content: 'def456' }]);

    const res = await POST(req({ type: 'data', title: 'spec-conformance-last-sha', content: 'def456', key: 'spec-conformance-last-sha' }), params());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.upserted).toBe(true);
    expect(mockArtifactsUpdate).toHaveBeenCalled();
    expect(mockArtifactsInsert).not.toHaveBeenCalled();
  });
});
