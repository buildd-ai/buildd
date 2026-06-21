import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { installDbMock, dbState } from './_db-mock';

// No mock of '../report-ops' — we exercise the real reportOps and assert on the
// Pushover fetch it makes. Mocking it here would leak globally and clobber
// report-ops.test's import of the real module.
installDbMock();

import { recordRunnerOutcome } from '../runner-health';

const origFetch = globalThis.fetch;
let fetchCalls: any[];

function mockFetch() {
  fetchCalls = [];
  globalThis.fetch = ((_url: any, opts: any) => {
    fetchCalls.push({ body: opts?.body ? JSON.parse(opts.body) : undefined });
    return Promise.resolve({ ok: true });
  }) as any;
}

describe('recordRunnerOutcome', () => {
  beforeEach(() => {
    installDbMock();
    process.env.OPS_ALERTS_ENABLED = '1';
    process.env.PUSHOVER_USER = 'u';
    process.env.PUSHOVER_TOKEN_ALERT = 't';
    delete process.env.RUNNER_HEALTH_FAILURE_THRESHOLD;
    delete process.env.OPS_THROTTLE_MS;
    // Default failure increment returns a below-threshold count; also serves as
    // reportOps's "slot won" row when an alert does fire (truthy array).
    dbState.returning = () => Promise.resolve([{ value: { count: 1 } }]);
    mockFetch();
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
    delete process.env.OPS_ALERTS_ENABLED;
  });

  it('does not page on a completed outcome (streak reset)', async () => {
    await recordRunnerOutcome('completed');
    expect(fetchCalls.length).toBe(0);
  });

  it('does not page while the streak is below the threshold', async () => {
    dbState.returning = () => Promise.resolve([{ value: { count: 1 } }]);
    await recordRunnerOutcome('failed');
    expect(fetchCalls.length).toBe(0);
  });

  it('pages critical (priority 1) when the streak reaches the threshold', async () => {
    dbState.returning = () => Promise.resolve([{ value: { count: 3 } }]);
    await recordRunnerOutcome('failed');
    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].body.priority).toBe(1);
    expect(fetchCalls[0].body.title).toBe('[ops] runner-health');
  });

  it('respects RUNNER_HEALTH_FAILURE_THRESHOLD', async () => {
    process.env.RUNNER_HEALTH_FAILURE_THRESHOLD = '2';
    dbState.returning = () => Promise.resolve([{ value: { count: 2 } }]);
    await recordRunnerOutcome('failed');
    expect(fetchCalls.length).toBe(1);
  });

  it('never throws when the DB rejects', async () => {
    dbState.returning = () => Promise.reject(new Error('db down'));
    await expect(recordRunnerOutcome('failed')).resolves.toBeUndefined();
    expect(fetchCalls.length).toBe(0);
  });
});
