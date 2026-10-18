import { describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

let caller: unknown = { kind: 'user', userId: 'u1' };
mock.module('@/lib/specs/caller', () => ({ specCaller: async () => caller }));
let missing = false;
let readOptions: unknown;
mock.module('@/lib/specs/store', () => ({
  getSpec: async (_c: unknown, _id: string, o: { revision?: number }) => (readOptions = o, missing ? { ok: false, status: 404, error: 'Spec not found' } : { ok: true, view: { revision: { revision: o.revision ?? 2 } } }),
  reviseSpecDraft: async () => ({ ok: false, status: 409, error: 'changed', currentVersion: 3 }),
}));
const sectionCalls: unknown[] = [];
mock.module('@/lib/specs/section-revise', () => ({
  reviseSpecSection: async (_c: unknown, _id: string, input: unknown) => {
    sectionCalls.push(input);
    return { ok: true, spec: { version: 2 }, revision: { revision: 2 }, unchanged: false };
  },
}));
let short: unknown = { state: 'none' };
mock.module('@/lib/specs/short-id', () => ({ SHORT_ID: /^[0-9a-f]{8}$/, resolveSpecShortId: async () => short }));
const notFoundFor: string[] = [];
mock.module('@/lib/specs/copy', () => ({
  specNotFound: async (_c: unknown, id: string) => {
    notFoundFor.push(id);
    return { ok: false, status: 404, error: `Spec ${id} is not readable from here, but it was copied: c1`, code: 'spec_copied' };
  },
}));
const { GET, PATCH } = await import('./route');
const params = Promise.resolve({ specId: 's1' });

describe('/api/specs/[specId]', () => {
  it('passes bounded revision history options and rejects invalid cursors', async () => {
    await GET(new NextRequest('http://l/api/specs/s1?revisionsLimit=5&revisionsBefore=12'), { params });
    expect(readOptions).toMatchObject({ revisionsLimit: 5, revisionsBefore: 12 });
    expect((await GET(new NextRequest('http://l/api/specs/s1?revisionsBefore=no'), { params })).status).toBe(400);
  });
  it('a stale revise answers 409 version_conflict with the current version', async () => {
    const res = await PATCH(new NextRequest('http://l/api/specs/s1', { method: 'PATCH', body: JSON.stringify({ expectedVersion: 1, body: 'x' }) }), { params });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'version_conflict', currentVersion: 3 });
  });
  it('a revise naming a section or heading goes to the section revise; one without goes to the full-body one', async () => {
    const send = (b: object) => PATCH(new NextRequest('http://l/api/specs/s1', { method: 'PATCH', body: JSON.stringify(b) }), { params });
    expect((await send({ expectedVersion: 1, section: 's2', body: '## A\n' })).status).toBe(200);
    expect((await send({ expectedVersion: 1, heading: 'A', body: '## A\n' })).status).toBe(200);
    expect(sectionCalls).toEqual([{ expectedVersion: 1, section: 's2', body: '## A\n' }, { expectedVersion: 1, heading: 'A', body: '## A\n' }]);
    expect((await send({ expectedVersion: 1, body: 'x' })).status).toBe(409);
    expect(sectionCalls).toHaveLength(2);
  });
  it('a successful revise carries formatHints for the text sent (R-48), and writes it as sent', async () => {
    const body = '## Flow\n1. Open\n2. Pick\n3. Pay\n';
    const res = await PATCH(new NextRequest('http://l/api/specs/s1', { method: 'PATCH', body: JSON.stringify({ expectedVersion: 1, heading: 'Flow', body }) }), { params });
    expect(res.status).toBe(200);
    expect((await res.json()).formatHints.map((h: { kind: string }) => h.kind)).toEqual(['diagram']);
    expect(sectionCalls.at(-1)).toEqual({ expectedVersion: 1, heading: 'Flow', body });
  });
  it('GET passes revision through and refuses a malformed one; no caller is 401', async () => {
    expect((await (await GET(new NextRequest('http://l/api/specs/s1?revision=1'), { params })).json()).revision.revision).toBe(1);
    expect((await GET(new NextRequest('http://l/api/specs/s1?revision=0'), { params })).status).toBe(400);
    caller = null;
    expect((await GET(new NextRequest('http://l/api/specs/s1'), { params })).status).toBe(401);
  });

  it('GET resolves an 8-hex short id; several matches are a 409 listing full ids', async () => {
    caller = { kind: 'user', userId: 'u1' };
    short = { state: 'one', id: 'full-id' };
    const ok = await GET(new NextRequest('http://l/api/specs/abcdef12'), { params: Promise.resolve({ specId: 'abcdef12' }) });
    expect(ok.status).toBe(200);
    short = { state: 'many', specs: [{ id: 'a', title: 'A', workspaceName: 'w' }, { id: 'b', title: 'B', workspaceName: 'w' }] };
    const res = await GET(new NextRequest('http://l/api/specs/abcdef12'), { params: Promise.resolve({ specId: 'abcdef12' }) });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'ambiguous_short_id', specs: [{ id: 'a' }, { id: 'b' }] });
  });

  it('GET of a spec the caller cannot read answers through specNotFound: the copy it can read, or how to make one', async () => {
    caller = { kind: 'user', userId: 'u1' };
    short = { state: 'none' };
    missing = true;
    const res = await GET(new NextRequest('http://l/api/specs/65664148'), { params: Promise.resolve({ specId: '65664148' }) });
    missing = false;
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'spec_copied' });
    expect(notFoundFor).toEqual(['65664148']);
  });
});
