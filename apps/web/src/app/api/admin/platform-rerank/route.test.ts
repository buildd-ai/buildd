/**
 * /api/admin/platform-rerank: read and set the platform-key rerank switch.
 * Admin-only (platform admin key); every set is audited with actor and time.
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { NextRequest, NextResponse } from 'next/server';

let caller: { account: { id: string; level: string } } | { response: NextResponse } = {
  account: { id: 'acct-platform-admin', level: 'admin' },
};
mock.module('@/lib/platform-admin', () => ({
  authorizePlatformAdmin: async () => caller,
}));

let stored: boolean | null = null;
const writes: boolean[] = [];
mock.module('@buildd/core/platform-rerank-switch', () => ({
  PLATFORM_RERANK_KEY: 'platform_rerank_enabled',
  readPlatformRerankRow: async () => (stored === null ? null : { enabled: stored }),
  setPlatformRerankEnabled: async (enabled: boolean) => {
    const before = stored ?? false;
    writes.push(enabled);
    stored = enabled;
    return { before, after: enabled };
  },
}));

const audits: any[] = [];
mock.module('@/lib/admin/audit', () => ({
  recordPlatformAdminAudit: async (event: any) => { audits.push(event); },
}));

const route = await import('./route');

function req(method: 'GET' | 'PUT', body?: unknown): NextRequest {
  return new NextRequest('http://localhost/api/admin/platform-rerank', {
    method,
    headers: { 'content-type': 'application/json', authorization: 'Bearer bld_admin' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('/api/admin/platform-rerank', () => {
  beforeEach(() => {
    caller = { account: { id: 'acct-platform-admin', level: 'admin' } };
    stored = null;
    writes.length = 0;
    audits.length = 0;
  });

  it('GET reads off when no record exists (default off)', async () => {
    const res = await route.GET(req('GET'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false, defaultEnabled: false, stored: false });
  });

  it('GET reflects a stored on value', async () => {
    stored = true;
    const res = await route.GET(req('GET'));
    expect(await res.json()).toEqual({ enabled: true, defaultEnabled: false, stored: true });
  });

  it('PUT sets the switch and audits who changed it and when', async () => {
    const res = await route.PUT(req('PUT', { enabled: true }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: true, previous: false });
    expect(writes).toEqual([true]);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorAccountId: 'acct-platform-admin',
      action: 'platform_setting.update',
      targetType: 'platform_setting',
      targetId: 'rerank_on_platform_key',
      teamId: null,
      before: { enabled: false },
      after: { enabled: true },
    });
  });

  it('PUT can turn it back off', async () => {
    stored = true;
    const res = await route.PUT(req('PUT', { enabled: false }));
    expect(await res.json()).toEqual({ enabled: false, previous: true });
    expect(audits[0].after).toEqual({ enabled: false });
  });

  it('non-admin callers are refused on set and nothing is written', async () => {
    caller = { response: NextResponse.json({ error: 'Requires a platform admin API key' }, { status: 403 }) };
    const res = await route.PUT(req('PUT', { enabled: true }));
    expect(res.status).toBe(403);
    expect(writes).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });

  it('non-admin callers are refused on read', async () => {
    caller = { response: NextResponse.json({ error: 'Requires a platform admin API key' }, { status: 401 }) };
    const res = await route.GET(req('GET'));
    expect(res.status).toBe(401);
  });

  it('refuses a body that is not an explicit boolean; nothing is written', async () => {
    for (const body of [{}, { enabled: 'true' }, { enabled: 1 }, { on: true }, null]) {
      const res = await route.PUT(req('PUT', body));
      expect(res.status).toBe(400);
    }
    expect(writes).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });
});
