import { describe, it, expect, mock } from 'bun:test';
import { NextRequest } from 'next/server';

let owner = true;
const executed: string[] = [];
mock.module('@/lib/platform-admin', () => ({
  authorizePlatformAdmin: async () => (owner ? { account: { id: 'acc' } } : { account: null }),
}));
mock.module('@buildd/core/db', () => ({
  db: { execute: async (q: any) => { executed.push(JSON.stringify(q?.queryChunks?.map((c: any) => c?.value ?? '') ?? q)); return { rows: [] }; } },
}));

const { GET } = await import('./route');
const req = (qs = '') => new NextRequest(`http://localhost/api/admin/embedding-usage${qs}`);

describe('GET /api/admin/embedding-usage', () => {
  it('404s a non-owner', async () => {
    owner = false;
    expect((await GET(req())).status).toBe(404);
    owner = true;
  });

  it('rejects an unknown window', async () => {
    expect((await GET(req('?window=1y'))).status).toBe(400);
  });

  it('returns the contract shape', async () => {
    const res = await GET(req('?window=30d'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ schemaVersion: 1, window: '30d', estimate: true, rows: [], truncated: false });
    expect(typeof body.since).toBe('string');
    expect(body.month.budgets.map((b: any) => b.kind)).toEqual(['embed', 'rerank']);
  });

  it('only ever reads: no write statement is issued and no write verb is exported', async () => {
    executed.length = 0;
    await GET(req());
    expect(executed.length).toBeGreaterThan(0);
    for (const s of executed) expect(s).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
    const mod = await import('./route');
    expect(Object.keys(mod).filter(k => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(k))).toEqual([]);
  });
});
