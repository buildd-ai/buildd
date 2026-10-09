import { afterEach, describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

let sweepResult: Record<string, unknown> = {
  workspacesEvaluated: 0,
  windowsEvaluated: 0,
  candidates: 0,
  incidentsOpened: 0,
  incidentsUpdated: 0,
  duplicatesSuppressed: 0,
  alertsSent: 0,
  fixTasksFiled: 0,
  runFailures: 0,
  elapsedMs: 1,
  costUsd: 0,
};
const calls: unknown[] = [];
mock.module('@/lib/failure-pattern-sweep', () => ({
  productionSweepDeps: () => ({ marker: 'prod-deps' }),
  runFailurePatternSweep: async (deps: unknown, opts: unknown) => {
    calls.push({ deps, opts });
    return sweepResult;
  },
}));

const { POST } = await import('./route');
const req = (auth?: string) => new NextRequest('http://localhost/api/cron/failure-pattern-sentinel', {
  method: 'POST',
  headers: auth ? { authorization: auth } : {},
});

const saved = { ...process.env };
afterEach(() => { process.env = { ...saved }; calls.length = 0; });

describe('POST /api/cron/failure-pattern-sentinel', () => {
  it('requires CRON_SECRET', async () => {
    process.env.CRON_SECRET = 's';
    const res = await POST(req());
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('runs the sweep over every workspace (no explicit scope) and reports its counters', async () => {
    process.env.CRON_SECRET = 's';
    sweepResult = { ...sweepResult, workspacesEvaluated: 3, incidentsOpened: 1, candidates: 2 };
    const res = await POST(req('Bearer s'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.workspacesEvaluated).toBe(3);
    expect(body.incidentsOpened).toBe(1);
    expect(calls).toHaveLength(1);
    expect((calls[0] as { opts: unknown }).opts).toBeUndefined();
  });
});
