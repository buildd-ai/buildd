// Asserts on the cron_runs row against a mocked db, so opt in to recording.
process.env.BUILDD_CRON_RUN_RECORD_IN_TESTS = '1';

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// The eval itself is covered in apps/web/src/lib/prompt-evals/run.test.ts; here
// the wiring: auth, one cron-triggered run per tick, and the cron_runs verdict.
let outcome: any = { status: 'skipped', reason: 'PROMPTS_REPO is not set' };
const mockRun = mock(async (_input: any, _deps: any) => outcome);
mock.module('@/lib/prompt-evals/run', () => ({ runPromptEval: mockRun }));
mock.module('@/lib/prompt-evals/store', () => ({ promptEvalDeps: () => ({}) }));

const recorded: any[] = [];
mock.module('@buildd/core/db', () => ({
  db: {
    insert: () => ({ values: (v: any) => { recorded.push(v); return { returning: async () => [{ id: 'cron-run-1' }] }; } }),
    update: () => ({ set: (v: any) => { recorded.push(v); return { where: async () => {} }; } }),
    delete: () => ({ where: () => Promise.resolve() }),
    query: { cronRuns: { findMany: async () => [] } },
  },
}));

const { GET } = await import('./route');

const SECRET = 'test-cron-secret';
const req = (token: string | null = SECRET) => new NextRequest('http://localhost:3000/api/cron/prompt-evals', {
  headers: token ? { authorization: `Bearer ${token}` } : {},
});
const verdict = () => recorded.find(r => r.changed !== undefined);

const set = (over: Record<string, unknown> = {}) => ({ set: 'task_category', status: 'scored', cases: 10, errors: 1, notRun: 0, costUsd: 0.01, ...over });

describe('GET /api/cron/prompt-evals', () => {
  beforeEach(() => {
    process.env.CRON_SECRET = SECRET;
    outcome = { status: 'skipped', reason: 'PROMPTS_REPO is not set' };
    mockRun.mockClear();
    recorded.length = 0;
  });

  it('refuses without the cron secret and runs nothing', async () => {
    expect((await GET(req('wrong'))).status).toBe(401);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('runs one cron-triggered eval and records cases scored, sets written and errors', async () => {
    outcome = { status: 'passed', runId: 'r1', evalModel: 'deepseek/deepseek-v4.1-flash', prodModel: 'typesafe/jev-1.13', modelMismatch: true, problems: [], report: { sets: [set(), set({ set: 'task_role', status: 'no_cases', cases: 0, errors: 0 })] } };
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(mockRun).toHaveBeenCalledTimes(1);
    expect(mockRun.mock.calls[0][0]).toEqual({ trigger: 'cron' });
    expect(await res.json()).toMatchObject({ ok: true, status: 'passed', runId: 'r1', modelMismatch: true });
    expect(verdict()).toMatchObject({ processed: 10, changed: 2, errors: 1 });
    expect(recorded.find(r => r.job === 'prompt-evals')).toBeDefined();
  });

  it('a failed eval counts as an error, so cron health sees it', async () => {
    outcome = { status: 'failed', runId: 'r2', evalModel: 'm', prodModel: 'm', modelMismatch: false, problems: ['no OpenRouter key resolves for the team'], report: null };
    const res = await GET(req());
    expect(await res.json()).toMatchObject({ ok: false, status: 'failed' });
    expect(verdict()).toMatchObject({ processed: 0, changed: 0, errors: 1 });
  });

  it('an unconfigured deployment is a quiet no-op', async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(verdict()).toMatchObject({ processed: 0, changed: 0, errors: 0 });
  });
});
