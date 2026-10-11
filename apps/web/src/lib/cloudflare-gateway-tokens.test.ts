/**
 * Minted gateway tokens, DB half: one row per scope, the replaced token is
 * revoked at Cloudflare, a delete revokes first. Stubbed DB and fetch;
 * fixtures are illustrative.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';

const ACCOUNT = '0123456789abcdef0123456789abcdef';
const TEAM_TOKEN = 'team-cloudflare-token-abcdefghij';
let rows: any[] = [];
let cfRow: any = null;
const stored: Array<{ value: string; meta: any }> = [];
const deleted: string[] = [];

mock.module('@buildd/core/db', () => ({ db: { query: { secrets: { findMany: async () => rows } } } }));
mock.module('@buildd/core/secrets', () => ({
  decrypt: (s: string) => s,
  getSecretsProvider: () => ({
    replaceScoped: async (value: string, meta: any) => { stored.push({ value, meta }); return 'new-row'; },
    delete: async (id: string) => { deleted.push(id); },
  }),
}));
mock.module('./cloudflare-credential', () => ({
  findCloudflareSecret: async () => cfRow,
  decodeCloudflareValue: (v: string) => JSON.parse(v),
}));

const { createGatewayToken, deleteGatewayToken, listGatewayTokens } = await import('./cloudflare-gateway-tokens');

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const tokenRow = (id: string, userId: string | null, token: string, tokenId: string) => ({
  id, userId, updatedAt: new Date('2026-10-01'),
  encryptedValue: JSON.stringify({ token, tokenId, accountId: ACCOUNT, expiresOn: '2099-01-01T00:00:00Z' }),
});
function cloudflare(log: string[], opts: { revokeStatus?: number } = {}) {
  return async (url: string, init?: RequestInit) => {
    log.push(`${init?.method ?? 'GET'} ${url.replace(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}`, '')}`);
    if (url.endsWith('/permission_groups')) return json({ success: true, result: [{ id: 'g1', name: 'AI Gateway Run' }, { id: 'g2', name: 'Workers AI Read' }] });
    if (init?.method === 'DELETE') return json({ success: opts.revokeStatus === undefined }, opts.revokeStatus ?? 200);
    return json({ success: true, result: { id: 'toknew0000001', value: 'new-run-token-abcdefghijklmnop', expires_on: '2027-01-07T00:00:00Z' } });
  };
}

beforeEach(() => {
  rows = []; stored.length = 0; deleted.length = 0;
  cfRow = { id: 'cf', healthStatus: 'healthy', encryptedValue: JSON.stringify({ apiToken: TEAM_TOKEN, accountId: ACCOUNT, aiGatewayId: 'buildd' }) };
});

describe('createGatewayToken', () => {
  it("mints a personal token stored under the person, and revokes the one it replaces", async () => {
    rows = [tokenRow('old', 'u-1', 'old-run-token-abcdefghijklmnop', 'tokold0000001')];
    const log: string[] = [];
    const r = await createGatewayToken({ teamId: 't', userId: 'u-1', scope: 'personal', label: 'buildd: me' }, { fetcher: cloudflare(log) });
    expect(r).toMatchObject({ ok: true, token: { scope: 'personal', tokenHint: '…mnop', expiresOn: '2027-01-07T00:00:00Z' } });
    expect(JSON.stringify(r)).not.toContain('new-run-token');
    expect(stored[0].meta).toEqual({ teamId: 't', purpose: 'cloudflare_gateway_token', userId: 'u-1' });
    expect(JSON.parse(stored[0].value)).toMatchObject({ token: 'new-run-token-abcdefghijklmnop', tokenId: 'toknew0000001' });
    expect(log).toEqual(['GET /tokens/permission_groups', 'POST /tokens', 'DELETE /tokens/tokold0000001']);
  });

  it('a team token is stored with no person', async () => {
    await createGatewayToken({ teamId: 't', userId: 'u-1', scope: 'team', label: 'buildd: agents' }, { fetcher: cloudflare([]) });
    expect(stored[0].meta.userId).toBeNull();
  });

  it("never touches another person's token", async () => {
    rows = [tokenRow('theirs', 'u-2', 'their-run-token-abcdefghijklmno', 'toktheirs0001')];
    const log: string[] = [];
    await createGatewayToken({ teamId: 't', userId: 'u-1', scope: 'personal', label: 'x' }, { fetcher: cloudflare(log) });
    expect(log.some(l => l.startsWith('DELETE'))).toBe(false);
    expect((await listGatewayTokens('t', 'u-1')).personal).toBeNull();
  });

  it('needs a working team Cloudflare credential', async () => {
    cfRow = null;
    expect(await createGatewayToken({ teamId: 't', userId: 'u-1', scope: 'personal', label: 'x' }, { fetcher: cloudflare([]) })).toMatchObject({ ok: false, status: 400 });
    cfRow = { id: 'cf', healthStatus: 'revoked', encryptedValue: JSON.stringify({ apiToken: TEAM_TOKEN, accountId: ACCOUNT }) };
    expect(await createGatewayToken({ teamId: 't', userId: 'u-1', scope: 'personal', label: 'x' }, { fetcher: cloudflare([]) })).toMatchObject({ ok: false, status: 400 });
    expect(stored).toHaveLength(0);
  });
});

describe('deleteGatewayToken', () => {
  it('revokes at Cloudflare, then deletes the row', async () => {
    rows = [tokenRow('mine', 'u-1', 'my-run-token-abcdefghijklmnopq', 'tokmine000001')];
    const log: string[] = [];
    expect(await deleteGatewayToken({ teamId: 't', userId: 'u-1', scope: 'personal' }, { fetcher: cloudflare(log) })).toEqual({ ok: true, deleted: true });
    expect(log).toEqual(['DELETE /tokens/tokmine000001']);
    expect(deleted).toEqual(['mine']);
  });

  it('keeps the row when Cloudflare does not revoke it', async () => {
    rows = [tokenRow('mine', 'u-1', 'my-run-token-abcdefghijklmnopq', 'tokmine000001')];
    const r = await deleteGatewayToken({ teamId: 't', userId: 'u-1', scope: 'personal' }, { fetcher: cloudflare([], { revokeStatus: 500 }) });
    expect(r).toMatchObject({ ok: false, status: 502 });
    expect(deleted).toEqual([]);
  });
});

describe('listGatewayTokens', () => {
  it('masks both scopes', async () => {
    rows = [tokenRow('mine', 'u-1', 'my-run-token-abcdefghijklmnopq', 'tokmine000001'), tokenRow('team', null, 'team-run-token-abcdefghijklmnop', 'tokteam000001')];
    const r = await listGatewayTokens('t', 'u-1');
    expect(r.personal).toMatchObject({ scope: 'personal', tokenHint: '…nopq', expired: false });
    expect(r.team).toMatchObject({ scope: 'team', tokenHint: '…mnop' });
    expect(JSON.stringify(r)).not.toContain('run-token');
  });
});
