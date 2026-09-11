/**
 * Regression: the runner's build commit/version were computed locally
 * (`/api/version`) but never left the box, so a runner still running a
 * pre-fix commit was undetectable from the platform without SSH. The
 * heartbeat now carries `runnerCommit`/`runnerVersion` — this test locks
 * down the payload shaping in BuilddClient.sendHeartbeat.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/buildd-heartbeat-runner-version.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { BuilddClient } from '../../src/buildd';
import type { LocalUIConfig } from '../../src/types';

const originalFetch = globalThis.fetch;
let capturedBody: any = null;

function mockFetchCapturing(status = 200, json: any = {}) {
  return mock((_url: string, opts: any) => {
    capturedBody = opts?.body ? JSON.parse(opts.body) : null;
    return Promise.resolve(new Response(JSON.stringify(json), { status }));
  });
}

const testConfig: LocalUIConfig = {
  projectRoots: [],
  builddServer: 'https://test.buildd.dev',
  apiKey: 'bld_test123',
  maxConcurrent: 1,
  model: 'claude-sonnet-5',
};

describe('BuilddClient.sendHeartbeat — runnerCommit/runnerVersion', () => {
  beforeEach(() => {
    capturedBody = null;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('includes runnerCommit and runnerVersion when both are truthy', async () => {
    globalThis.fetch = mockFetchCapturing() as any;
    const client = new BuilddClient(testConfig);

    await client.sendHeartbeat(
      'http://localhost:8766',
      0,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'abc1234',
      '1.2.3',
    );

    expect(capturedBody.runnerCommit).toBe('abc1234');
    expect(capturedBody.runnerVersion).toBe('1.2.3');
  });

  it('omits runnerCommit and runnerVersion from the payload when null (fresh disk read failed)', async () => {
    globalThis.fetch = mockFetchCapturing() as any;
    const client = new BuilddClient(testConfig);

    await client.sendHeartbeat(
      'http://localhost:8766',
      0,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      null,
      null,
    );

    expect('runnerCommit' in capturedBody).toBe(false);
    expect('runnerVersion' in capturedBody).toBe(false);
  });

  it('omits both fields when the caller does not pass them at all (legacy call site)', async () => {
    globalThis.fetch = mockFetchCapturing() as any;
    const client = new BuilddClient(testConfig);

    await client.sendHeartbeat('http://localhost:8766', 0);

    expect('runnerCommit' in capturedBody).toBe(false);
    expect('runnerVersion' in capturedBody).toBe(false);
  });
});
