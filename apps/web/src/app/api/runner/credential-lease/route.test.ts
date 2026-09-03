import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// ── mock setup (before any imports that trigger module loading) ───────────────

const mockAuthenticateApiKey = mock(() => Promise.resolve(null as any));

// db.execute — used for the acquire upsert (raw SQL).
const mockDbExecute = mock(() => Promise.resolve({ rows: [] }));

// db.query.secrets.findFirst — credential existence check.
const mockSecretsQueryFindFirst = mock(() => Promise.resolve(null as any));

// db.update().set().where().returning() — heartbeat
const mockDbUpdateReturning = mock(() => Promise.resolve([]));

// db.delete().where() — release
const mockDbDeleteWhere = mock(() => Promise.resolve());

mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mockAuthenticateApiKey,
}));

mock.module('@buildd/core/db', () => ({
  db: {
    execute: mockDbExecute,
    update: () => ({
      set: () => ({
        where: () => ({ returning: mockDbUpdateReturning }),
      }),
    }),
    delete: () => ({
      where: mockDbDeleteWhere,
    }),
    query: {
      secrets: {
        findFirst: mockSecretsQueryFindFirst,
      },
    },
  },
}));

mock.module('@buildd/core/db/schema', () => ({
  secrets: { id: 'id', teamId: 'team_id' },
  credentialLeases: {
    id: 'id',
    credentialId: 'credential_id',
    heldByRunnerId: 'held_by_runner_id',
    heartbeatAt: 'heartbeat_at',
    expiresAt: 'expires_at',
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (f: any, v: any) => ({ __eq: { f, v } }),
  and: (...c: any[]) => ({ __and: c }),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: any[]) => ({ __sql: strings.raw.join('') }),
    { raw: (s: string) => ({ __raw: s }) },
  ),
}));

// Redis due-queue — the lease endpoint publishes the expiry so the expiry
// guard's gated tick can find it without querying Postgres.
const mockMarkDue = mock((_job: string, _member: string, _dueAtMs: number) => Promise.resolve());
const mockClearDue = mock((_job: string, _members: string | string[]) => Promise.resolve());

mock.module('@/lib/redis', () => ({
  markDue: mockMarkDue,
  clearDue: mockClearDue,
}));

// ── imports (after mocks) ─────────────────────────────────────────────────────

import { POST } from './route';

// ── helpers ───────────────────────────────────────────────────────────────────

const TEAM_ID = 'team-uuid-0001';
const ACCOUNT = { id: 'account-1', teamId: TEAM_ID, level: 'admin' as const };
const CREDENTIAL_ID = 'cred-uuid-1234';
const RUNNER_ID = 'my-runner-host';
const LEASE_ID = 'lease-uuid-5678';

function makeRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/runner/credential-lease', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer bld_test' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mockAuthenticateApiKey.mockReset();
  mockDbExecute.mockReset();
  mockSecretsQueryFindFirst.mockReset();
  mockDbUpdateReturning.mockReset();
  mockDbDeleteWhere.mockReset();

  // Default: authenticated, credential exists and belongs to account's team.
  mockAuthenticateApiKey.mockImplementation(() => Promise.resolve(ACCOUNT));
  mockSecretsQueryFindFirst.mockImplementation(() =>
    Promise.resolve({ id: CREDENTIAL_ID, teamId: TEAM_ID }),
  );
});

// ── auth guard ────────────────────────────────────────────────────────────────

describe('POST /api/runner/credential-lease — auth', () => {
  it('returns 401 when API key is missing or invalid', async () => {
    mockAuthenticateApiKey.mockImplementation(() => Promise.resolve(null));
    const req = new NextRequest('http://localhost/api/runner/credential-lease', {
      method: 'POST',
      body: JSON.stringify({ credentialId: CREDENTIAL_ID, runnerId: RUNNER_ID, action: 'acquire' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it('returns 400 when required fields are missing', async () => {
    const res = await POST(makeRequest({ credentialId: CREDENTIAL_ID }));
    expect(res.status).toBe(400);
  });

  it('returns 400 for unknown action', async () => {
    const res = await POST(makeRequest({ credentialId: CREDENTIAL_ID, runnerId: RUNNER_ID, action: 'steal' }));
    expect(res.status).toBe(400);
  });

  it('returns 404 when credential does not exist', async () => {
    mockSecretsQueryFindFirst.mockImplementation(() => Promise.resolve(null));
    const res = await POST(makeRequest({ credentialId: CREDENTIAL_ID, runnerId: RUNNER_ID, action: 'acquire' }));
    expect(res.status).toBe(404);
  });

  it('returns 403 when credential belongs to different team', async () => {
    mockSecretsQueryFindFirst.mockImplementation(() =>
      Promise.resolve({ id: CREDENTIAL_ID, teamId: 'other-team' }),
    );
    const res = await POST(makeRequest({ credentialId: CREDENTIAL_ID, runnerId: RUNNER_ID, action: 'acquire' }));
    expect(res.status).toBe(403);
  });
});

// ── acquire ───────────────────────────────────────────────────────────────────

describe('POST /api/runner/credential-lease — acquire', () => {
  it('returns acquired=true with leaseId when INSERT succeeds', async () => {
    mockDbExecute.mockImplementation(() =>
      Promise.resolve({ rows: [{ id: LEASE_ID }] }),
    );
    const res = await POST(makeRequest({ credentialId: CREDENTIAL_ID, runnerId: RUNNER_ID, action: 'acquire' }));
    expect(res.status).toBe(200);
    const body = await res.json() as { acquired: boolean; leaseId: string };
    expect(body.acquired).toBe(true);
    expect(body.leaseId).toBe(LEASE_ID);
  });

  it('returns acquired=false when another runner holds a live lease', async () => {
    mockDbExecute.mockImplementation(() => Promise.resolve({ rows: [] }));
    const res = await POST(makeRequest({ credentialId: CREDENTIAL_ID, runnerId: RUNNER_ID, action: 'acquire' }));
    expect(res.status).toBe(200);
    const body = await res.json() as { acquired: boolean };
    expect(body.acquired).toBe(false);
  });
});

// ── heartbeat ─────────────────────────────────────────────────────────────────

describe('POST /api/runner/credential-lease — heartbeat', () => {
  it('returns ok=true when lease is renewed', async () => {
    mockDbUpdateReturning.mockImplementation(() =>
      Promise.resolve([{ id: LEASE_ID }]),
    );
    const res = await POST(makeRequest({ credentialId: CREDENTIAL_ID, runnerId: RUNNER_ID, action: 'heartbeat' }));
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it('returns 404 with stolen=true when lease was overwritten by another runner', async () => {
    mockDbUpdateReturning.mockImplementation(() => Promise.resolve([]));
    const res = await POST(makeRequest({ credentialId: CREDENTIAL_ID, runnerId: RUNNER_ID, action: 'heartbeat' }));
    expect(res.status).toBe(404);
    const body = await res.json() as { ok: boolean; stolen: boolean };
    expect(body.stolen).toBe(true);
  });
});

// ── release ───────────────────────────────────────────────────────────────────

describe('POST /api/runner/credential-lease — release', () => {
  it('returns ok=true and deletes the lease row', async () => {
    const res = await POST(makeRequest({ credentialId: CREDENTIAL_ID, runnerId: RUNNER_ID, action: 'release' }));
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(mockDbDeleteWhere.mock.calls.length).toBeGreaterThan(0);
  });
});

// ── Redis due-queue publication ───────────────────────────────────────────────

describe('POST /api/runner/credential-lease — due-queue publication', () => {
  beforeEach(() => {
    mockMarkDue.mockReset();
    mockClearDue.mockReset();
    mockMarkDue.mockImplementation(() => Promise.resolve());
    mockClearDue.mockImplementation(() => Promise.resolve());
    mockAuthenticateApiKey.mockImplementation(() => Promise.resolve(ACCOUNT) as any);
    mockSecretsQueryFindFirst.mockImplementation(
      () => Promise.resolve({ id: CREDENTIAL_ID, teamId: TEAM_ID }) as any,
    );
  });

  it('publishes the expiry when a lease is acquired', async () => {
    mockDbExecute.mockImplementation(() => Promise.resolve({ rows: [{ id: LEASE_ID }] }) as any);
    const before = Date.now();
    await POST(makeRequest({ credentialId: CREDENTIAL_ID, runnerId: RUNNER_ID, action: 'acquire' }));

    expect(mockMarkDue.mock.calls.length).toBe(1);
    const [job, member, dueAtMs] = mockMarkDue.mock.calls[0] as [string, string, number];
    expect(job).toBe('lease-expiry');
    expect(member).toBe(CREDENTIAL_ID);
    // Score is the lease expiry (TTL 5 min), which is what the guard compares
    // against now — publishing the acquire time instead would alert instantly.
    expect(dueAtMs).toBeGreaterThanOrEqual(before + 4 * 60_000);
    expect(dueAtMs).toBeLessThanOrEqual(Date.now() + 6 * 60_000);
  });

  it('does not publish when the lease was not acquired', async () => {
    mockDbExecute.mockImplementation(() => Promise.resolve({ rows: [] }) as any);
    await POST(makeRequest({ credentialId: CREDENTIAL_ID, runnerId: RUNNER_ID, action: 'acquire' }));
    expect(mockMarkDue.mock.calls.length).toBe(0);
  });

  it('pushes the expiry out on heartbeat', async () => {
    mockDbUpdateReturning.mockImplementation(() => Promise.resolve([{ id: LEASE_ID }]) as any);
    await POST(makeRequest({ credentialId: CREDENTIAL_ID, runnerId: RUNNER_ID, action: 'heartbeat' }));
    expect(mockMarkDue.mock.calls.length).toBe(1);
  });

  it('does not publish when the lease was stolen', async () => {
    mockDbUpdateReturning.mockImplementation(() => Promise.resolve([]) as any);
    const res = await POST(makeRequest({ credentialId: CREDENTIAL_ID, runnerId: RUNNER_ID, action: 'heartbeat' }));
    expect(res.status).toBe(404);
    expect(mockMarkDue.mock.calls.length).toBe(0);
  });

  it('clears the entry on release', async () => {
    await POST(makeRequest({ credentialId: CREDENTIAL_ID, runnerId: RUNNER_ID, action: 'release' }));
    expect(mockClearDue.mock.calls.length).toBe(1);
    expect(mockClearDue.mock.calls[0]).toEqual(['lease-expiry', CREDENTIAL_ID]);
  });
});
