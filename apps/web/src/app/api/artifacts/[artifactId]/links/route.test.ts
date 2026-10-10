import { describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

let caller: unknown = { kind: 'user', userId: 'u1' };
const calls: unknown[][] = [];
mock.module('@/lib/artifact-link-caller', () => ({ linkCaller: async () => caller }));
mock.module('@/lib/artifact-links', () => ({
  linkArtifact: async (...a: unknown[]) => { calls.push(['link', ...a]); return { ok: true, link: { id: 'l1' } }; },
  linksOfArtifact: async (...a: unknown[]) => { calls.push(['list', ...a]); return { ok: false, status: 404, error: 'Artifact not found' }; },
  unlinkArtifact: async (...a: unknown[]) => { calls.push(['unlink', ...a]); return { ok: true }; },
}));
const { GET, POST, DELETE } = await import('./route');

const ID = '11111111-1111-4111-8111-111111111111';
const params = Promise.resolve({ artifactId: ID });
const req = (method: string, body?: unknown, qs = '') => new NextRequest(`http://localhost/api/artifacts/${ID}/links${qs}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) });

describe('/api/artifacts/[artifactId]/links', () => {
  it('needs a caller', async () => {
    caller = null;
    expect((await GET(req('GET'), { params })).status).toBe(401);
    expect((await POST(req('POST', {}), { params })).status).toBe(401);
    caller = { kind: 'user', userId: 'u1' };
  });

  it('POST hands the body to linkArtifact and answers 201; a lib refusal keeps its status', async () => {
    const res = await POST(req('POST', { subjectKind: 'task', subjectId: ID, relation: 'context' }), { params });
    expect(res.status).toBe(201);
    expect(calls.at(-1)).toEqual(['link', caller, ID, { subjectKind: 'task', subjectId: ID, relation: 'context' }]);
    expect((await GET(req('GET'), { params })).status).toBe(404);
  });

  it('a non-UUID artifact is a 404 before any lookup, and DELETE takes linkId', async () => {
    const n = calls.length;
    expect((await GET(req('GET'), { params: Promise.resolve({ artifactId: 'nope' }) })).status).toBe(404);
    expect(calls.length).toBe(n);
    expect((await DELETE(req('DELETE', undefined, '?linkId=x'), { params })).status).toBe(200);
    expect(calls.at(-1)).toEqual(['unlink', caller, ID, 'x']);
  });
});
