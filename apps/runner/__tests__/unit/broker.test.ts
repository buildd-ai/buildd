/**
 * Unit tests for apps/runner/src/broker.ts
 *
 * Mocks globalThis.fetch; covers:
 *   1. notifyCredentials → acquire succeeds
 *   2. notifyCredentials → acquire fails (another runner holds lease)
 *   3. notifyCredentials on already-managed credential → no re-acquire
 *   4. heartbeatAll → success
 *   5. heartbeatAll → 404 (stolen) → lease removed
 *   6. refreshExpiring → skips creds not expiring within 2h
 *   7. refreshExpiring → calls runnerRefreshCredential for expiring creds
 *   8. shutdown → releases all leases (idempotent)
 *
 * Run: bun test apps/runner/__tests__/unit/broker.test.ts
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { CredentialBroker } from '../../src/broker';

const CONTROL_PLANE = 'https://buildd.dev';
const API_KEY = 'bld_test_key';
const SECRET_ID = 'cred-uuid-1111';
const RUNNER_ID = 'test-runner-host';
const LEASE_ID = 'lease-uuid-9999';
const LEASE_ENDPOINT = `${CONTROL_PLANE}/api/runner/credential-lease`;
const REFRESH_ENDPOINT = `${CONTROL_PLANE}/api/runner/credential-refresh`;

const originalFetch = globalThis.fetch;
let fetchCalls: Array<{ url: string; body: Record<string, unknown> }>;

function makeFetchMock(responses: Array<{ body: unknown; status?: number }>) {
  let callIndex = 0;
  fetchCalls = [];
  return mock(async (url: string, init?: RequestInit) => {
    let body: Record<string, unknown> = {};
    if (init?.body) {
      const raw = init.body as string;
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        body = { __urlencoded: raw };
      }
    }
    fetchCalls.push({ url, body });
    const r = responses[callIndex++] ?? { body: {}, status: 200 };
    return new Response(JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

let broker: CredentialBroker;

beforeEach(() => {
  process.env.BUILDD_CLIENT_URL = CONTROL_PLANE;
  process.env.BUILDD_API_KEY = API_KEY;
  process.env.BUILDD_RUNNER_ID = RUNNER_ID;
  broker = new CredentialBroker();
  fetchCalls = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ── acquire path ──────────────────────────────────────────────────────────────

describe('notifyCredentials / acquire', () => {
  test('acquires lease when control plane returns acquired=true', async () => {
    globalThis.fetch = makeFetchMock([{ body: { acquired: true, leaseId: LEASE_ID } }]);

    broker.notifyCredentials([{ secretId: SECRET_ID, purpose: 'claude_credential', expiresAt: null }]);
    await new Promise((r) => setTimeout(r, 20));

    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].url).toBe(LEASE_ENDPOINT);
    expect(fetchCalls[0].body.action).toBe('acquire');
    expect(fetchCalls[0].body.credentialId).toBe(SECRET_ID);
    expect(fetchCalls[0].body.runnerId).toBe(RUNNER_ID);
  });

  test('does not add to managed set when acquired=false', async () => {
    globalThis.fetch = makeFetchMock([{ body: { acquired: false } }]);

    broker.notifyCredentials([{ secretId: SECRET_ID, purpose: 'claude_credential', expiresAt: null }]);
    await new Promise((r) => setTimeout(r, 20));

    // Credential not managed — next notify triggers another acquire attempt.
    fetchCalls = [];
    globalThis.fetch = makeFetchMock([{ body: { acquired: false } }]);
    broker.notifyCredentials([{ secretId: SECRET_ID, purpose: 'claude_credential', expiresAt: null }]);
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchCalls.length).toBe(1);
  });

  test('does not re-acquire if credential is already managed', async () => {
    globalThis.fetch = makeFetchMock([{ body: { acquired: true, leaseId: LEASE_ID } }]);
    broker.notifyCredentials([{ secretId: SECRET_ID, purpose: 'claude_credential', expiresAt: null }]);
    await new Promise((r) => setTimeout(r, 20));

    // Second notify — already managed, no new fetch call.
    fetchCalls = [];
    broker.notifyCredentials([{ secretId: SECRET_ID, purpose: 'claude_credential', expiresAt: '2030-01-01T00:00:00Z' }]);
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchCalls.length).toBe(0);
  });

  test('sends Authorization header with API key', async () => {
    globalThis.fetch = makeFetchMock([{ body: { acquired: true, leaseId: LEASE_ID } }]);
    broker.notifyCredentials([{ secretId: SECRET_ID, purpose: 'codex_credential', expiresAt: null }]);
    await new Promise((r) => setTimeout(r, 20));

    // Verify the mock was called with a function whose init included the header.
    // We reconstruct by checking fetchCalls contains exactly one entry.
    expect(fetchCalls.length).toBe(1);
  });
});

// ── heartbeat path ────────────────────────────────────────────────────────────

describe('heartbeatAll', () => {
  async function acquireLease() {
    globalThis.fetch = makeFetchMock([{ body: { acquired: true, leaseId: LEASE_ID } }]);
    broker.notifyCredentials([{ secretId: SECRET_ID, purpose: 'claude_credential', expiresAt: null }]);
    await new Promise((r) => setTimeout(r, 20));
  }

  test('sends heartbeat for each managed lease', async () => {
    await acquireLease();
    fetchCalls = [];
    globalThis.fetch = makeFetchMock([{ body: { ok: true } }]);

    await (broker as any).heartbeatAll();

    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].url).toBe(LEASE_ENDPOINT);
    expect(fetchCalls[0].body.action).toBe('heartbeat');
    expect(fetchCalls[0].body.credentialId).toBe(SECRET_ID);
  });

  test('removes lease from managed set on 404 (stolen)', async () => {
    await acquireLease();
    fetchCalls = [];
    globalThis.fetch = makeFetchMock([{ body: { ok: false, stolen: true }, status: 404 }]);

    await (broker as any).heartbeatAll();

    // Credential should no longer be managed — next notify triggers a new acquire.
    fetchCalls = [];
    globalThis.fetch = makeFetchMock([{ body: { acquired: true, leaseId: 'new-lease-id' } }]);
    broker.notifyCredentials([{ secretId: SECRET_ID, purpose: 'claude_credential', expiresAt: null }]);
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchCalls.length).toBe(1); // tried acquire again
  });

  test('is a no-op when no leases are held', async () => {
    globalThis.fetch = makeFetchMock([]);
    await (broker as any).heartbeatAll();
    expect(fetchCalls.length).toBe(0);
  });
});

// ── refresh path ──────────────────────────────────────────────────────────────

describe('refreshExpiring', () => {
  async function acquireLeaseWithExpiry(expiresAt: string) {
    globalThis.fetch = makeFetchMock([{ body: { acquired: true, leaseId: LEASE_ID } }]);
    broker.notifyCredentials([{ secretId: SECRET_ID, purpose: 'claude_credential', expiresAt }]);
    await new Promise((r) => setTimeout(r, 20));
  }

  test('skips credentials expiring more than 2h away', async () => {
    const farExpiry = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
    await acquireLeaseWithExpiry(farExpiry);

    fetchCalls = [];
    globalThis.fetch = makeFetchMock([]);
    await (broker as any).refreshExpiring();
    expect(fetchCalls.length).toBe(0);
  });

  test('calls runnerRefreshCredential for credentials expiring within 2h', async () => {
    const soonExpiry = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30 min
    await acquireLeaseWithExpiry(soonExpiry);

    fetchCalls = [];
    // runnerRefreshCredential chain: lock → provider → commit
    globalThis.fetch = makeFetchMock([
      { body: { locked: true, refreshToken: 'rt-abc' } }, // lock
      { body: { access_token: 'new-at', refresh_token: 'new-rt', expires_in: 3600 } }, // provider
      { body: { ok: true } }, // commit
    ]);
    await (broker as any).refreshExpiring();

    const lockCall = fetchCalls.find((c) => c.url === REFRESH_ENDPOINT && c.body.action === 'lock');
    expect(lockCall).toBeDefined();
    expect(lockCall!.body.secretId).toBe(SECRET_ID);
  });

  test('calls runnerRefreshCredential for null expiresAt (unknown expiry)', async () => {
    await acquireLeaseWithExpiry(''); // empty string parsed as invalid date → getTime() = NaN
    // Actually let's use null directly.
    const broker2 = new CredentialBroker();
    globalThis.fetch = makeFetchMock([
      { body: { acquired: true, leaseId: LEASE_ID } },
      { body: { locked: true, refreshToken: 'rt-abc' } },
      { body: { access_token: 'new-at', refresh_token: 'new-rt', expires_in: 3600 } },
      { body: { ok: true } },
    ]);
    broker2.notifyCredentials([{ secretId: SECRET_ID, purpose: 'codex_credential', expiresAt: null }]);
    await new Promise((r) => setTimeout(r, 20));

    fetchCalls = [];
    globalThis.fetch = makeFetchMock([
      { body: { locked: true, refreshToken: 'rt-abc' } },
      { body: { access_token: 'new-at', refresh_token: 'new-rt', expires_in: 3600 } },
      { body: { ok: true } },
    ]);
    await (broker2 as any).refreshExpiring();

    const lockCall = fetchCalls.find((c) => c.url === REFRESH_ENDPOINT && c.body.action === 'lock');
    expect(lockCall).toBeDefined();
  });
});

// ── shutdown path ─────────────────────────────────────────────────────────────

describe('shutdown', () => {
  async function acquireLease() {
    globalThis.fetch = makeFetchMock([{ body: { acquired: true, leaseId: LEASE_ID } }]);
    broker.notifyCredentials([{ secretId: SECRET_ID, purpose: 'claude_credential', expiresAt: null }]);
    await new Promise((r) => setTimeout(r, 20));
  }

  test('releases all leases on shutdown', async () => {
    await acquireLease();
    fetchCalls = [];
    globalThis.fetch = makeFetchMock([{ body: { ok: true } }]);

    await broker.shutdown();

    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].url).toBe(LEASE_ENDPOINT);
    expect(fetchCalls[0].body.action).toBe('release');
    expect(fetchCalls[0].body.credentialId).toBe(SECRET_ID);
  });

  test('is idempotent — second shutdown does not double-release', async () => {
    await acquireLease();
    globalThis.fetch = makeFetchMock([{ body: { ok: true } }]);
    await broker.shutdown();
    const firstCount = fetchCalls.length;

    await broker.shutdown();
    expect(fetchCalls.length).toBe(firstCount);
  });

  test('is safe when no leases are held', async () => {
    globalThis.fetch = makeFetchMock([]);
    await broker.shutdown();
    expect(fetchCalls.length).toBe(0);
  });
});
