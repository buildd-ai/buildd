import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockSecretsFindMany = mock(() => [] as any[]);
const mockSecretsUpdate = mock(() => ({
  set: mock(() => ({ where: mock(() => ({})) })),
}));
const mockProviderDelete = mock(() => Promise.resolve());
const mockProviderSet = mock(() => Promise.resolve('new-secret-id'));
const mockGetSecretsProvider = mock(() => ({
  delete: mockProviderDelete,
  set: mockProviderSet,
}));
const mockGenerateSigningKeypair = mock(() => Promise.resolve({
  privateKeyJwk: { kty: 'EC', crv: 'P-256', d: 'priv', x: 'x1', y: 'y1', kid: 'test', alg: 'ES256' },
  publicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'x1', y: 'y1', kid: 'test', alg: 'ES256', use: 'sig' },
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      secrets: { findMany: mockSecretsFindMany },
    },
    update: () => mockSecretsUpdate(),
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (a: any, b: any) => ({ a, b }),
  and: (...args: any[]) => args,
  isNull: (a: any) => ({ a }),
  lt: (a: any, b: any) => ({ a, b }),
  sql: (s: any) => s,
}));

mock.module('@buildd/core/db/schema', () => ({
  secrets: 'secrets_table',
}));

mock.module('@buildd/core/secrets', () => ({
  getSecretsProvider: mockGetSecretsProvider,
}));

mock.module('@/lib/signing-keys', () => ({
  generateSigningKeypair: mockGenerateSigningKeypair,
}));

process.env.CRON_SECRET = 'test-secret';
process.env.BUILDD_SIGNING_KEY_TEAM_ID = '00000000-0000-0000-0000-000000000001';

import { GET } from './route';

function makeRequest(queryParams: Record<string, string> = {}): NextRequest {
  const url = new URL('http://localhost/api/cron/jwks-rotation');
  for (const [k, v] of Object.entries(queryParams)) url.searchParams.set(k, v);
  return new NextRequest(url, {
    headers: { authorization: `Bearer test-secret` },
  });
}

// Anchored to the real clock (not a fixed date) — the route under test computes
// `now` via `new Date()`, so a hardcoded anchor eventually drifts into the past
// and turns "future" fixtures into "already expired" ones.
const now = new Date();
const thirtyOneDaysAgo = new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000);
const twentyDaysAgo = new Date(now.getTime() - 20 * 24 * 60 * 60 * 1000);
const fiveDaysFromNow = new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000);
const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

describe('GET /api/cron/jwks-rotation', () => {
  beforeEach(() => {
    mockSecretsFindMany.mockReset();
    mockProviderDelete.mockReset();
    mockProviderSet.mockReset();
    mockGenerateSigningKeypair.mockReset();
    mockGenerateSigningKeypair.mockResolvedValue({
      privateKeyJwk: { kty: 'EC', crv: 'P-256', d: 'priv', x: 'x1', y: 'y1' },
      publicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'x1', y: 'y1', use: 'sig' },
    });
    mockProviderSet.mockResolvedValue('new-secret-id');
    mockSecretsFindMany.mockResolvedValue([]);
  });

  it('returns 401 without correct CRON_SECRET', async () => {
    const req = new NextRequest('http://localhost/api/cron/jwks-rotation', {
      headers: { authorization: 'Bearer wrong-secret' },
    });
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it('generates a new key when no signing keys exist (bootstrap)', async () => {
    mockSecretsFindMany.mockResolvedValue([]);
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    expect(mockGenerateSigningKeypair).toHaveBeenCalledTimes(1);
    expect(mockProviderSet).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body.rotated).toBe(true);
  });

  it('does NOT rotate when Active key is younger than 30 days', async () => {
    mockSecretsFindMany.mockResolvedValue([
      { id: 'key-1', label: 'buildd-2026-07', tokenExpiresAt: null, createdAt: twentyDaysAgo },
    ]);
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    expect(mockGenerateSigningKeypair).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.rotated).toBe(false);
  });

  it('rotates when Active key is older than 30 days', async () => {
    mockSecretsFindMany.mockResolvedValue([
      { id: 'key-1', label: 'buildd-2026-06', tokenExpiresAt: null, createdAt: thirtyOneDaysAgo },
    ]);
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    expect(mockGenerateSigningKeypair).toHaveBeenCalledTimes(1);
    expect(mockProviderSet).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body.rotated).toBe(true);
  });

  it('deletes Retiring keys whose tokenExpiresAt has passed', async () => {
    mockSecretsFindMany.mockResolvedValue([
      { id: 'key-retiring', label: 'buildd-2026-05', tokenExpiresAt: oneDayAgo, createdAt: new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000) },
      { id: 'key-active', label: 'buildd-2026-07', tokenExpiresAt: null, createdAt: twentyDaysAgo },
    ]);
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    expect(mockProviderDelete).toHaveBeenCalledWith('key-retiring');
    expect(mockGenerateSigningKeypair).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.deletedExpiredKeys).toBe(1);
  });

  it('does NOT delete Retiring keys whose tokenExpiresAt is in the future', async () => {
    mockSecretsFindMany.mockResolvedValue([
      { id: 'key-retiring', label: 'buildd-2026-06', tokenExpiresAt: fiveDaysFromNow, createdAt: new Date(now.getTime() - 35 * 24 * 60 * 60 * 1000) },
      { id: 'key-active', label: 'buildd-2026-07', tokenExpiresAt: null, createdAt: twentyDaysAgo },
    ]);
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    expect(mockProviderDelete).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.deletedExpiredKeys).toBe(0);
  });

  it('force=true rotates even when Active key is young', async () => {
    mockSecretsFindMany.mockResolvedValue([
      { id: 'key-active', label: 'buildd-2026-07', tokenExpiresAt: null, createdAt: twentyDaysAgo },
    ]);
    const res = await GET(makeRequest({ force: 'true' }));
    expect(res.status).toBe(200);
    expect(mockGenerateSigningKeypair).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body.rotated).toBe(true);
  });
});
