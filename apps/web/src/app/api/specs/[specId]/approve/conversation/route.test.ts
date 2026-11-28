import { describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

let caller: unknown = { kind: 'user', userId: 'owner' };
let withAuthHeader = false;
mock.module('@/lib/specs/caller', () => ({
  dashboardCaller: async () => (withAuthHeader ? { ok: false, status: 403, error: 'confirm on buildd.dev' }
    : caller === null ? { ok: false, status: 401, error: 'Unauthorized' } : { ok: true, caller }),
}));
const seen: unknown[] = [];
mock.module('@/lib/specs/approval', () => ({
  approveFromConversation: async (_c: unknown, _id: string, input: Record<string, unknown>) => {
    seen.push(input);
    if (input.messageId === 'theirs') return { ok: false, status: 403, error: 'not yours', code: 'message_not_yours' };
    if (input.expectedVersion !== 3) return { ok: false, status: 409, error: 'stale', code: 'stale', currentVersion: 3 };
    return { ok: true, already: false, spec: { id: 's1', approvedRevision: input.revision }, revision: { revision: input.revision }, retirements: [] };
  },
}));
const { POST } = await import('./route');
const params = Promise.resolve({ specId: 's1' });
const req = (body: unknown) => new NextRequest('http://l/api/specs/s1/approve/conversation', { method: 'POST', body: JSON.stringify(body) });
const good = { revision: 2, expectedVersion: 3, conversationId: 'c1', messageId: 'm1' };

describe('POST /api/specs/[specId]/approve/conversation', () => {
  it('approves from the owner\'s own message and passes the link through', async () => {
    const res = await POST(req({ ...good, criterionSources: { 'R-1': 'msg' } }), { params });
    expect([res.status, (await res.json()).spec.approvedRevision]).toEqual([200, 2]);
    expect(seen.at(-1)).toMatchObject({ conversationId: 'c1', messageId: 'm1', criterionSources: { 'R-1': 'msg' } });
  });
  it('refuses an agent/task/API token with a forged ref (any Authorization header) before reading the body', async () => {
    withAuthHeader = true;
    const before = seen.length;
    const res = await POST(req(good), { params });
    expect(res.status).toBe(403);
    expect(seen.length).toBe(before);
    withAuthHeader = false;
  });
  it('refuses a message someone else authored', async () => {
    const res = await POST(req({ ...good, messageId: 'theirs' }), { params });
    expect([res.status, (await res.json()).code]).toEqual([403, 'message_not_yours']);
  });
  it('refuses a stale revision with the current version', async () => {
    const res = await POST(req({ ...good, expectedVersion: 1 }), { params });
    expect([res.status, (await res.json()).currentVersion]).toEqual([409, 3]);
  });
  it('401 with no session', async () => {
    caller = null;
    expect((await POST(req(good), { params })).status).toBe(401);
    caller = { kind: 'user', userId: 'owner' };
  });
});
