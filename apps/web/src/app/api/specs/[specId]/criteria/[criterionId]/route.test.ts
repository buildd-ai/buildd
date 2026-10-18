import { describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

let caller: unknown = { kind: 'user', userId: 'u1' };
const seen: unknown[] = [];
// The history itself is real-Postgres tested (tests/db/spec-criteria-records.test.ts); here the route's mapping.
mock.module('@/lib/specs/caller', () => ({ specCaller: async () => caller }));
mock.module('@/lib/specs/revision-changes', () => ({
  specCriterionHistory: async (_c: unknown, specId: string, id: string) => {
    seen.push([specId, id]);
    return id === 'R-26'
      ? { ok: true, history: { criterionId: 'R-26', entries: [{ revision: 6 }, { revision: 12 }], replaces: [], retiredIn: null, replacedBy: null, head: 12 } }
      : { ok: false, status: 404, error: `This spec has never had ${id}` };
  },
}));
const { GET } = await import('./route');
const req = () => new NextRequest('http://l/api/specs/s1/criteria/x');

describe('GET /api/specs/[specId]/criteria/[criterionId]', () => {
  it('returns the history, reading the id in any case', async () => {
    const res = await GET(req(), { params: Promise.resolve({ specId: 's1', criterionId: 'r-26' }) });
    expect(res.status).toBe(200);
    expect((await res.json()).history.entries).toHaveLength(2);
    expect(seen.at(-1)).toEqual(['s1', 'R-26']);
  });
  it('passes a refusal through, and needs a caller', async () => {
    expect((await GET(req(), { params: Promise.resolve({ specId: 's1', criterionId: 'R-99' }) })).status).toBe(404);
    caller = null;
    expect((await GET(req(), { params: Promise.resolve({ specId: 's1', criterionId: 'R-26' }) })).status).toBe(401);
  });
});
