import { describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

let caller: unknown = { kind: 'user', userId: 'u1' };
const seen: unknown[] = [];
// The diff and the review gate are real-Postgres tested (tests/db/spec-diff.test.ts, spec-review-speed.test.ts); here the route's mapping.
mock.module('@/lib/specs/caller', () => ({ specCaller: async () => caller }));
mock.module('@/lib/specs/diff', () => ({
  diffSpecRevisions: async (_c: unknown, _id: string, opts: unknown) => { seen.push(opts); return { ok: true, diff: { specId: 's1', identical: true } }; },
}));
mock.module('@/lib/specs/page-view', () => ({
  specReviewView: async (c: { userId?: string }) => (c.userId === 'approver'
    ? { ok: true, review: { revision: 2, replaces: 1, hunks: [], omittedLines: 0, linesAdded: 0, linesRemoved: 0, sectionCount: 0, body: 'B', version: 4 } }
    : { ok: false, status: 403, error: 'Only someone who may approve specs here can review a revision for approval.' }),
}));
const { GET } = await import('./route');
const params = Promise.resolve({ specId: 's1' });
const req = (q: string) => new NextRequest(`http://l/api/specs/s1/diff${q}`);

describe('GET /api/specs/[specId]/diff', () => {
  it('diffs two revisions as before', async () => {
    caller = { kind: 'user', userId: 'u1' };
    const res = await GET(req('?from=1&to=2'), { params });
    expect([res.status, (await res.json()).identical]).toEqual([200, true]);
    expect(seen.at(-1)).toEqual({ from: 1, to: 2 });
    expect((await GET(req('?from=0'), { params })).status).toBe(400);
  });
  it('with review=1, the review panel for an approver, and the refusal for anyone else', async () => {
    caller = { kind: 'user', userId: 'approver' };
    const res = await GET(req('?review=1'), { params });
    expect(res.status).toBe(200);
    expect((await res.json()).review).toMatchObject({ revision: 2, replaces: 1, version: 4 });
    caller = { kind: 'user', userId: 'member' };
    expect((await GET(req('?review=1'), { params })).status).toBe(403);
    caller = null;
    expect((await GET(req('?review=1'), { params })).status).toBe(401);
  });
});
