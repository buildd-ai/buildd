import { describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

let caller: unknown = { kind: 'account', account: { id: 'a' } };
mock.module('@/lib/specs/caller', () => ({ specCaller: async () => caller }));
mock.module('@/lib/specs/intent-check', () => ({
  recordIntentCheck: async (_c: unknown, _id: string, input: { findings?: unknown[] }) =>
    input.findings === undefined ? { ok: false, status: 403, error: 'not independent', code: 'checker_not_independent' } : { ok: true, questions: input.findings },
}));
const { POST } = await import('./route');
const params = Promise.resolve({ specId: 's1' });
const req = (b: unknown) => new NextRequest('http://l/api/specs/s1/intent-check', { method: 'POST', body: JSON.stringify(b) });

describe('POST /api/specs/[specId]/intent-check', () => {
  it('returns the questions a check raised', async () => {
    const res = await POST(req({ findings: [{ text: 'x' }] }), { params });
    expect([res.status, (await res.json()).questions.length]).toEqual([200, 1]);
  });
  it('passes through the 403 for a non-independent checker', async () => {
    const res = await POST(req({}), { params });
    expect([res.status, (await res.json()).code]).toEqual([403, 'checker_not_independent']);
  });
  it('401 with no caller', async () => {
    caller = null;
    expect((await POST(req({ findings: [] }), { params })).status).toBe(401);
  });
});
