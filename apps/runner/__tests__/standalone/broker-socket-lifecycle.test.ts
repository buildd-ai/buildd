/**
 * Socket lifecycle tests for apps/runner/src/broker.ts.
 *
 * IMPORTANT: This test uses real filesystem I/O (statSync, existsSync, unlinkSync)
 * and must NOT share a process with tests that mock the 'fs' module.
 * Bun's mock.module is process-global: if any other test in the same process
 * replaces 'fs' without including statSync/existsSync/unlinkSync, these tests
 * will see incorrect results. The standalone/ directory runs in isolation.
 *
 * Run standalone: bun test apps/runner/__tests__/standalone/broker-socket-lifecycle.test.ts
 *
 * Tests covered:
 *   1. start() creates a unix socket at socketPath
 *   2. start() sets socket file permissions to 0600
 *   3. shutdown() removes the socket file
 *   4. start() removes a stale socket file from a previous crash before binding
 *   5. GET /token from a live unix socket returns 200 with expected JSON shape
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { statSync, unlinkSync, existsSync, writeFileSync } from 'fs';
import { CredentialBroker } from '../../src/broker';

const SOCKET_PATH = `/tmp/buildd-broker-standalone-${process.pid}.sock`;

const realFetch = globalThis.fetch; // preserve before any test overrides it

function noopFetch() {
  return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
}

let broker: CredentialBroker;

beforeEach(() => {
  process.env.BUILDD_CLIENT_URL = 'https://buildd.dev';
  process.env.BUILDD_API_KEY = 'bld_test_key';
  process.env.BUILDD_RUNNER_ID = 'test-runner';
  process.env.BUILDD_BROKER_SOCKET = SOCKET_PATH;
  try { unlinkSync(SOCKET_PATH); } catch {}
  broker = new CredentialBroker();
  globalThis.fetch = noopFetch as unknown as typeof fetch;
});

afterEach(async () => {
  await broker.shutdown();
  try { unlinkSync(SOCKET_PATH); } catch {}
  globalThis.fetch = realFetch;
});

describe('socket lifecycle', () => {
  test('start() creates a unix socket at socketPath', async () => {
    broker.start();
    await new Promise((r) => setTimeout(r, 30));
    expect(existsSync(SOCKET_PATH)).toBe(true);
    const stat = statSync(SOCKET_PATH);
    expect(stat.isSocket()).toBe(true);
  });

  test('start() sets socket file permissions to 0600', async () => {
    broker.start();
    await new Promise((r) => setTimeout(r, 30));
    const stat = statSync(SOCKET_PATH);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  test('shutdown() removes the socket file', async () => {
    broker.start();
    await new Promise((r) => setTimeout(r, 30));
    expect(existsSync(SOCKET_PATH)).toBe(true);
    await broker.shutdown();
    expect(existsSync(SOCKET_PATH)).toBe(false);
  });

  test('start() removes a stale socket file from a previous crash before binding', async () => {
    writeFileSync(SOCKET_PATH, '');
    expect(existsSync(SOCKET_PATH)).toBe(true);

    broker.start();
    await new Promise((r) => setTimeout(r, 30));
    const stat = statSync(SOCKET_PATH);
    expect(stat.isSocket()).toBe(true);
  });
});

describe('live unix socket requests', () => {
  const SECRET_ID = 'cred-live-test';
  const ACCESS_TOKEN = 'sk-ant-live-at-12345';
  const EXPIRES_AT = '2030-06-01T00:00:00Z';

  async function hitSocket(body: object): Promise<Response> {
    // Use realFetch (not globalThis.fetch which is mocked to noopFetch) and
    // the Bun-specific `unix` option to route the request over the unix socket.
    return realFetch(`http://localhost/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      // @ts-ignore — Bun-specific unix socket fetch option
      unix: SOCKET_PATH,
    });
  }

  test('returns 200 with access_token and expires_at for a managed credential', async () => {
    broker.start();
    await new Promise((r) => setTimeout(r, 30));

    (broker as any).managed.set(SECRET_ID, {
      purpose: 'claude_credential',
      expiresAt: EXPIRES_AT,
      leaseId: 'lease-live-1',
      accessToken: ACCESS_TOKEN,
      refreshToken: 'rt-live',
    });

    const res = await hitSocket({ credential_id: SECRET_ID });
    expect(res.status).toBe(200);
    const body = await res.json() as { access_token: string; expires_at: string };
    expect(body.access_token).toBe(ACCESS_TOKEN);
    expect(body.expires_at).toBe(EXPIRES_AT);
  });

  test('returns 404 for an unknown credential_id', async () => {
    broker.start();
    await new Promise((r) => setTimeout(r, 30));

    const res = await hitSocket({ credential_id: 'not-managed' });
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('not_managed');
  });

  test('returns 503 when credential is managed but access_token is null', async () => {
    broker.start();
    await new Promise((r) => setTimeout(r, 30));

    (broker as any).managed.set(SECRET_ID, {
      purpose: 'claude_credential',
      expiresAt: EXPIRES_AT,
      leaseId: 'lease-live-2',
      accessToken: null,
      refreshToken: 'rt-bootstrapping',
    });

    const res = await hitSocket({ credential_id: SECRET_ID });
    expect(res.status).toBe(503);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('not_ready');
  });
});
