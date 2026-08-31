// Tests for GET /api/.well-known/jwks.json.
//
// NOT co-located next to the route: the unit-test runner discovers files with a
// glob that skips dot directories (and `bun test <filter>` cannot match inside
// one either), so a test placed in `.well-known/` would never run.

import { describe, it, expect, beforeEach, mock } from 'bun:test';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockGetAllPublicKeys = mock(async () => [] as Array<{ kid: string; publicKeyJwk: JsonWebKey }>);
const mockCreateActiveSigningKey = mock(async (_now: Date) => 'new-secret-id');

mock.module('@/lib/signing-keys', () => ({
  getAllPublicKeys: mockGetAllPublicKeys,
  createActiveSigningKey: mockCreateActiveSigningKey,
}));

import { GET } from './.well-known/jwks.json/route';

// Obviously fake coordinates — shape only, never real key material.
const healthyKey = {
  kid: 'buildd-2026-07-fake1',
  publicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'FAKE-x-coordinate', y: 'FAKE-y-coordinate', use: 'sig', alg: 'ES256' } as JsonWebKey,
};

const CACHE_HEADER = 'public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400';

describe('GET /api/.well-known/jwks.json', () => {
  beforeEach(() => {
    mockGetAllPublicKeys.mockReset();
    mockCreateActiveSigningKey.mockReset();
    mockCreateActiveSigningKey.mockResolvedValue('new-secret-id');
  });

  it('serves a healthy key set as a cacheable 200', async () => {
    mockGetAllPublicKeys.mockResolvedValue([healthyKey]);

    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe(CACHE_HEADER);

    const body = await res.json();
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]).toMatchObject({
      kty: 'EC',
      crv: 'P-256',
      kid: healthyKey.kid,
      use: 'sig',
      alg: 'ES256',
      x: 'FAKE-x-coordinate',
      y: 'FAKE-y-coordinate',
    });
  });

  // Regression: a valid-looking but keyless JWKS used to be served as a 200
  // cached for an hour — and because relying parties re-fetch on unknown kid,
  // they hit the same cached failure. Never cache an unusable document.
  it('returns 503 with no-store when the key set is still empty after bootstrap', async () => {
    mockGetAllPublicKeys.mockResolvedValue([]);

    const res = await GET();
    expect(mockCreateActiveSigningKey).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('returns 503 with no-store when a key row carries no key material', async () => {
    // A row lacking publicKeyJwk serialises to {kid, use, alg} — JSON.stringify
    // drops the undefined kty/crv/x/y, so the document looks well-formed.
    mockGetAllPublicKeys.mockResolvedValue([
      { kid: 'buildd-2026-07-broken', publicKeyJwk: {} as JsonWebKey },
    ]);

    const res = await GET();
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('returns 503 with no-store when one key in an otherwise healthy set is malformed', async () => {
    mockGetAllPublicKeys.mockResolvedValue([
      healthyKey,
      { kid: 'buildd-2026-06-broken', publicKeyJwk: { kty: 'EC', crv: 'P-256' } as JsonWebKey },
    ]);

    const res = await GET();
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});
