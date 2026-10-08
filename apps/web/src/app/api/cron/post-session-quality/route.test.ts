import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// The loop is covered in apps/web/src/lib/post-session-*.test.ts; here the
// wiring: auth, the readout in the response, and a loop that never throws.
let readout: Record<string, unknown> = {};
const mockLoop = mock(async (_opts?: unknown) => readout);
mock.module('@/lib/post-session-loop', () => ({ runPostSessionQualityLoop: mockLoop, POST_SESSION_LOOP_BUDGET_MS: 40_000 }));

const { GET } = await import('./route');

const SECRET = 'test-cron-secret';
const req = (token: string | null = SECRET) => new NextRequest('http://localhost:3000/api/cron/post-session-quality', {
  headers: token ? { authorization: `Bearer ${token}` } : {},
});

describe('GET /api/cron/post-session-quality', () => {
  beforeEach(() => {
    process.env.CRON_SECRET = SECRET;
    mockLoop.mockClear();
    readout = {
      enabled: true,
      policyVersion: 'psq-v1',
      evaluated: 3,
      triaged: 3,
      hardTriggered: 1,
      selectedForAnalysis: 2,
      analysed: 2,
      actionable: 1,
      tasksCreated: 1,
      proposalsCreated: 0,
      wouldAct: 0,
      duplicatesSuppressed: 0,
      deferred: 0,
      stageFailures: { collect: 0, triage: 0, transcript: 1, analyse: 0, act: 0 },
      stageCost: { triage: { calls: 3, usd: 0.0003, inputTokens: 300, outputTokens: 9 }, analyse: { calls: 0, usd: 0 } },
      stageErrors: [],
    };
  });

  it('rejects a request without the cron secret and runs nothing', async () => {
    expect((await GET(req(null))).status).toBe(401);
    expect((await GET(req('wrong'))).status).toBe(401);
    expect(mockLoop).not.toHaveBeenCalled();
  });

  it('runs the loop once and returns its readout', async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(mockLoop).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, readout: { evaluated: 3, analysed: 2, tasksCreated: 1 } });
  });

  it('passes a time budget inside the route limit', async () => {
    await GET(req());
    const opts = mockLoop.mock.calls[0][0] as { budgetMs: number };
    expect(opts.budgetMs).toBeGreaterThan(0);
    expect(opts.budgetMs).toBeLessThan(60_000);
  });
});
