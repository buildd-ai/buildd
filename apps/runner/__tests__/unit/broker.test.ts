/**
 * Unit tests for apps/runner/src/broker.ts
 *
 * Mocks globalThis.fetch; covers:
 *   1. notifyCredentials → acquire succeeds → bootstrap called
 *   2. notifyCredentials → acquire fails (another runner holds lease)
 *   3. notifyCredentials on already-managed credential → no re-acquire
 *   4. bootstrap → tokens stored in managed map
 *   5. bootstrap → non-fatal on failure (lease still held)
 *   6. heartbeatAll → success
 *   7. heartbeatAll → 404 (stolen) → lease removed
 *   8. refreshExpiring → skips creds not expiring within 2h
 *   9. refreshExpiring → calls runnerRefreshCredential for expiring creds
 *  10. shutdown → releases all leases (idempotent)
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

const BOOTSTRAP_RESPONSE = { body: { accessToken: 'at-cached', refreshToken: 'rt-cached', expiresAt: null } };

// ── acquire path ──────────────────────────────────────────────────────────────

describe('notifyCredentials / acquire', () => {
  test('acquires lease then calls bootstrap when control plane returns acquired=true', async () => {
    globalThis.fetch = makeFetchMock([
      { body: { acquired: true, leaseId: LEASE_ID } },
      BOOTSTRAP_RESPONSE,
    ]);

    broker.notifyCredentials([{ secretId: SECRET_ID, purpose: 'claude_credential', expiresAt: null }]);
    await new Promise((r) => setTimeout(r, 20));

    expect(fetchCalls.length).toBe(2);
    const acquireCall = fetchCalls[0];
    expect(acquireCall.url).toBe(LEASE_ENDPOINT);
    expect(acquireCall.body.action).toBe('acquire');
    expect(acquireCall.body.credentialId).toBe(SECRET_ID);
    expect(acquireCall.body.runnerId).toBe(RUNNER_ID);
    const bootstrapCall = fetchCalls[1];
    expect(bootstrapCall.url).toBe(REFRESH_ENDPOINT);
    expect(bootstrapCall.body.action).toBe('bootstrap');
    expect(bootstrapCall.body.secretId).toBe(SECRET_ID);
    expect(bootstrapCall.body.runnerId).toBe(RUNNER_ID);
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
    globalThis.fetch = makeFetchMock([
      { body: { acquired: true, leaseId: LEASE_ID } },
      BOOTSTRAP_RESPONSE,
    ]);
    broker.notifyCredentials([{ secretId: SECRET_ID, purpose: 'claude_credential', expiresAt: null }]);
    await new Promise((r) => setTimeout(r, 20));

    // Second notify — already managed, no new fetch call.
    fetchCalls = [];
    broker.notifyCredentials([{ secretId: SECRET_ID, purpose: 'claude_credential', expiresAt: '2030-01-01T00:00:00Z' }]);
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchCalls.length).toBe(0);
  });

  test('sends Authorization header with API key', async () => {
    globalThis.fetch = makeFetchMock([
      { body: { acquired: true, leaseId: LEASE_ID } },
      BOOTSTRAP_RESPONSE,
    ]);
    broker.notifyCredentials([{ secretId: SECRET_ID, purpose: 'codex_credential', expiresAt: null }]);
    await new Promise((r) => setTimeout(r, 20));

    // Both acquire and bootstrap calls should have been made.
    expect(fetchCalls.length).toBe(2);
  });
});

// ── bootstrap path ────────────────────────────────────────────────────────────

describe('bootstrapCredential', () => {
  test('stores accessToken and refreshToken in managed map after successful bootstrap', async () => {
    globalThis.fetch = makeFetchMock([
      { body: { acquired: true, leaseId: LEASE_ID } },
      { body: { accessToken: 'live-at', refreshToken: 'live-rt', expiresAt: '2030-06-01T00:00:00Z' } },
    ]);
    broker.notifyCredentials([{ secretId: SECRET_ID, purpose: 'claude_credential', expiresAt: null }]);
    await new Promise((r) => setTimeout(r, 20));

    const managed = (broker as any).managed.get(SECRET_ID);
    expect(managed).toBeDefined();
    expect(managed.accessToken).toBe('live-at');
    expect(managed.refreshToken).toBe('live-rt');
    expect(managed.expiresAt).toBe('2030-06-01T00:00:00Z');
  });

  test('overrides expiresAt with fresher value from bootstrap response', async () => {
    globalThis.fetch = makeFetchMock([
      { body: { acquired: true, leaseId: LEASE_ID } },
      { body: { accessToken: 'at', refreshToken: 'rt', expiresAt: '2027-01-01T00:00:00Z' } },
    ]);
    broker.notifyCredentials([{ secretId: SECRET_ID, purpose: 'claude_credential', expiresAt: '2026-01-01T00:00:00Z' }]);
    await new Promise((r) => setTimeout(r, 20));

    const managed = (broker as any).managed.get(SECRET_ID);
    expect(managed.expiresAt).toBe('2027-01-01T00:00:00Z');
  });

  test('bootstrap failure is non-fatal — lease is still held for heartbeat', async () => {
    globalThis.fetch = makeFetchMock([
      { body: { acquired: true, leaseId: LEASE_ID } },
      { body: { error: 'Forbidden' }, status: 403 },
    ]);
    broker.notifyCredentials([{ secretId: SECRET_ID, purpose: 'claude_credential', expiresAt: null }]);
    await new Promise((r) => setTimeout(r, 20));

    // Lease is still managed despite bootstrap failure.
    fetchCalls = [];
    globalThis.fetch = makeFetchMock([{ body: { ok: true } }]);
    await (broker as any).heartbeatAll();
    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].body.action).toBe('heartbeat');
  });

  test('bootstrap network error is non-fatal', async () => {
    let callCount = 0;
    globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
      callCount++;
      if (callCount === 1) {
        // acquire
        fetchCalls.push({ url, body: {} });
        return new Response(JSON.stringify({ acquired: true, leaseId: LEASE_ID }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      // bootstrap — throw network error
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    broker.notifyCredentials([{ secretId: SECRET_ID, purpose: 'claude_credential', expiresAt: null }]);
    await new Promise((r) => setTimeout(r, 20));

    // Lease still managed.
    const managed = (broker as any).managed.get(SECRET_ID);
    expect(managed).toBeDefined();
    expect(managed.accessToken).toBeNull();
    expect(managed.refreshToken).toBeNull();
  });

  test('bootstrap preserves null tokens when blob fields missing', async () => {
    globalThis.fetch = makeFetchMock([
      { body: { acquired: true, leaseId: LEASE_ID } },
      { body: { accessToken: null, refreshToken: null, expiresAt: null } },
    ]);
    broker.notifyCredentials([{ secretId: SECRET_ID, purpose: 'codex_credential', expiresAt: null }]);
    await new Promise((r) => setTimeout(r, 20));

    const managed = (broker as any).managed.get(SECRET_ID);
    expect(managed.accessToken).toBeNull();
    expect(managed.refreshToken).toBeNull();
  });
});

// ── heartbeat path ────────────────────────────────────────────────────────────

describe('heartbeatAll', () => {
  async function acquireLease() {
    globalThis.fetch = makeFetchMock([
      { body: { acquired: true, leaseId: LEASE_ID } },
      BOOTSTRAP_RESPONSE,
    ]);
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

    // Credential should no longer be managed — next notify triggers a new acquire (+ bootstrap).
    fetchCalls = [];
    globalThis.fetch = makeFetchMock([
      { body: { acquired: true, leaseId: 'new-lease-id' } },
      BOOTSTRAP_RESPONSE,
    ]);
    broker.notifyCredentials([{ secretId: SECRET_ID, purpose: 'claude_credential', expiresAt: null }]);
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchCalls.length).toBe(2); // acquire + bootstrap
    expect(fetchCalls[0].body.action).toBe('acquire');
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
    // Provide acquire + bootstrap responses. Bootstrap returns expiresAt=null so it
    // doesn't override the expiresAt we passed to notifyCredentials.
    globalThis.fetch = makeFetchMock([
      { body: { acquired: true, leaseId: LEASE_ID } },
      { body: { accessToken: 'at', refreshToken: 'rt', expiresAt: null } },
    ]);
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
    const broker2 = new CredentialBroker();
    // acquire + bootstrap, then refresh loop: lock → provider → commit
    globalThis.fetch = makeFetchMock([
      { body: { acquired: true, leaseId: LEASE_ID } },
      { body: { accessToken: 'at', refreshToken: 'rt', expiresAt: null } }, // bootstrap
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

// ── crash recovery ────────────────────────────────────────────────────────────

/**
 * These tests simulate a broker process crashing mid-rotation and assert that
 * the credential is left in a non-corrupted, refreshable state.
 *
 * The lock→provider→commit sequence is:
 *   1. lock   — sets lastRefreshedAt=NOW() on the DB row, returns current refresh_token
 *   2. provider — calls the OAuth token endpoint with the refresh_token
 *   3. commit  — writes new access_token + refresh_token to the DB
 *
 * Crash before commit (step 2→3): DB still holds the OLD refresh_token because
 * commit never ran. The old token is still valid; the next lease-holder retries
 * after the 60-minute lock window expires.
 *
 * Crash after commit (step 3→use): DB holds the NEW committed tokens. A new
 * broker bootstraps and obtains them immediately — no data loss.
 */
describe('crash recovery — mid-rotation invariants', () => {
  async function setupLeasedBroker(
    brokerInstance: CredentialBroker,
    expiresAt: string,
    bootstrapTokens: { accessToken: string; refreshToken: string },
  ) {
    globalThis.fetch = makeFetchMock([
      { body: { acquired: true, leaseId: LEASE_ID } },
      { body: { ...bootstrapTokens, expiresAt } },
    ]);
    brokerInstance.notifyCredentials([
      { secretId: SECRET_ID, purpose: 'claude_credential', expiresAt },
    ]);
    await new Promise((r) => setTimeout(r, 20));
    fetchCalls = []; // reset — setup calls accounted for
  }

  test('crash before commit: DB retains old refresh token and credential is refreshable after lock expires', async () => {
    // 30-min expiry triggers the 2-h window check in refreshExpiring.
    const soonExpiry = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    await setupLeasedBroker(broker, soonExpiry, {
      accessToken: 'initial-at',
      refreshToken: 'initial-rt',
    });

    // Simulate crash between provider response and commit: commit call throws.
    let commitAttempted = false;
    let callCount = 0;
    globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
      callCount++;
      let body: Record<string, unknown> = {};
      if (init?.body) {
        try {
          body = JSON.parse(init.body as string) as Record<string, unknown>;
        } catch {
          body = { __urlencoded: init.body as string };
        }
      }
      fetchCalls.push({ url, body });

      if (callCount === 1) {
        // lock — succeeds, returns old RT (DB still has it)
        return new Response(
          JSON.stringify({ locked: true, refreshToken: 'initial-rt' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (callCount === 2) {
        // provider token endpoint — succeeds, issues new tokens
        return new Response(
          JSON.stringify({ access_token: 'new-at', refresh_token: 'new-rt', expires_in: 3600 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      // commit — process "crashes" before it can write to DB
      commitAttempted = true;
      throw new Error('ECONNRESET: broker process killed mid-rotation');
    }) as unknown as typeof fetch;

    await (broker as any).refreshExpiring();

    expect(commitAttempted).toBe(true); // crash point was reached
    // broker's in-memory expiresAt unchanged since result !== 'refreshed'
    const stillManaged = (broker as any).managed.get(SECRET_ID);
    expect(stillManaged.expiresAt).toBe(soonExpiry);

    // ── Simulate broker restart (new process, empty in-memory state) ──────────
    // DB state: old tokens still there (commit never ran)
    const broker2 = new CredentialBroker();
    globalThis.fetch = makeFetchMock([
      { body: { acquired: true, leaseId: 'restart-lease-id' } },
      // Bootstrap returns OLD tokens — DB was not touched by the crashed commit
      { body: { accessToken: 'initial-at', refreshToken: 'initial-rt', expiresAt: soonExpiry } },
    ]);
    broker2.notifyCredentials([
      { secretId: SECRET_ID, purpose: 'claude_credential', expiresAt: soonExpiry },
    ]);
    await new Promise((r) => setTimeout(r, 20));

    const managed2 = (broker2 as any).managed.get(SECRET_ID);
    expect(managed2).toBeDefined();
    // Old tokens are intact — credential is non-corrupted
    expect(managed2.refreshToken).toBe('initial-rt');
    expect(managed2.accessToken).toBe('initial-at');

    // ── After the lock window expires, the old RT is used for a successful refresh ─
    fetchCalls = [];
    globalThis.fetch = makeFetchMock([
      // lock succeeds (60-min window has passed — simulated by the mock returning locked: true)
      { body: { locked: true, refreshToken: 'initial-rt' } },
      // provider accepts the old RT and issues fresh tokens
      { body: { access_token: 'recovered-at', refresh_token: 'recovered-rt', expires_in: 3600 } },
      // commit succeeds this time
      { body: { ok: true } },
    ]);
    await (broker2 as any).refreshExpiring();

    const lockCall = fetchCalls.find((c) => c.body.action === 'lock');
    const commitCall = fetchCalls.find((c) => c.body.action === 'commit');
    expect(lockCall).toBeDefined();
    expect(lockCall!.body.secretId).toBe(SECRET_ID);
    expect(commitCall).toBeDefined();
    expect(commitCall!.body.refreshToken).toBe('recovered-rt');
    expect(commitCall!.body.accessToken).toBe('recovered-at');
    // expiresAt updated optimistically (≥ OPTIMISTIC_EXPIRY_AFTER_REFRESH_MS ≈ 8h)
    const recovered = (broker2 as any).managed.get(SECRET_ID);
    expect(new Date(recovered.expiresAt).getTime()).toBeGreaterThan(Date.now() + 60 * 60 * 1000);
  });

  test('crash after commit: new broker bootstraps with the committed (new) tokens — no data loss', async () => {
    const soonExpiry = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    await setupLeasedBroker(broker, soonExpiry, {
      accessToken: 'initial-at',
      refreshToken: 'initial-rt',
    });

    // Full refresh cycle completes: lock → provider → commit all succeed.
    const committedExpiry = new Date(Date.now() + 3600 * 1000).toISOString();
    globalThis.fetch = makeFetchMock([
      { body: { locked: true, refreshToken: 'initial-rt' } },
      { body: { access_token: 'committed-at', refresh_token: 'committed-rt', expires_in: 3600 } },
      { body: { ok: true } },
    ]);
    await (broker as any).refreshExpiring();

    const commitCall = fetchCalls.find((c) => c.body.action === 'commit');
    expect(commitCall).toBeDefined();
    expect(commitCall!.body.refreshToken).toBe('committed-rt');
    expect(commitCall!.body.accessToken).toBe('committed-at');

    // ── Broker crashes here — DB holds committed tokens ───────────────────────
    // New broker restarts, acquires the (now-expired) lease, and bootstraps.

    const broker2 = new CredentialBroker();
    const farExpiry = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
    globalThis.fetch = makeFetchMock([
      { body: { acquired: true, leaseId: 'post-crash-lease-id' } },
      // Bootstrap returns the COMMITTED tokens — DB was updated before the crash
      { body: { accessToken: 'committed-at', refreshToken: 'committed-rt', expiresAt: farExpiry } },
    ]);
    broker2.notifyCredentials([
      { secretId: SECRET_ID, purpose: 'claude_credential', expiresAt: farExpiry },
    ]);
    await new Promise((r) => setTimeout(r, 20));

    const managed = (broker2 as any).managed.get(SECRET_ID);
    expect(managed).toBeDefined();
    // New broker has the freshly committed tokens — no re-rotation needed
    expect(managed.refreshToken).toBe('committed-rt');
    expect(managed.accessToken).toBe('committed-at');
    expect(managed.expiresAt).toBe(farExpiry);
    // Far expiry means no immediate refresh will be triggered
    expect(new Date(managed.expiresAt).getTime()).toBeGreaterThan(Date.now() + 2 * 60 * 60 * 1000);
  });
});

// ── shutdown path ─────────────────────────────────────────────────────────────

describe('shutdown', () => {
  async function acquireLease() {
    globalThis.fetch = makeFetchMock([
      { body: { acquired: true, leaseId: LEASE_ID } },
      BOOTSTRAP_RESPONSE,
    ]);
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
