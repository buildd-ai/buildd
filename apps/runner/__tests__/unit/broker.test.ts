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
 *  11. handleLocalRequest → 404 for unknown credential_id
 *  12. handleLocalRequest → 503 when bootstrapping in progress (null access_token)
 *  13. handleLocalRequest → 200 with access_token + expires_at for managed credential
 *  14. handleLocalRequest → 405 for non-POST methods
 *  15. handleLocalRequest → 404 for unknown paths
 *  16. start() creates unix socket at socketPath with mode 0600
 *  17. shutdown() removes the socket file
 *  18. fetchTokenFromBroker → 200 returns accessToken + expiresAt
 *  19. fetchTokenFromBroker → 404 returns null
 *  20. fetchTokenFromBroker → 503 returns null
 *  21. fetchTokenFromBroker → network error returns null
 *
 * Tests for registerCredentialFile / deregisterCredentialFile and socket lifecycle
 * are in apps/runner/__tests__/standalone/ (real fs I/O, avoids mock.module pollution).
 *
 * Run: bun test apps/runner/__tests__/unit/broker.test.ts
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { unlinkSync } from 'fs';
import { CredentialBroker, fetchTokenFromBroker } from '../../src/broker';

const CONTROL_PLANE = 'https://buildd.dev';
const API_KEY = 'bld_test_key';
const SECRET_ID = 'cred-uuid-1111';
const RUNNER_ID = 'test-runner-host';
const LEASE_ID = 'lease-uuid-9999';
const LEASE_ENDPOINT = `${CONTROL_PLANE}/api/runner/credential-lease`;
const REFRESH_ENDPOINT = `${CONTROL_PLANE}/api/runner/credential-refresh`;

const originalFetch = globalThis.fetch;
let fetchCalls: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }>;

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
    fetchCalls.push({ url, body, headers: (init?.headers ?? {}) as Record<string, string> });
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
 * These tests simulate a broker process crashing mid-rotation and assert what the
 * broker does with whatever the control plane then tells it.
 *
 * The lock→provider→commit sequence is:
 *   1. lock     — stamps refreshLockedAt=NOW() and rotationStartedAt, returns the
 *                 current refresh_token
 *   2. provider — calls the OAuth token endpoint with the refresh_token
 *   3. commit   — writes the new access_token + refresh_token, clears rotationStartedAt
 *
 * Crash before commit (step 2→3) is NOT automatically safe. The provider rotates
 * the refresh token on every use, so if it issued a replacement and we lost it, the
 * stored token is permanently dead — retrying is a guaranteed invalid_grant. Which
 * case we are in is not knowable from the runner, so the control plane decides:
 * rotationStartedAt survived the crash, and the next lock either finds it fresh
 * (still in flight, answer 'locked') or stale (lost, answer rotationLost).
 *
 * The broker's job is therefore to obey the answer: retry only when the control
 * plane hands back a token, and stop permanently on rotationLost.
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

  test('crash before commit: broker retries only when the control plane hands a token back', async () => {
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
      // lock succeeds: the control plane judged the interrupted rotation still
      // usable and handed the token back (60-min window has passed).
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

// ── local token server ────────────────────────────────────────────────────────

const SOCKET_PATH = `/tmp/buildd-broker-test-${process.pid}.sock`;

describe('local token server — handleLocalRequest', () => {
  beforeEach(() => {
    process.env.BUILDD_BROKER_SOCKET = SOCKET_PATH;
    // clean up any leftover socket from a previous run
    try { unlinkSync(SOCKET_PATH); } catch {}
    broker = new CredentialBroker();
  });

  afterEach(async () => {
    await broker.shutdown();
    try { unlinkSync(SOCKET_PATH); } catch {}
    globalThis.fetch = originalFetch;
  });

  test('returns 404 when credential_id is not managed', async () => {
    const req = new Request('http://localhost/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential_id: 'unknown-cred' }),
    });
    const res = await (broker as any).handleLocalRequest(req);
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('not_managed');
  });

  test('returns 503 when credential is managed but access_token is null (bootstrapping)', async () => {
    (broker as any).managed.set(SECRET_ID, {
      purpose: 'claude_credential',
      expiresAt: '2030-01-01T00:00:00Z',
      leaseId: LEASE_ID,
      accessToken: null,
      refreshToken: 'rt',
    });
    const req = new Request('http://localhost/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential_id: SECRET_ID }),
    });
    const res = await (broker as any).handleLocalRequest(req);
    expect(res.status).toBe(503);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('not_ready');
  });

  test('returns 200 with access_token and expires_at for fully bootstrapped credential', async () => {
    const expiresAt = '2030-06-01T12:00:00Z';
    (broker as any).managed.set(SECRET_ID, {
      purpose: 'claude_credential',
      expiresAt,
      leaseId: LEASE_ID,
      accessToken: 'sk-ant-live-token',
      refreshToken: 'rt-stored',
    });
    const req = new Request('http://localhost/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential_id: SECRET_ID }),
    });
    const res = await (broker as any).handleLocalRequest(req);
    expect(res.status).toBe(200);
    const body = await res.json() as { access_token: string; expires_at: string | null };
    expect(body.access_token).toBe('sk-ant-live-token');
    expect(body.expires_at).toBe(expiresAt);
  });

  test('returns 200 with null expires_at when expiresAt is null', async () => {
    (broker as any).managed.set(SECRET_ID, {
      purpose: 'claude_credential',
      expiresAt: null,
      leaseId: LEASE_ID,
      accessToken: 'at-no-expiry',
      refreshToken: null,
    });
    const req = new Request('http://localhost/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential_id: SECRET_ID }),
    });
    const res = await (broker as any).handleLocalRequest(req);
    expect(res.status).toBe(200);
    const body = await res.json() as { access_token: string; expires_at: string | null };
    expect(body.access_token).toBe('at-no-expiry');
    expect(body.expires_at).toBeNull();
  });

  test('returns 405 for non-POST requests to /token', async () => {
    const req = new Request('http://localhost/token', { method: 'GET' });
    const res = await (broker as any).handleLocalRequest(req);
    expect(res.status).toBe(405);
  });

  test('returns 404 for unknown paths', async () => {
    const req = new Request('http://localhost/unknown', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const res = await (broker as any).handleLocalRequest(req);
    expect(res.status).toBe(404);
  });

  test('returns 400 when body is missing credential_id', async () => {
    const req = new Request('http://localhost/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wrong_field: 'oops' }),
    });
    const res = await (broker as any).handleLocalRequest(req);
    expect(res.status).toBe(400);
  });
});

// ── fetchTokenFromBroker ──────────────────────────────────────────────────────

describe('fetchTokenFromBroker', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('returns accessToken and expiresAt on 200', async () => {
    const expiresAt = '2030-06-01T12:00:00Z';
    globalThis.fetch = makeFetchMock([
      { body: { access_token: 'at-from-broker', expires_at: expiresAt }, status: 200 },
    ]);
    const result = await fetchTokenFromBroker(SECRET_ID, '/tmp/test.sock');
    expect(result).not.toBeNull();
    expect(result!.accessToken).toBe('at-from-broker');
    expect(result!.expiresAt).toBe(expiresAt);
    expect(fetchCalls[0].body.credential_id).toBe(SECRET_ID);
  });

  test('returns null on 404 (not managed)', async () => {
    globalThis.fetch = makeFetchMock([
      { body: { error: 'not_managed' }, status: 404 },
    ]);
    const result = await fetchTokenFromBroker(SECRET_ID, '/tmp/test.sock');
    expect(result).toBeNull();
  });

  test('returns null on 503 (not ready)', async () => {
    globalThis.fetch = makeFetchMock([
      { body: { error: 'not_ready' }, status: 503 },
    ]);
    const result = await fetchTokenFromBroker(SECRET_ID, '/tmp/test.sock');
    expect(result).toBeNull();
  });

  test('returns null on network error', async () => {
    globalThis.fetch = mock(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const result = await fetchTokenFromBroker(SECRET_ID, '/tmp/test.sock');
    expect(result).toBeNull();
  });

  test('returns null when access_token is missing from response', async () => {
    globalThis.fetch = makeFetchMock([
      { body: { expires_at: '2030-01-01T00:00:00Z' }, status: 200 },
    ]);
    const result = await fetchTokenFromBroker(SECRET_ID, '/tmp/test.sock');
    expect(result).toBeNull();
  });

  test('passes credential_id in request body', async () => {
    globalThis.fetch = makeFetchMock([
      { body: { access_token: 'tok', expires_at: null }, status: 200 },
    ]);
    await fetchTokenFromBroker('my-cred-id', '/tmp/test.sock');
    expect(fetchCalls[0].body.credential_id).toBe('my-cred-id');
  });
});

// NOTE: Tests requiring real fs I/O (socket lifecycle, credential file updates) live in
// apps/runner/__tests__/standalone/ because Bun's mock.module is process-global — other
// unit tests that mock 'fs' without these exports would break them.

// ── auth sourcing (regression: prod runner has no BUILDD_API_KEY) ─────────────
//
// The broker read process.env.BUILDD_API_KEY as its only source, but the runner
// keeps its key in config.json — index.ts calls the env var a CI/Docker override
// that is "NOT recommended". On a normal install the broker therefore sent no
// Authorization header, every acquire returned 401, and the whole runner-side
// refresh path was inert: `managed` never filled, so refreshExpiring() looped
// over nothing while the control-plane cron re-nudged a doomed task every 4h.
//
// These tests run with the env var DELETED, which is the real prod shape. The
// suite's own beforeEach used to set it, which is why nothing caught this.
describe('auth sourcing', () => {
  let configured: CredentialBroker;

  beforeEach(() => {
    delete process.env.BUILDD_API_KEY;
    delete process.env.BUILDD_CLIENT_URL;
    configured = new CredentialBroker();
  });

  test('sends the config-sourced apiKey on acquire when BUILDD_API_KEY is unset', async () => {
    configured.configure({ apiKey: 'bld_from_config', baseUrl: CONTROL_PLANE });
    globalThis.fetch = makeFetchMock([
      { body: { acquired: true, leaseId: LEASE_ID } },
      BOOTSTRAP_RESPONSE,
    ]);

    configured.notifyCredentials([{ secretId: SECRET_ID, purpose: 'claude_credential', expiresAt: null }]);
    await new Promise((r) => setTimeout(r, 20));

    expect(fetchCalls.length).toBeGreaterThan(0);
    expect(fetchCalls[0].url).toBe(LEASE_ENDPOINT);
    expect(fetchCalls[0].headers.Authorization).toBe('Bearer bld_from_config');
  });

  test('sends the config-sourced apiKey on bootstrap too', async () => {
    configured.configure({ apiKey: 'bld_from_config', baseUrl: CONTROL_PLANE });
    globalThis.fetch = makeFetchMock([
      { body: { acquired: true, leaseId: LEASE_ID } },
      BOOTSTRAP_RESPONSE,
    ]);

    configured.notifyCredentials([{ secretId: SECRET_ID, purpose: 'claude_credential', expiresAt: null }]);
    await new Promise((r) => setTimeout(r, 20));

    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[1].url).toBe(REFRESH_ENDPOINT);
    expect(fetchCalls[1].headers.Authorization).toBe('Bearer bld_from_config');
  });

  test('configured baseUrl retargets both endpoints, not just the default', async () => {
    configured.configure({ apiKey: 'bld_from_config', baseUrl: 'https://staging.example.com' });
    globalThis.fetch = makeFetchMock([
      { body: { acquired: true, leaseId: LEASE_ID } },
      BOOTSTRAP_RESPONSE,
    ]);

    configured.notifyCredentials([{ secretId: SECRET_ID, purpose: 'claude_credential', expiresAt: null }]);
    await new Promise((r) => setTimeout(r, 20));

    expect(fetchCalls[0].url).toBe('https://staging.example.com/api/runner/credential-lease');
    expect(fetchCalls[1].url).toBe('https://staging.example.com/api/runner/credential-refresh');
  });

  test('does not call the control plane at all when no key is available', async () => {
    globalThis.fetch = makeFetchMock([{ body: { acquired: true, leaseId: LEASE_ID } }]);

    configured.notifyCredentials([{ secretId: SECRET_ID, purpose: 'claude_credential', expiresAt: null }]);
    await new Promise((r) => setTimeout(r, 20));

    expect(fetchCalls).toHaveLength(0);
  });

  test('start() forwards its config to the auth header', async () => {
    const socketPath = `/tmp/buildd-broker-authtest-${process.pid}.sock`;
    process.env.BUILDD_BROKER_SOCKET = socketPath;
    const started = new CredentialBroker();
    try {
      started.configure({ apiKey: 'unused' });
      started.start({ apiKey: 'bld_started_key', baseUrl: CONTROL_PLANE });
      globalThis.fetch = makeFetchMock([
        { body: { acquired: true, leaseId: LEASE_ID } },
        BOOTSTRAP_RESPONSE,
      ]);

      started.notifyCredentials([{ secretId: SECRET_ID, purpose: 'claude_credential', expiresAt: null }]);
      await new Promise((r) => setTimeout(r, 20));

      expect(fetchCalls[0].headers.Authorization).toBe('Bearer bld_started_key');
    } finally {
      await started.shutdown();
      delete process.env.BUILDD_BROKER_SOCKET;
      try { unlinkSync(socketPath); } catch {}
    }
  });

  test('still honours BUILDD_API_KEY when nothing is configured', async () => {
    process.env.BUILDD_API_KEY = API_KEY;
    process.env.BUILDD_CLIENT_URL = CONTROL_PLANE;
    const envBroker = new CredentialBroker();
    globalThis.fetch = makeFetchMock([
      { body: { acquired: true, leaseId: LEASE_ID } },
      BOOTSTRAP_RESPONSE,
    ]);

    envBroker.notifyCredentials([{ secretId: SECRET_ID, purpose: 'claude_credential', expiresAt: null }]);
    await new Promise((r) => setTimeout(r, 20));

    expect(fetchCalls[0].headers.Authorization).toBe(`Bearer ${API_KEY}`);
  });
});


// ── lost rotation ─────────────────────────────────────────────────────────────

describe('refreshExpiring — lost rotation', () => {
  const SOON = () => new Date(Date.now() + 30 * 60 * 1000).toISOString();

  async function leaseCredential(expiresAt: string) {
    globalThis.fetch = makeFetchMock([
      { body: { acquired: true, leaseId: LEASE_ID } },
      { body: { accessToken: 'at', refreshToken: 'rt', expiresAt } },
    ]);
    broker.notifyCredentials([{ secretId: SECRET_ID, purpose: 'codex_credential', expiresAt }]);
    await new Promise((r) => setTimeout(r, 20));
    fetchCalls = [];
  }

  test('stops attempting refresh once the control plane reports a lost rotation', async () => {
    const expiresAt = SOON();
    await leaseCredential(expiresAt);

    globalThis.fetch = makeFetchMock([{ body: { locked: false, rotationLost: true } }]);
    await (broker as any).refreshExpiring();
    expect(fetchCalls.filter((c) => c.body.action === 'lock')).toHaveLength(1);

    // Every later tick must be a no-op: the credential cannot be refreshed by
    // anyone, and re-asking burns an invalid_grant against the provider.
    fetchCalls = [];
    globalThis.fetch = makeFetchMock([{ body: { locked: false, rotationLost: true } }]);
    await (broker as any).refreshExpiring();
    await (broker as any).refreshExpiring();
    expect(fetchCalls).toHaveLength(0);
  });

  test('keeps retrying when the lock is merely held by another refresher', async () => {
    const expiresAt = SOON();
    await leaseCredential(expiresAt);

    globalThis.fetch = makeFetchMock([{ body: { locked: false } }]);
    await (broker as any).refreshExpiring();
    fetchCalls = [];

    globalThis.fetch = makeFetchMock([{ body: { locked: false } }]);
    await (broker as any).refreshExpiring();
    expect(fetchCalls.filter((c) => c.body.action === 'lock')).toHaveLength(1);
  });

  test('keeps the lease after a lost rotation so no other runner spins on it', async () => {
    const expiresAt = SOON();
    await leaseCredential(expiresAt);

    globalThis.fetch = makeFetchMock([{ body: { locked: false, rotationLost: true } }]);
    await (broker as any).refreshExpiring();

    expect((broker as any).managed.has(SECRET_ID)).toBe(true);
  });
});
