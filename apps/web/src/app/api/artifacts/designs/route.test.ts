import { describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

let caller: unknown = { kind: 'user', userId: 'u1' };
const callerArgs: unknown[][] = [];
const calls: unknown[][] = [];
const scopedAccount = { id: 'acc-1', teamId: 't1', taskScope: { taskId: 'task-1', workspaceId: 'ws-1', expiresAt: 0 } };
mock.module('@/lib/task-token-auth', () => ({
  authenticateTaskScopedCaller: async (bearer: string | null) => (bearer === 'bldt_x' ? scopedAccount : null),
}));
mock.module('@/lib/artifact-link-caller', () => ({
  bearerOf: (r: NextRequest) => r.headers.get('authorization')?.replace('Bearer ', '') || null,
  linkCaller: async (...a: unknown[]) => { callerArgs.push(a); return caller; },
}));
let storeResult: Record<string, unknown> = { ok: true, design: { id: 'D', revision: 1, screens: [] }, attached: null };
mock.module('@/lib/designs/service', () => ({
  storeDesign: async (...a: unknown[]) => { calls.push(['store', ...a]); return storeResult; },
  listDesigns: async (...a: unknown[]) => { calls.push(['list', ...a]); return { ok: true, designs: [] }; },
  attachDesign: async (...a: unknown[]) => { calls.push(['attach', ...a]); return { ok: true, link: { id: 'l1' } }; },
  detachDesign: async (...a: unknown[]) => { calls.push(['detach', ...a]); return { ok: true }; },
}));
const { POST, GET } = await import('./route');
const attach = await import('./[designId]/attach/route');

const ID = '11111111-1111-4111-8111-111111111111';
const HTML = '<!doctype html><html><body><div data-screen="a" data-viewport="390x844"></div></body></html>';
const post = (body: BodyInit, type: string, qs = '', headers: Record<string, string> = {}) =>
  new NextRequest(`http://localhost/api/artifacts/designs${qs}`, { method: 'POST', body, headers: { 'content-type': type, ...headers } });
const json = (o: unknown, headers: Record<string, string> = {}) => post(JSON.stringify(o), 'application/json', '', headers);

describe('POST /api/artifacts/designs', () => {
  it('needs a caller', async () => {
    caller = null;
    expect((await POST(json({ html: HTML }))).status).toBe(401);
    caller = { kind: 'user', userId: 'u1' };
  });

  it('an owner session stores a design and attaches it in one call (201)', async () => {
    const res = await POST(json({ html: HTML, title: 'T', attachTo: { kind: 'mission', id: ID } }));
    expect(res.status).toBe(201);
    expect(calls.at(-1)).toMatchObject(['store', caller, { html: HTML, title: 'T', attachTo: { kind: 'mission', id: ID } }]);
  });

  it('a worker token (no claim, no worker id) is handed to the service with its workspace scope', async () => {
    callerArgs.length = 0;
    const res = await POST(json({ html: HTML, workspaceId: 'ws-1' }, { authorization: 'Bearer bldt_x' }));
    expect(res.status).toBe(201);
    expect(callerArgs[0]).toEqual([scopedAccount, scopedAccount.taskScope]);
  });

  it('takes the raw export as text/html with the target in the query', async () => {
    const res = await POST(post(HTML, 'text/html; charset=utf-8', `?attachKind=task&attachId=${ID}&title=Raw`));
    expect(res.status).toBe(201);
    expect(calls.at(-1)).toMatchObject(['store', caller, { html: HTML, title: 'Raw', declaredType: 'text/html', attachTo: { kind: 'task', id: ID } }]);
  });

  it('answers 200 for a new revision of an existing design', async () => {
    storeResult = { ok: true, design: { id: 'D', revision: 2, screens: [] }, attached: null };
    expect((await POST(json({ html: HTML, designId: ID }))).status).toBe(200);
    storeResult = { ok: true, design: { id: 'D', revision: 1, screens: [] }, attached: null };
  });

  it('refuses a body over the limit with 413 before reading it', async () => {
    const n = calls.length;
    const res = await POST(json({ html: HTML }, { 'content-length': String(50 * 1024 * 1024) }));
    expect(res.status).toBe(413);
    expect(calls.length).toBe(n);
  });

  it('refuses a content type that is not json or html with 415', async () => {
    const n = calls.length;
    expect((await POST(post('x', 'image/png'))).status).toBe(415);
    expect((await POST(post('x', 'application/zip'))).status).toBe(415);
    expect(calls.length).toBe(n);
  });

  it('refuses a malformed attachTo or pin with 400, naming the field', async () => {
    const bad = await POST(json({ html: HTML, attachTo: { kind: 'planet', id: ID } }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).field).toBe('attachTo');
    expect((await POST(json({ html: HTML, pin: 0 }))).status).toBe(400);
  });

  it('a service refusal keeps its status and field', async () => {
    storeResult = { ok: false, status: 415, error: 'Not an HTML document', field: 'html' };
    const res = await POST(json({ html: 'plain text' }));
    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({ error: 'Not an HTML document', field: 'html' });
    storeResult = { ok: true, design: { id: 'D', revision: 1, screens: [] }, attached: null };
  });
});

describe('GET /api/artifacts/designs', () => {
  const get = (qs: string) => new NextRequest(`http://localhost/api/artifacts/designs${qs}`);
  it('lists by mission, and needs exactly one scope', async () => {
    expect((await GET(get(`?missionId=${ID}`))).status).toBe(200);
    expect(calls.at(-1)).toMatchObject(['list', caller, { attachTo: { kind: 'mission', id: ID } }]);
    expect((await GET(get(''))).status).toBe(400);
    expect((await GET(get(`?missionId=${ID}&taskId=${ID}`))).status).toBe(400);
  });
  it('needs a caller', async () => {
    caller = null;
    expect((await GET(get(`?workspaceId=${ID}`))).status).toBe(401);
    caller = { kind: 'user', userId: 'u1' };
  });
});

describe('/api/artifacts/designs/[designId]/attach', () => {
  const params = Promise.resolve({ designId: ID });
  const req = (method: string, body?: unknown, qs = '') => new NextRequest(`http://localhost/api/artifacts/designs/${ID}/attach${qs}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
  it('attaches and detaches', async () => {
    expect((await attach.POST(req('POST', { kind: 'spec', id: ID, revision: 2 }), { params })).status).toBe(201);
    expect(calls.at(-1)).toEqual(['attach', caller, ID, { attachTo: { kind: 'spec', id: ID, revision: 2 } }]);
    expect((await attach.DELETE(req('DELETE', undefined, `?linkId=${ID}`), { params })).status).toBe(200);
    expect(calls.at(-1)).toEqual(['detach', caller, ID, ID]);
  });
  it('refuses a missing target, a bad id and no caller', async () => {
    expect((await attach.POST(req('POST', {}), { params })).status).toBe(400);
    expect((await attach.POST(req('POST', { kind: 'task', id: ID }), { params: Promise.resolve({ designId: 'nope' }) })).status).toBe(404);
    caller = null;
    expect((await attach.POST(req('POST', { kind: 'task', id: ID }), { params })).status).toBe(401);
    expect((await attach.DELETE(req('DELETE', undefined, `?linkId=${ID}`), { params })).status).toBe(401);
    caller = { kind: 'user', userId: 'u1' };
  });
});
