import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// ── mocks (before importing the route) ────────────────────────────────────────

const mockAuthenticateApiKey = mock((_key: string | null, _req?: unknown) => Promise.resolve(null as any));
const mockResolveDispatchTask = mock((_a: any, _i: any) => Promise.resolve(null as any));
const mockResolveWorkspaceRunnerSize = mock((_ws: any, _o: any) => Promise.resolve(null as any));
const mockRunnerSizeOfWorker = mock((_ws: string, _w: string) => Promise.resolve(null as any));
const mockRecord = mock((_r: any) => Promise.resolve());

mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@/lib/agent-capabilities/dispatch-principal', () => ({ resolveDispatchTask: mockResolveDispatchTask }));
mock.module('@/lib/agent-capabilities/audit', () => ({ recordCapabilityDecision: mockRecord }));
mock.module('@/lib/runner-size-store', () => ({
  resolveWorkspaceRunnerSize: mockResolveWorkspaceRunnerSize,
  runnerSizeOfWorker: mockRunnerSizeOfWorker,
}));

import { POST } from './route';

// ── fixtures ──────────────────────────────────────────────────────────────────

const ACCOUNT = { id: 'account-1', teamId: 'team-1', level: 'worker' };
const DISPATCH = 'dispatch-token-value';
const WS = { id: 'ws-1', gitConfig: { runnerSize: 'large' } };

function req(opts: { apiKey?: string | null; dispatch?: string | null; body?: unknown } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.apiKey !== null) headers.authorization = `Bearer ${opts.apiKey ?? 'bld_key'}`;
  if (opts.dispatch !== null) headers['x-buildd-dispatch-token'] = opts.dispatch ?? DISPATCH;
  return new NextRequest('http://localhost/api/runner/runner-size', {
    method: 'POST',
    headers,
    body: JSON.stringify(opts.body ?? { taskId: 'task-1' }),
  });
}

beforeEach(() => {
  for (const m of [mockAuthenticateApiKey, mockResolveDispatchTask, mockResolveWorkspaceRunnerSize, mockRunnerSizeOfWorker]) m.mockReset();
  mockRecord.mockClear();
  mockAuthenticateApiKey.mockImplementation((key: string | null) => Promise.resolve(key ? ACCOUNT : null));
  mockResolveDispatchTask.mockResolvedValue({ ok: true, task: { id: 'task-1', workspaceId: 'ws-1' }, workspace: WS });
  mockResolveWorkspaceRunnerSize.mockResolvedValue({ size: 'large', source: 'derived', reason: 'memory_pressure' });
  mockRunnerSizeOfWorker.mockResolvedValue(null);
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/runner/runner-size', () => {
  it("answers the workspace's effective size and why, never cached", async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ taskId: 'task-1', workspaceId: 'ws-1', runnerSize: 'large', source: 'derived', reason: 'memory_pressure' });
    // Resolved server-side from the workspace row the dispatch token matched, and a fresh derivation is stored.
    expect(mockResolveWorkspaceRunnerSize).toHaveBeenCalledWith(WS, { persist: true });
    expect(mockResolveDispatchTask.mock.calls[0]![1]).toEqual({ taskId: 'task-1', dispatchToken: DISPATCH });
  });

  it('a default (standard) answer', async () => {
    mockResolveWorkspaceRunnerSize.mockResolvedValue({ size: 'standard', source: 'default', reason: null });
    expect(await (await POST(req())).json()).toEqual({ taskId: 'task-1', workspaceId: 'ws-1', runnerSize: 'standard', source: 'default', reason: null });
  });

  it("a resume is pinned to the class the worker's parked attempt ran in", async () => {
    mockRunnerSizeOfWorker.mockResolvedValue('standard');
    const body = await (await POST(req({ body: { taskId: 'task-1', workerId: 'worker-1' } }))).json();
    expect(body).toEqual({ taskId: 'task-1', workspaceId: 'ws-1', runnerSize: 'standard', source: 'pinned', reason: null });
    expect(mockRunnerSizeOfWorker).toHaveBeenCalledWith('ws-1', 'worker-1');
    expect(mockResolveWorkspaceRunnerSize).not.toHaveBeenCalled();
  });

  it('a worker with no run report falls back to the workspace size', async () => {
    const body = await (await POST(req({ body: { taskId: 'task-1', workerId: 'worker-1' } }))).json();
    expect(body.runnerSize).toBe('large');
    expect(body.source).toBe('derived');
  });

  describe('refusals', () => {
    it('no runner key: 401', async () => {
      expect((await POST(req({ apiKey: null }))).status).toBe(401);
      expect(mockResolveDispatchTask).not.toHaveBeenCalled();
    });

    it('a trigger key: 403', async () => {
      mockAuthenticateApiKey.mockResolvedValue({ ...ACCOUNT, level: 'trigger' });
      expect((await POST(req())).status).toBe(403);
    });

    it('no dispatch token (what the container would send): 401', async () => {
      expect((await POST(req({ dispatch: null }))).status).toBe(401);
      expect(mockResolveDispatchTask).not.toHaveBeenCalled();
    });

    it.each([[{}], [{ taskId: '../x' }], [{ taskId: 'task-1', workerId: 7 }]])('bad body %p: 400', async (body) => {
      expect((await POST(req({ body }))).status).toBe(400);
    });

    it("the principal check's refusal passes through, and is audited", async () => {
      mockResolveDispatchTask.mockResolvedValue({ ok: false, status: 403, error: 'Dispatch token does not match this workspace', reasonCode: 'dispatch_token_mismatch' });
      const res = await POST(req());
      expect(res.status).toBe(403);
      expect(mockResolveWorkspaceRunnerSize).not.toHaveBeenCalled();
      expect(mockRecord.mock.calls[0]![0]).toMatchObject({ capability: 'runner.size', decision: 'refused', reasonCode: 'dispatch_token_mismatch' });
    });
  });
});
