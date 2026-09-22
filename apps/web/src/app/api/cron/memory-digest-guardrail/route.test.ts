import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// The cohort query (`guardrailWindowScope`) is scope-tested against rendered
// SQL in packages/core/__tests__/memory-digest-readout-source.test.ts, and the
// arithmetic (`evaluateMemoryDigestGuardrail`) is unit-tested against literal
// rows in packages/core/__tests__/memory-digest-guardrail-monitor.test.ts. This
// file is about the trigger: auth, and that an alarming verdict actually pages
// while a quiet one does not.

mock.module('@buildd/core/db', () => ({
  db: {
    insert: () => ({ values: () => ({ returning: async () => [{ id: 'run-1' }] }) }),
    delete: () => ({ where: async () => {} }),
    query: { cronRuns: { findMany: async () => [] } },
  },
}));

mock.module('drizzle-orm', () => ({
  // Operators withCronRun imports. mock.module is process-global, so a
  // partial stub removes them for every other importer too.
  desc: (a: any) => ({ a, op: 'desc' }),
  gt: (a: any, b: any) => ({ a, b, op: 'gt' }),
  eq: (f: any, v: any) => ({ f, v, type: 'eq' }),
  and: (...c: any[]) => ({ c, type: 'and' }),
  lt: (f: any, v: any) => ({ f, v, type: 'lt' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  cronRuns: { id: 'id', job: 'job', startedAt: 'startedAt', alertedAt: 'alertedAt' },
}));

let windowInput: { composition: any[]; sessions: any[] } = { composition: [], sessions: [] };
const mockLoadGuardrailWindowInput = mock(async (_opts: any) => windowInput);
mock.module('@buildd/core/memory-digest-readout-source', () => ({
  loadGuardrailWindowInput: mockLoadGuardrailWindowInput,
}));

mock.module('@buildd/core/memory-digest-readout', () => ({
  READOUT_POLICY_VERSION: 'memory-digest-v4',
}));

let verdict: any;
const mockEvaluate = mock((_input: any) => verdict);
mock.module('@buildd/core/memory-digest-guardrail-monitor', () => ({
  evaluateMemoryDigestGuardrail: mockEvaluate,
}));

const mockReportOps = mock(async (_input: any) => true);
mock.module('@buildd/core/report-ops', () => ({
  reportOps: mockReportOps,
}));

const { POST } = await import('./route');

const CRON_SECRET = 'test-cron-secret';

function makeRequest(token: string | null = CRON_SECRET): NextRequest {
  return new NextRequest('http://localhost/api/cron/memory-digest-guardrail', {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

function quietVerdict(over: Partial<any> = {}) {
  return {
    windowDays: 7,
    windowStart: '2026-09-15T00:00:00.000Z',
    windowEnd: '2026-09-22T00:00:00.000Z',
    backend: 'claude',
    n: 200,
    failed: 48,
    rate: 0.24,
    sessionless: 0,
    baseline: { failures: 83, n: 345, rate: 83 / 345 },
    diff: { value: 0.001, ciLow: -0.05, ciHigh: 0.05 },
    alarm: false,
    reason: 'within noise of the ship baseline',
    ...over,
  };
}

beforeEach(() => {
  process.env.CRON_SECRET = CRON_SECRET;
  windowInput = { composition: [], sessions: [] };
  verdict = quietVerdict();
  mockLoadGuardrailWindowInput.mockClear();
  mockEvaluate.mockClear();
  mockReportOps.mockClear();
});

describe('POST /api/cron/memory-digest-guardrail', () => {
  it('rejects a request with no bearer token', async () => {
    const res = await POST(makeRequest(null));
    expect(res.status).toBe(401);
    expect(mockEvaluate).not.toHaveBeenCalled();
  });

  it('rejects a mismatched token', async () => {
    const res = await POST(makeRequest('wrong-token'));
    expect(res.status).toBe(401);
  });

  it('stays quiet and does not call reportOps when the verdict does not alarm', async () => {
    verdict = quietVerdict({ alarm: false });
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.verdict.alarm).toBe(false);
    expect(mockReportOps).not.toHaveBeenCalled();
  });

  it('pages via reportOps exactly once when the verdict alarms', async () => {
    verdict = quietVerdict({
      alarm: true,
      reason: 'rolling failure rate 45.0% (90/200) is credibly worse than the 24.1% (83/345) accepted at ship',
      diff: { value: 0.21, ciLow: 0.12, ciHigh: 0.30 },
    });
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    expect(mockReportOps).toHaveBeenCalledTimes(1);
    const call = mockReportOps.mock.calls[0][0];
    expect(call.dedupeKey).toBe('memory-digest-guardrail');
    expect(call.severity).toBe('error');
    expect(call.message).toContain('credibly worse');
  });

  it('reports a shipped-arm task with no session as excluded, never silently as a pass', async () => {
    verdict = quietVerdict({ alarm: true, sessionless: 7 });
    await POST(makeRequest());
    const call = mockReportOps.mock.calls[0][0];
    expect(call.detail).toContain('7 shipped-arm task(s)');
  });

  it('loads the shipped-arm window and passes it straight to the evaluator', async () => {
    windowInput = { composition: [{ taskId: 't1' }], sessions: [{ taskId: 't1', status: 'completed' }] };
    await POST(makeRequest());
    expect(mockLoadGuardrailWindowInput).toHaveBeenCalledTimes(1);
    const evalArgs = mockEvaluate.mock.calls[0][0];
    expect(evalArgs.composition).toEqual(windowInput.composition);
    expect(evalArgs.sessions).toEqual(windowInput.sessions);
  });
});
