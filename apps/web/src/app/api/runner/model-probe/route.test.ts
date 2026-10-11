import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const PROBER = 'acct-prober';
const OTHER = 'acct-other';

const mockAuth = mock(async () => ({ id: PROBER, level: 'worker' }) as any);
const mockLease = mock(async () => ({ model: 'claude-haiku-5-5', leaseId: 'lease-1' }) as any);
const mockReport = mock(async () => ({ ok: true, certification: { state: 'certified' } }) as any);

mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuth }));
mock.module('@buildd/core/model-catalog-cache', () => ({
  getCachedOpenRouterCatalog: async () => [{ id: 'claude-haiku-5-5' }],
}));
mock.module('@buildd/core/model-certification-store', () => ({
  leaseModelProbe: mockLease,
  reportModelProbe: mockReport,
}));

process.env.BUILDD_MODEL_PROBE_ACCOUNT_IDS = PROBER;
const { POST: LEASE } = await import('./route');
const { POST: REPORT } = await import('./report/route');

const post = (path: string, body: unknown) =>
  new NextRequest(`http://localhost${path}`, {
    method: 'POST',
    headers: { Authorization: 'Bearer bld_x', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  mockAuth.mockReset();
  mockAuth.mockResolvedValue({ id: PROBER, level: 'worker' });
  mockLease.mockClear();
  mockReport.mockClear();
});

describe('POST /api/runner/model-probe', () => {
  it('leases a model to a trusted probe account', async () => {
    const res = await LEASE(post('/api/runner/model-probe', { claudeCliVersion: '2.1.290' }));
    expect(await res.json()).toEqual({ model: 'claude-haiku-5-5', leaseId: 'lease-1' });
    expect(mockLease.mock.calls[0][1]).toBe('2.1.290');
  });

  it('any other runner gets nothing to probe, not an error', async () => {
    mockAuth.mockResolvedValue({ id: OTHER, level: 'worker' });
    const res = await LEASE(post('/api/runner/model-probe', { claudeCliVersion: '2.1.290' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ model: null });
    expect(mockLease).not.toHaveBeenCalled();
  });

  it('a broken lease path answers "nothing to probe"', async () => {
    mockLease.mockRejectedValueOnce(new Error('db down'));
    const res = await LEASE(post('/api/runner/model-probe', { claudeCliVersion: '2.1.290' }));
    expect(await res.json()).toEqual({ model: null });
  });

  it('requires a CLI version', async () => {
    const res = await LEASE(post('/api/runner/model-probe', {}));
    expect(res.status).toBe(400);
  });
});

describe('POST /api/runner/model-probe/report', () => {
  const body = { model: 'claude-haiku-5-5', leaseId: 'lease-1', cliVersion: '2.1.290', ok: true };

  it('records the result for the lease holder', async () => {
    const res = await REPORT(post('/api/runner/model-probe/report', body));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, state: 'certified' });
  });

  it('refuses a non-probe account', async () => {
    mockAuth.mockResolvedValue({ id: OTHER, level: 'worker' });
    const res = await REPORT(post('/api/runner/model-probe/report', body));
    expect(res.status).toBe(403);
    expect(mockReport).not.toHaveBeenCalled();
  });

  it('a stale lease is a 409, not a write', async () => {
    mockReport.mockResolvedValueOnce({ ok: false, reason: 'lease_mismatch' });
    const res = await REPORT(post('/api/runner/model-probe/report', body));
    expect(res.status).toBe(409);
  });
});
