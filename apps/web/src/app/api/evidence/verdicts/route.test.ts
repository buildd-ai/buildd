import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const WS = '11111111-1111-4111-8111-111111111111';
const REV = '22222222-2222-4222-8222-222222222222';
let caller: unknown = { kind: 'user', userId: 'u1' };
let allowed = true;
const calls: unknown[][] = [];
mock.module('@/lib/specs/caller', () => ({ specCaller: async () => caller }));
mock.module('@/lib/specs/store', () => ({ reach: async () => allowed }));
mock.module('@/lib/specs/verdict-provenance', () => ({
  evidenceForCriterion: async (...a: unknown[]) => { calls.push(['forward', ...a]); return [{ verdictId: 'v1', kind: 'test', ref: 'bun test x' }]; },
  criteriaForEvidence: async (...a: unknown[]) => { calls.push(['backward', ...a]); return [{ specRevisionId: REV, criterionId: 'AC-1', verdictId: 'v1' }]; },
}));
const { GET } = await import('./route');
const get = (qs: string) => GET(new NextRequest(`http://l/api/evidence?${qs}`));

beforeEach(() => { caller = { kind: 'user', userId: 'u1' }; allowed = true; calls.length = 0; });

describe('GET /api/evidence', () => {
  it('401 without a caller', async () => {
    caller = null;
    expect((await get(`workspaceId=${WS}&kind=pr&ref=1`)).status).toBe(401);
  });

  it('400 on a missing, mixed or invalid query', async () => {
    expect((await get(`workspaceId=${WS}`)).status).toBe(400);
    expect((await get(`workspaceId=${WS}&specRevisionId=${REV}`)).status).toBe(400);
    expect((await get(`workspaceId=${WS}&specRevisionId=nope&criterionId=AC-1`)).status).toBe(400);
    expect((await get(`workspaceId=${WS}&kind=bogus&ref=1`)).status).toBe(400);
    expect((await get(`workspaceId=${WS}&kind=pr`)).status).toBe(400);
    expect((await get(`workspaceId=${WS}&kind=pr&ref=1&criterionId=AC-1`)).status).toBe(400);
  });

  it('404 when the caller cannot reach the workspace, and nothing is queried', async () => {
    allowed = false;
    expect((await get(`workspaceId=${WS}&kind=pr&ref=1`)).status).toBe(404);
    expect((await get(`workspaceId=not-a-uuid&kind=pr&ref=1`)).status).toBe(404);
    expect(calls).toEqual([]);
  });

  it('forward: the evidence for a criterion, scoped to the workspace', async () => {
    const res = await get(`workspaceId=${WS}&specRevisionId=${REV}&criterionId=AC-1`);
    expect(res.status).toBe(200);
    expect((await res.json()).evidence[0].kind).toBe('test');
    expect(calls).toEqual([['forward', WS, REV, 'AC-1']]);
  });

  it('backward: the criteria an item speaks for, scoped to the workspace', async () => {
    const res = await get(`workspaceId=${WS}&kind=pr&ref=42`);
    expect(res.status).toBe(200);
    expect((await res.json()).criteria[0].criterionId).toBe('AC-1');
    expect(calls).toEqual([['backward', WS, 'pr', '42']]);
  });
});
