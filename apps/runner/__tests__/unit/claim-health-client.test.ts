/**
 * N3: BuilddClient.claimTask feeds the process-wide claim-health tracker.
 * Three 5xx replies in a row put the doctor's claim-health check in error
 * (degraded); an empty 5xx body is logged by name rather than as nothing.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/claim-health-client.test.ts
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { BuilddClient } from '../../src/buildd';
import { claimHealth, withClaimHealthCheck } from '../../src/claim-budget-signals';
import type { LocalUIConfig } from '../../src/types';

const realFetch = globalThis.fetch;
const realError = console.error;

function makeClient() {
  return new BuilddClient({
    projectsRoot: '/tmp',
    builddServer: 'http://server.invalid',
    apiKey: 'test-key',
    maxConcurrent: 1,
  } as LocalUIConfig);
}

function respondWith(status: number, body: string) {
  globalThis.fetch = (async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    json: async () => JSON.parse(body),
  })) as any;
}

const emptyReport = () => ({ timestamp: 't', checks: [], summary: { ok: 0, warn: 0, error: 0 } });

describe('claimTask → claim health', () => {
  let logged: string[];
  beforeEach(() => {
    claimHealth.recordSuccess();
    logged = [];
    console.error = (...a: unknown[]) => { logged.push(a.map(String).join(' ')); };
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    console.error = realError;
    claimHealth.recordSuccess();
  });

  test('three simulated 500s put the doctor in degraded', async () => {
    const client = makeClient();
    respondWith(500, '');
    for (let i = 0; i < 3; i++) {
      await client.claimTask(1).catch(() => {});
    }
    expect(claimHealth.isDegraded()).toBe(true);
    const check = withClaimHealthCheck(emptyReport()).checks.find(c => c.name === 'claim-health');
    expect(check?.status).toBe('error');
    expect(check?.message).toContain('degraded');
  });

  test('an empty 5xx body is logged as "(empty body)"', async () => {
    respondWith(502, '');
    await makeClient().claimTask(1).catch(() => {});
    expect(logged.some(l => l.includes('HTTP 502') && l.includes('(empty body)'))).toBe(true);
  });

  test('a successful claim clears the streak', async () => {
    const client = makeClient();
    respondWith(500, '');
    for (let i = 0; i < 3; i++) await client.claimTask(1).catch(() => {});
    respondWith(200, JSON.stringify({ workers: [] }));
    await client.claimTask(1);
    expect(claimHealth.isDegraded()).toBe(false);
    expect(claimHealth.streak).toBe(0);
  });

  test('a 4xx refusal is the server answering — it does not extend a 5xx streak', async () => {
    const client = makeClient();
    respondWith(500, '');
    await client.claimTask(1).catch(() => {});
    await client.claimTask(1).catch(() => {});
    respondWith(429, JSON.stringify({ error: 'Budget exhausted' }));
    await client.claimTask(1).catch(() => {});
    expect(claimHealth.streak).toBe(0);
  });
});
