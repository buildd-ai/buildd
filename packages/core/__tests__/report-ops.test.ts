import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { installDbMock, dbState } from './_db-mock';

installDbMock();

import { reportOps } from '../report-ops';

const origFetch = globalThis.fetch;
let fetchCalls: any[];

function mockFetch(impl?: () => Promise<any>) {
  fetchCalls = [];
  globalThis.fetch = ((url: any, opts: any) => {
    fetchCalls.push({ url, body: opts?.body ? JSON.parse(opts.body) : undefined });
    return impl ? impl() : Promise.resolve({ ok: true });
  }) as any;
}

describe('reportOps', () => {
  beforeEach(() => {
    installDbMock();
    process.env.OPS_ALERTS_ENABLED = '1';
    process.env.PUSHOVER_USER = 'u';
    process.env.PUSHOVER_TOKEN_ALERT = 't';
    delete process.env.OPS_THROTTLE_MS;
    // Default: slot won (a row returned).
    dbState.returning = () => Promise.resolve([{ key: 'ops:abc' }]);
    mockFetch();
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
    delete process.env.OPS_ALERTS_ENABLED;
  });

  it('is a no-op when OPS_ALERTS_ENABLED is unset', async () => {
    delete process.env.OPS_ALERTS_ENABLED;
    const ok = await reportOps({ source: 's', message: 'm' });
    expect(ok).toBe(false);
    expect(fetchCalls.length).toBe(0);
  });

  it('sends on first occurrence (slot won)', async () => {
    const ok = await reportOps({ source: 'routing-analytics', message: 'recordTaskOutcome failed', detail: 'boom' });
    expect(ok).toBe(true);
    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].body.title).toBe('[ops] routing-analytics');
    expect(fetchCalls[0].body.message).toBe('recordTaskOutcome failed\nboom');
  });

  it('suppresses when the dedup slot is still held (no row returned)', async () => {
    dbState.returning = () => Promise.resolve([]);
    const ok = await reportOps({ source: 's', message: 'm' });
    expect(ok).toBe(false);
    expect(fetchCalls.length).toBe(0);
  });

  it('uses priority -2 for warnings, 0 for errors, 1 for critical', async () => {
    await reportOps({ source: 's', message: 'warn' });
    expect(fetchCalls[0].body.priority).toBe(-2);
    mockFetch();
    await reportOps({ source: 's', message: 'err', severity: 'error' });
    expect(fetchCalls[0].body.priority).toBe(0);
    mockFetch();
    await reportOps({ source: 's', message: 'crit', severity: 'critical' });
    expect(fetchCalls[0].body.priority).toBe(1);
  });

  it('never throws when the DB claim rejects', async () => {
    dbState.returning = () => Promise.reject(new Error('db down'));
    const ok = await reportOps({ source: 's', message: 'm' });
    expect(ok).toBe(false);
  });

  it('never throws when fetch rejects', async () => {
    mockFetch(() => Promise.reject(new Error('network')));
    const ok = await reportOps({ source: 's', message: 'm' });
    expect(ok).toBe(false);
  });

  it('does not send when Pushover env is missing', async () => {
    delete process.env.PUSHOVER_USER;
    const ok = await reportOps({ source: 's', message: 'm' });
    expect(ok).toBe(true); // slot won, but delivery is a no-op
    expect(fetchCalls.length).toBe(0);
  });
});
