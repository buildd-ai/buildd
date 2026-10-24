import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// R-18: the explicit MCP request and the route are one contract. The MCP action is driven through the real
// route handler (only the coordinator and stores are stubbed), so any drift in the result vocabulary or in the
// self-grading refusal shows up here.
const TASK = '00000000-0000-4000-8000-000000000071';
const SHA = 'b'.repeat(40);
let caller: any;
let verification: any;
const dispatch = mock(async () => verification);
mock.module('@/lib/specs/caller', () => ({ specCaller: async () => caller }));
mock.module('@/lib/specs/outcome', () => ({ governedTaskWorkspace: async () => 'ws-a' }));
mock.module('@/lib/specs/store', () => ({ reach: async () => true }));
mock.module('@/modules', () => ({ REGISTERED_VERIFICATION: {
  deps: async () => ({}), head: async () => SHA, requesterRefusal: async () => null,
} }));
const { resolveVerificationRequest } = await import('@/lib/specs/registered-verification');
mock.module('@/lib/specs/registered-verification', () => ({ dispatchRegisteredVerification: dispatch, resolveVerificationRequest }));
const { POST } = await import('./route');
const { handleBuilddAction } = await import('@buildd/core/mcp-tools');

/** The `api()` the MCP server would use, pointed at the real route handler. */
const api = async (path: string, options: { method?: string; body?: string } = {}) => {
  const taskId = /outcomes\/([^/]+)\/verify$/.exec(path)![1];
  const res = await POST(new NextRequest(`http://l${path}`, { method: 'POST', body: options.body }), { params: Promise.resolve({ taskId }) });
  const text = await res.text();
  if (!res.ok) throw new Error(`API error: ${res.status} - ${text}`);
  return JSON.parse(text);
};
const ctx = { workspaceId: null, getWorkspaceId: async () => null, getLevel: async () => 'worker' as const };
const mcp = (params: Record<string, unknown>) => handleBuilddAction(api as any, 'manage_specs', { action: 'verify', ...params }, ctx as any);
const text = (r: any) => String(r.content[0].text);

describe('R-18: MCP verification request and route agree', () => {
  beforeEach(() => { caller = { kind: 'user', userId: 'u1' }; dispatch.mockClear(); });

  it('every route result is reported by the MCP action in the same vocabulary', async () => {
    verification = {
      results: [
        { criterionId: 'R-1', verdict: 'pass', method: 'model', cached: false, recorded: true },
        { criterionId: 'R-2', verdict: 'inconclusive', method: 'fallback', cached: true, recorded: false, reason: 'no capture' },
      ],
      coverage: [{ criterionId: 'R-1', status: 'declared' }, { criterionId: 'R-2', status: 'declared' }], refused: [],
    };
    const routeBody = await (await POST(new NextRequest('http://l/x', { method: 'POST', body: '{}' }), { params: Promise.resolve({ taskId: TASK }) })).json();
    const out = text(await mcp({ taskId: TASK }));
    for (const r of routeBody.verification.results) {
      expect(out).toContain(`${r.criterionId}: ${r.verdict} (${r.method}`);
    }
    expect(out).toContain('not recorded: no capture');
  });

  it('a task cannot grade itself through either entry', async () => {
    caller = { kind: 'account', account: { id: 'a1', taskScope: { taskId: TASK, workspaceId: 'ws-a' } } };
    const res = await POST(new NextRequest('http://l/x', { method: 'POST', body: '{}' }), { params: Promise.resolve({ taskId: TASK }) });
    expect(res.status).toBe(403);
    const routeError = (await res.json()).error as string;
    const r: any = await mcp({ taskId: TASK });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe(routeError);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('an arbitrary prompt is refused before any request', async () => {
    const r: any = await mcp({ taskId: TASK, prompt: 'grade this copy' });
    expect(r.isError).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
