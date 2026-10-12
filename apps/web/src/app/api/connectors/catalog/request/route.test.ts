import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { NextRequest } from 'next/server';

let caller: any;
const pages: any[] = [];

mock.module('@/lib/connector-team-auth', () => ({ resolveConnectorTeam: async () => caller }));
mock.module('@/lib/connector-catalog-store', () => ({
  loadTeamCatalog: async () => [
    { slug: 'axiom', name: 'Axiom', policy: 'available' },
    { slug: 'neon', name: 'Neon', policy: 'blocked' },
    { slug: 'vercel', name: 'Vercel', policy: 'available', clientSupport: { status: 'needs_approved_client' } },
  ],
}));
mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: async () => ({ id: 'u1', name: 'Sam', email: 's@example.com' }) }));
mock.module('@/lib/notify', () => ({ notifyTeam: async (...args: any[]) => { pages.push(args); } }));
mock.module('@/lib/app-url', () => ({ appBaseUrl: () => 'https://app.example' }));

const { POST } = await import('./route');
const req = (body: unknown) => new NextRequest('http://localhost:3000/api/connectors/catalog/request', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

beforeEach(() => { caller = { teamId: 't1', canManage: false, accountId: null }; pages.length = 0; });

describe('POST /api/connectors/catalog/request', () => {
  it('pages the team once for a member asking for an offered app, and installs nothing', async () => {
    const res = await POST(req({ slug: 'axiom' }));
    expect(res.status).toBe(200);
    expect(pages).toHaveLength(1);
    expect(pages[0][0]).toBe('t1');
    expect(pages[0][2]).toMatchObject({ title: 'Axiom requested', message: "Sam asked for Axiom for the team's agents." });
  });

  it('refuses a blocked or unavailable app as not offered, without paging', async () => {
    expect((await POST(req({ slug: 'neon' }))).status).toBe(404);
    expect((await POST(req({ slug: 'vercel' }))).status).toBe(404);
    expect((await POST(req({ slug: 'nope' }))).status).toBe(404);
    expect(pages).toHaveLength(0);
  });

  it('an admin connects instead of asking', async () => {
    caller = { ...caller, canManage: true };
    expect((await POST(req({ slug: 'axiom' }))).status).toBe(400);
    expect(pages).toHaveLength(0);
  });

  it('an API key is not a person asking', async () => {
    caller = { ...caller, accountId: 'acct-1' };
    expect((await POST(req({ slug: 'axiom' }))).status).toBe(403);
  });
});
