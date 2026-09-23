import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

/**
 * Invariant: the admin backfill endpoints are reachable only with an API key
 * whose account is listed in BUILDD_PLATFORM_ADMIN_ACCOUNT_IDS.
 *
 * These routes run bulk, cross-tenant writes with a 300s budget, so neither
 * "authenticated" nor "admin within a team" is a sufficient bar — the caller
 * must be a platform operator. Browser sessions are never accepted, and an
 * unset allowlist refuses everyone. Same gate as `admin/refresh-model-aliases`.
 */

const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock(() => null as any);

mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mockAuthenticateApiKey,
}));

// The backfill lazily imports the DB and knowledge store inside POST. Stub them
// so an admitted caller returns instead of reaching a real database — the point
// here is which principals get past the gate, not what the backfill computes.
mock.module('@buildd/core/db', () => ({
  db: { execute: async () => ({ rows: [{ c: '0' }] }) },
}));
mock.module('@buildd/core/knowledge-store', () => ({
  upsertEntity: async () => {},
  upsertAlias: async () => {},
  upsertChunkEntity: async () => {},
  upsertEdge: async () => {},
  buildEdges: () => [],
  buildOutcomeOfEdge: () => null,
  extractEntities: () => [],
  resolveEntity: async () => null,
}));

const { POST } = await import('./route');

function makeRequest(bearer: string | null = 'bld_test') {
  return new NextRequest('http://localhost/api/admin/backfill-entity-graph', {
    method: 'POST',
    headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
    body: JSON.stringify({ dryRun: true }),
  });
}

describe('POST /api/admin/backfill-entity-graph — authorization', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockReset();
    mockAuthenticateApiKey.mockResolvedValue(null);
    delete process.env.BUILDD_PLATFORM_ADMIN_ACCOUNT_IDS;
  });

  it('rejects an unauthenticated caller', async () => {
    const res = await POST(makeRequest(null));
    expect(res.status).toBe(401);
  });

  it('rejects a non-admin API key', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acct-1', level: 'write' });

    const res = await POST(makeRequest());

    expect(res.status).toBe(403);
  });

  // A browser session carries no admin level anywhere in this codebase, so it
  // is not a credential this endpoint can accept — being signed in must not
  // substitute for an admin key.
  it('rejects a signed-in session with no admin-level API key', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', email: 'someone@example.com' });
    mockAuthenticateApiKey.mockResolvedValue(null);

    const res = await POST(makeRequest(null));

    expect(res.status).toBe(401);
  });

  it('rejects a signed-in session presenting a non-admin API key', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', email: 'someone@example.com' });
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acct-1', level: 'write' });

    const res = await POST(makeRequest());

    expect(res.status).toBe(403);
  });

  it('admits a key listed in the platform admin allowlist', async () => {
    process.env.BUILDD_PLATFORM_ADMIN_ACCOUNT_IDS = 'acct-1';
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acct-1', level: 'admin' });

    const res = await POST(makeRequest());

    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it('refuses an admin-level key that is not on the platform admin allowlist', async () => {
    process.env.BUILDD_PLATFORM_ADMIN_ACCOUNT_IDS = 'acct-operator';
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acct-1', level: 'admin' });

    const res = await POST(makeRequest());

    expect(res.status).toBe(403);
  });

  it('refuses every key when the platform admin allowlist is unset', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acct-1', level: 'admin' });

    const res = await POST(makeRequest());

    expect(res.status).toBe(403);
  });
});
