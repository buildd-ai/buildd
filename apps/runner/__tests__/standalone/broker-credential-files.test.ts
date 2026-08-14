/**
 * Credential-file update tests for apps/runner/src/broker.ts.
 *
 * IMPORTANT: This test uses real filesystem I/O (mkdtempSync, writeFileSync, readFileSync)
 * and must NOT share a process with tests that mock the 'fs' module.
 * Bun's mock.module is process-global: if any other unit test replaces 'fs' without
 * including these exports, the tests here will see mocked/incorrect results.
 * The standalone/ directory runs in isolation.
 *
 * Run standalone: bun test apps/runner/__tests__/standalone/broker-credential-files.test.ts
 *
 * Tests covered:
 *   1. registerCredentialFile / deregisterCredentialFile are callable without error
 *   2. credential file is updated on disk after a successful refresh + re-bootstrap
 *   3. credential file is NOT updated after deregisterCredentialFile
 *   4. in-memory accessToken is updated after refresh+re-bootstrap
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { CredentialBroker } from '../../src/broker';

const CONTROL_PLANE = 'https://buildd.dev';
const API_KEY = 'bld_test_key';
const SECRET_ID = 'cred-uuid-1111';
const RUNNER_ID = 'test-runner-host';
const LEASE_ID = 'lease-uuid-9999';

const originalFetch = globalThis.fetch;
let fetchCalls: Array<{ url: string; body: Record<string, unknown> }>;

function makeFetchMock(responses: Array<{ body: unknown; status?: number }>) {
  let callIndex = 0;
  fetchCalls = [];
  return async (url: string, init?: RequestInit) => {
    let body: Record<string, unknown> = {};
    if (init?.body) {
      try { body = JSON.parse(init.body as string) as Record<string, unknown>; } catch {}
    }
    fetchCalls.push({ url, body });
    const r = responses[callIndex++] ?? { body: {}, status: 200 };
    return new Response(JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

let broker: CredentialBroker;
let tmpDir: string;

beforeEach(() => {
  process.env.BUILDD_CLIENT_URL = CONTROL_PLANE;
  process.env.BUILDD_API_KEY = API_KEY;
  process.env.BUILDD_RUNNER_ID = RUNNER_ID;
  broker = new CredentialBroker();
  tmpDir = mkdtempSync(join(tmpdir(), 'broker-cred-test-'));
  fetchCalls = [];
});

afterEach(async () => {
  await broker.shutdown();
  globalThis.fetch = originalFetch;
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

async function acquireAndBootstrap(b: CredentialBroker, token: string, rt = 'rt') {
  globalThis.fetch = makeFetchMock([
    { body: { acquired: true, leaseId: LEASE_ID } },
    { body: { accessToken: token, refreshToken: rt, expiresAt: null } },
  ]) as unknown as typeof fetch;
  b.notifyCredentials([{ secretId: SECRET_ID, purpose: 'claude_credential', expiresAt: null }]);
  await new Promise((r) => setTimeout(r, 20));
}

describe('registerCredentialFile / deregisterCredentialFile', () => {
  test('registerCredentialFile and deregisterCredentialFile are callable without error', async () => {
    await acquireAndBootstrap(broker, 'initial-token');
    const credPath = join(tmpDir, '.credentials.json');
    writeFileSync(credPath, JSON.stringify({ type: 'oauth_token', access_token: 'initial-token' }));

    expect(() => broker.registerCredentialFile('worker-1', SECRET_ID, credPath)).not.toThrow();
    expect(() => broker.deregisterCredentialFile('worker-1')).not.toThrow();
  });

  test('credential file is updated after a successful refresh', async () => {
    await acquireAndBootstrap(broker, 'initial-at', 'initial-rt');

    const credPath = join(tmpDir, '.credentials.json');
    writeFileSync(credPath, JSON.stringify({ type: 'oauth_token', access_token: 'initial-at' }));
    broker.registerCredentialFile('worker-1', SECRET_ID, credPath);

    const soonExpiry = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    (broker as any).managed.get(SECRET_ID).expiresAt = soonExpiry;

    // refreshExpiring: lock → provider → commit → re-bootstrap
    globalThis.fetch = makeFetchMock([
      { body: { locked: true, refreshToken: 'initial-rt' } },
      { body: { access_token: 'fresh-at', refresh_token: 'fresh-rt', expires_in: 3600 } },
      { body: { ok: true } },
      { body: { accessToken: 'fresh-at', refreshToken: 'fresh-rt', expiresAt: null } },
    ]) as unknown as typeof fetch;
    await (broker as any).refreshExpiring();

    const written = JSON.parse(readFileSync(credPath, 'utf-8')) as { access_token: string };
    expect(written.access_token).toBe('fresh-at');
  });

  test('credential file is NOT updated after deregisterCredentialFile', async () => {
    await acquireAndBootstrap(broker, 'initial-at', 'initial-rt');

    const credPath = join(tmpDir, '.credentials.json');
    writeFileSync(credPath, JSON.stringify({ type: 'oauth_token', access_token: 'initial-at' }));
    broker.registerCredentialFile('worker-1', SECRET_ID, credPath);
    broker.deregisterCredentialFile('worker-1');

    const soonExpiry = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    (broker as any).managed.get(SECRET_ID).expiresAt = soonExpiry;

    globalThis.fetch = makeFetchMock([
      { body: { locked: true, refreshToken: 'initial-rt' } },
      { body: { access_token: 'fresh-at', refresh_token: 'fresh-rt', expires_in: 3600 } },
      { body: { ok: true } },
      { body: { accessToken: 'fresh-at', refreshToken: 'fresh-rt', expiresAt: null } },
    ]) as unknown as typeof fetch;
    await (broker as any).refreshExpiring();

    const written = JSON.parse(readFileSync(credPath, 'utf-8')) as { access_token: string };
    expect(written.access_token).toBe('initial-at');
  });

  test('in-memory accessToken is updated after refresh+re-bootstrap', async () => {
    await acquireAndBootstrap(broker, 'initial-at', 'initial-rt');

    const soonExpiry = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    (broker as any).managed.get(SECRET_ID).expiresAt = soonExpiry;

    globalThis.fetch = makeFetchMock([
      { body: { locked: true, refreshToken: 'initial-rt' } },
      { body: { access_token: 'fresh-at', refresh_token: 'fresh-rt', expires_in: 3600 } },
      { body: { ok: true } },
      { body: { accessToken: 'fresh-at', refreshToken: 'fresh-rt', expiresAt: null } },
    ]) as unknown as typeof fetch;
    await (broker as any).refreshExpiring();

    expect((broker as any).managed.get(SECRET_ID).accessToken).toBe('fresh-at');
  });
});
