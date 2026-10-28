import { describe, it, expect, mock, beforeEach } from 'bun:test';

const MISSION = '11111111-1111-4111-8111-111111111111';
let user: { id: string } | null = { id: 'u1' };
let account: unknown = null;
let mission: { workspaceId: string } | null = { workspaceId: 'w1' };
let writable = true;
let reverify: unknown = { ok: true, taskId: 't1', headSha: 'a'.repeat(40), state: 'queued', filed: true };
const reverifyCalls: unknown[][] = [];

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: async () => user }));
mock.module('@/lib/task-token-auth', () => ({ authenticateTaskScopedCaller: async () => account, taskScopeAllowsMission: async () => true }));
mock.module('@/lib/specs/store', () => ({ reach: async (_c: unknown, _w: string, write: boolean) => (write ? writable : true) }));
mock.module('@/lib/specs/mission-outcome', () => ({ loadMission: async () => mission }));
mock.module('@/lib/specs/mission-reverify', () => ({ reverifyMission: async (...a: unknown[]) => { reverifyCalls.push(a); return reverify; } }));

const { POST } = await import('./route');
const call = (id = MISSION, body: unknown = {}) =>
  POST(new Request('http://localhost/x', { method: 'POST', body: JSON.stringify(body) }) as never, { params: Promise.resolve({ id }) });

beforeEach(() => {
  user = { id: 'u1' }; account = null; mission = { workspaceId: 'w1' }; writable = true; reverifyCalls.length = 0;
  reverify = { ok: true, taskId: 't1', headSha: 'a'.repeat(40), state: 'queued', filed: true };
});

describe('POST /api/missions/[id]/verify', () => {
  it('files the run and answers its task id', async () => {
    const res = await call(MISSION, { specId: 's1' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ taskId: 't1', headSha: 'a'.repeat(40), state: 'queued', filed: true });
    expect(reverifyCalls[0]).toEqual([MISSION, { specId: 's1' }]);
  });
  it('answers the run already in flight without filing another (filed: false)', async () => {
    reverify = { ok: true, taskId: 't0', headSha: 'b'.repeat(40), state: 'running', filed: false };
    const body = await (await call()).json();
    expect(body).toMatchObject({ taskId: 't0', state: 'running', filed: false });
  });
  it('401 without a session or key', async () => { user = null; expect((await call()).status).toBe(401); });
  it('404 for a mission the caller cannot see, 403 without write access', async () => {
    mission = null; expect((await call()).status).toBe(404);
    mission = { workspaceId: 'w1' }; writable = false; expect((await call()).status).toBe(403);
    expect(reverifyCalls).toHaveLength(0);
  });
  it('carries the refusal status through', async () => {
    reverify = { ok: false, status: 409, error: 'No integrated target to verify against yet' };
    const res = await call();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('No integrated target');
  });
  it('404 for a non-UUID id', async () => { expect((await call('nope')).status).toBe(404); });
});
