import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// ── mocks (before importing the route) ────────────────────────────────────────

const mockAuthenticateApiKey = mock((_key: string | null, _req?: unknown) => Promise.resolve(null as any));
const mockResolveDispatchTask = mock((_a: any, _i: any) => Promise.resolve(null as any));
const mockRecord = mock((_r: any) => Promise.resolve());
const mockWorkersFindFirst = mock((_q: any) => Promise.resolve(null as any));
const mockTasksFindFirst = mock((_q: any) => Promise.resolve(null as any));

mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@/lib/agent-capabilities/dispatch-principal', () => ({ resolveDispatchTask: mockResolveDispatchTask }));
mock.module('@/lib/agent-capabilities/audit', () => ({ recordCapabilityDecision: mockRecord }));
mock.module('@buildd/core/db', () => ({
  db: { query: { workers: { findFirst: mockWorkersFindFirst }, tasks: { findFirst: mockTasksFindFirst } } },
}));

import { POST } from './route';

// ── fixtures ──────────────────────────────────────────────────────────────────

const ACCOUNT = { id: 'account-1', teamId: 'team-1', level: 'worker' };
const DISPATCH = 'dispatch-token-value';
const WS = { id: 'ws-1' };
const COMMAND = 'git checkout -q abc && bun run test';
const CHECK_TASK = {
  context: {
    specCriterionCheck: { subjectTaskId: 's-1', specRevisionId: 'r-1', criterionId: 'C-1', headSha: 'a'.repeat(40), command: 'bun run test' },
    verificationCommand: COMMAND,
  },
  loopConfig: { exitCondition: { type: 'command', command: COMMAND }, maxLoops: 1 },
  loopIteration: 0,
};
const CRITERION_TASK = {
  context: { criteriaVerification: { missionId: 'm-1', criterionIndex: 2, command: 'bun run lint' }, verificationCommand: 'bun run lint' },
  loopConfig: { exitCondition: { type: 'command' }, maxLoops: 1 },
  loopIteration: 1,
};

function req(opts: { apiKey?: string | null; dispatch?: string | null; body?: unknown } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.apiKey !== null) headers.authorization = `Bearer ${opts.apiKey ?? 'bld_key'}`;
  if (opts.dispatch !== null) headers['x-buildd-dispatch-token'] = opts.dispatch ?? DISPATCH;
  return new NextRequest('http://localhost/api/runner/verification-run', {
    method: 'POST',
    headers,
    body: JSON.stringify(opts.body ?? { taskId: 'task-1', workerId: 'worker-1' }),
  });
}

beforeEach(() => {
  for (const m of [mockAuthenticateApiKey, mockResolveDispatchTask, mockWorkersFindFirst, mockTasksFindFirst]) m.mockReset();
  mockRecord.mockClear();
  mockAuthenticateApiKey.mockImplementation((key: string | null) => Promise.resolve(key ? ACCOUNT : null));
  mockResolveDispatchTask.mockResolvedValue({ ok: true, task: { id: 'task-1', workspaceId: 'ws-1' }, workspace: WS });
  mockWorkersFindFirst.mockResolvedValue({ id: 'worker-1', accountId: 'account-1', claimedByCloud: true });
  mockTasksFindFirst.mockResolvedValue(CHECK_TASK);
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/runner/verification-run', () => {
  it("a spec criterion check run: the loop's command, to run as the runner", async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ taskId: 'task-1', workerId: 'worker-1', workspaceId: 'ws-1', run: true, command: COMMAND, iteration: 0 });
    expect(mockResolveDispatchTask.mock.calls[0]![1]).toEqual({ taskId: 'task-1', dispatchToken: DISPATCH });
  });

  it('a mission command criterion with no command on its exit condition falls back to context.verificationCommand', async () => {
    mockTasksFindFirst.mockResolvedValue(CRITERION_TASK);
    expect(await (await POST(req())).json()).toMatchObject({ run: true, command: 'bun run lint', iteration: 1 });
  });

  it('any other task, even one with a command loop, gets no run: only verification runs take a late runner report', async () => {
    mockTasksFindFirst.mockResolvedValue({ context: { verificationCommand: 'bun run test' }, loopConfig: { exitCondition: { type: 'command', command: 'bun run test' } }, loopIteration: 0 });
    expect(await (await POST(req())).json()).toEqual({ taskId: 'task-1', workerId: 'worker-1', run: false, reason: 'not_a_verification_run' });
  });

  it("a mission's criterion batch: the head and every criterion's command with its own limit", async () => {
    const SHA = 'b'.repeat(40);
    const checks = [{ criterionId: 'AC-1', command: 'bun run a', timeoutMs: 180_000 }, { criterionId: 'AC-2', command: 'bun run b', timeoutMs: 600_000 }];
    mockTasksFindFirst.mockResolvedValue({
      context: { specCriterionBatch: { subjectTaskId: 's-1', missionId: 'm-1', specRevisionId: 'r-1', headSha: SHA, commandSet: 'set', checks } },
      loopConfig: null, loopIteration: 0,
    });
    expect(await (await POST(req())).json()).toEqual({ taskId: 'task-1', workerId: 'worker-1', workspaceId: 'ws-1', run: true, kind: 'criterion_batch', headSha: SHA, checks, iteration: 0 });
  });

  it('a verification run with no resolvable command gets no run', async () => {
    mockTasksFindFirst.mockResolvedValue({ ...CRITERION_TASK, context: { criteriaVerification: CRITERION_TASK.context.criteriaVerification } });
    expect(await (await POST(req())).json()).toMatchObject({ run: false, reason: 'no_command' });
  });

  describe('refusals', () => {
    it('no runner key: 401', async () => {
      expect((await POST(req({ apiKey: null }))).status).toBe(401);
      expect(mockResolveDispatchTask).not.toHaveBeenCalled();
    });

    it('a task token, the credential the container holds: 403', async () => {
      mockAuthenticateApiKey.mockResolvedValue({ ...ACCOUNT, taskScope: { taskId: 'task-1' } });
      expect((await POST(req())).status).toBe(403);
      expect(mockResolveDispatchTask).not.toHaveBeenCalled();
    });

    it('a trigger key: 403', async () => {
      mockAuthenticateApiKey.mockResolvedValue({ ...ACCOUNT, level: 'trigger' });
      expect((await POST(req())).status).toBe(403);
    });

    it('no dispatch token: 401', async () => {
      expect((await POST(req({ dispatch: null }))).status).toBe(401);
      expect(mockResolveDispatchTask).not.toHaveBeenCalled();
    });

    it.each([[{}], [{ taskId: 'task-1' }], [{ taskId: '../x', workerId: 'worker-1' }], [{ taskId: 'task-1', workerId: 7 }]])('bad body %p: 400', async (body) => {
      expect((await POST(req({ body }))).status).toBe(400);
    });

    it("the principal check's refusal passes through, and is audited", async () => {
      mockResolveDispatchTask.mockResolvedValue({ ok: false, status: 403, error: 'Dispatch token does not match this workspace', reasonCode: 'dispatch_token_mismatch' });
      expect((await POST(req())).status).toBe(403);
      expect(mockRecord.mock.calls[0]![0]).toMatchObject({ capability: 'runner.verification_run', decision: 'refused', reasonCode: 'dispatch_token_mismatch' });
    });

    it.each([
      ['missing', null],
      ["another account's", { id: 'worker-1', accountId: 'account-2', claimedByCloud: true }],
      ['host-claimed', { id: 'worker-1', accountId: 'account-1', claimedByCloud: false }],
    ])('a %s worker: 404', async (_label, worker) => {
      mockWorkersFindFirst.mockResolvedValue(worker);
      expect((await POST(req())).status).toBe(404);
      expect(mockTasksFindFirst).not.toHaveBeenCalled();
    });
  });
});
