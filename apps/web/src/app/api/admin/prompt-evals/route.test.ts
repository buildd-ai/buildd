import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockAuthenticateApiKey = mock(() => null as any);
mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mockAuthenticateApiKey,
  hashApiKey: (key: string) => `hashed_${key}`,
  extractApiKeyPrefix: (key: string) => key.substring(0, 12),
}));

let outcome: any = { status: 'passed', runId: 'r1', evalModel: 'e', prodModel: 'p', modelMismatch: true, problems: [], report: { sets: [{ set: 'task_category', cases: 2 }] } };
const mockRun = mock(async (_input: any, _deps: any) => outcome);
mock.module('@/lib/prompt-evals/run', () => ({ runPromptEval: mockRun }));
const mockList = mock(async (_limit: number) => [{ id: 'r1', modelMismatch: true, results: [] }]);
mock.module('@/lib/prompt-evals/store', () => ({ promptEvalDeps: () => ({}), listPromptEvalRuns: mockList }));

const { GET, POST } = await import('./route');

const ADMIN = { id: 'acc-admin', level: 'admin', teamId: 'team-admin' };
const req = (method: 'GET' | 'POST', opts: { body?: unknown; query?: string } = {}) =>
  new NextRequest(`http://localhost:3000/api/admin/prompt-evals${opts.query ?? ''}`, {
    method,
    headers: new Headers({ 'content-type': 'application/json', authorization: 'Bearer bld_test' }),
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });

describe('/api/admin/prompt-evals', () => {
  beforeEach(() => {
    process.env.BUILDD_PLATFORM_ADMIN_ACCOUNT_IDS = 'acc-admin';
    mockAuthenticateApiKey.mockReset();
    mockAuthenticateApiKey.mockResolvedValue(ADMIN);
    mockRun.mockClear();
    mockList.mockClear();
    outcome = { status: 'passed', runId: 'r1', evalModel: 'e', prodModel: 'p', modelMismatch: true, problems: [], report: { sets: [{ set: 'task_category', cases: 2 }] } };
  });

  it('refuses a team-admin key that is not a platform admin', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc-other', level: 'admin', teamId: 't' });
    expect((await GET(req('GET'))).status).toBe(403);
    expect((await POST(req('POST'))).status).toBe(403);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('lists recent runs, clamping the limit', async () => {
    const res = await GET(req('GET', { query: '?limit=500' }));
    expect(res.status).toBe(200);
    expect(mockList).toHaveBeenCalledWith(50);
    expect((await res.json()).runs).toHaveLength(1);
  });

  it('runs a manual eval paid by the caller team, with ref, model and dry run', async () => {
    const res = await POST(req('POST', { body: { ref: 'abc123', model: 'deepseek/deepseek-v4-pro', dryRun: true } }));
    expect(res.status).toBe(200);
    expect(mockRun.mock.calls[0][0]).toEqual({ trigger: 'manual', teamId: 'team-admin', ref: 'abc123', model: 'deepseek/deepseek-v4-pro', dryRun: true });
    const body = await res.json();
    expect(body).toMatchObject({ status: 'passed', runId: 'r1', modelMismatch: true, sets: [{ set: 'task_category' }] });
    expect(body.report).toBeUndefined();
  });

  it('rejects a malformed ref or model before running anything', async () => {
    expect((await POST(req('POST', { body: { ref: 'a b' } }))).status).toBe(400);
    expect((await POST(req('POST', { body: { model: '../x y' } }))).status).toBe(400);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('a failed run is a 422 carrying its problems; a skipped one a 409', async () => {
    outcome = { status: 'failed', runId: 'r2', evalModel: 'e', prodModel: 'p', modelMismatch: false, problems: ['x'], report: null };
    const failed = await POST(req('POST'));
    expect(failed.status).toBe(422);
    expect((await failed.json()).problems).toEqual(['x']);
    outcome = { status: 'skipped', reason: 'another prompt eval is running' };
    expect((await POST(req('POST'))).status).toBe(409);
  });
});
