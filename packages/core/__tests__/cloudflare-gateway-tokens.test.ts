/**
 * Minted Cloudflare AI Gateway Run tokens: the Cloudflare calls (stubbed
 * fetch) and which token a call spends. Fixtures are illustrative.
 */
import { describe, expect, it } from 'bun:test';
import {
  GATEWAY_TOKEN_PERMISSIONS,
  gatewayTokenExpired,
  gatewayTokenRequest,
  mintGatewayRunToken,
  parseGatewayRunToken,
  pickGatewayRunToken,
  revokeGatewayRunToken,
  serializeGatewayRunToken,
  type GatewayRunToken,
} from '../cloudflare-gateway-tokens';

const ACCOUNT = '0123456789abcdef0123456789abcdef';
const CRED = { apiToken: 'team-cloudflare-token-abcdefghij', accountId: ACCOUNT };
const NOW = Date.parse('2026-10-09T12:00:00Z');
const GROUPS = { success: true, result: [{ id: 'grp-gw-run', name: 'AI Gateway Run' }, { id: 'grp-wai-read', name: 'Workers AI Read' }, { id: 'grp-x', name: 'Workers Scripts Edit' }] };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const minted = (o: Partial<GatewayRunToken> = {}): GatewayRunToken => ({
  token: 'minted-run-token-abcdefghijklmn', tokenId: 'tok0123456789', accountId: ACCOUNT, expiresOn: '2027-01-07T12:00:00Z', ...o,
});

describe('mintGatewayRunToken', () => {
  it('looks permission groups up by name and mints an account-owned token limited to them', async () => {
    const calls: Array<{ url: string; method: string; auth: string | null; body: any }> = [];
    const r = await mintGatewayRunToken(CRED, {
      name: 'buildd agents', now: NOW,
      fetcher: async (url, init) => {
        calls.push({ url, method: init?.method ?? 'GET', auth: new Headers(init?.headers).get('authorization'), body: init?.body ? JSON.parse(String(init.body)) : null });
        if (url.endsWith('/permission_groups')) return json(GROUPS);
        return json({ success: true, result: { id: 'tok0123456789', value: 'minted-run-token-abcdefghijklmn', expires_on: '2027-01-07T12:00:00Z' } });
      },
    });
    expect(r).toEqual({ ok: true, value: minted() });
    expect(calls.map(c => `${c.method} ${c.url}`)).toEqual([
      `GET https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/tokens/permission_groups`,
      `POST https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/tokens`,
    ]);
    expect(calls.every(c => c.auth === `Bearer ${CRED.apiToken}`)).toBe(true);
    expect(calls[1].body).toEqual(gatewayTokenRequest({ accountId: ACCOUNT, name: 'buildd agents', permissionGroupIds: ['grp-gw-run', 'grp-wai-read'], expiresOn: '2027-01-07T12:00:00Z' }));
    expect(calls[1].body.policies[0].resources).toEqual({ [`com.cloudflare.api.account.${ACCOUNT}`]: '*' });
  });

  it('says what permission the team token is missing when Cloudflare refuses', async () => {
    const r = await mintGatewayRunToken(CRED, { name: 'n', fetcher: async () => json({ success: false, errors: [{ message: 'Unauthorized' }] }, 403) });
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(!r.ok && r.error).toContain('Account API Tokens: Edit');
  });

  it('refuses when a needed permission group does not exist, before minting anything', async () => {
    let posts = 0;
    const r = await mintGatewayRunToken(CRED, {
      name: 'n',
      fetcher: async (url, init) => {
        if (init?.method === 'POST') posts++;
        return json({ success: true, result: [{ id: 'g', name: 'AI Gateway Run' }] });
      },
    });
    expect(!r.ok && r.error).toContain('Workers AI Read');
    expect(posts).toBe(0);
  });

  it('never throws on a network error, and never echoes the team token', async () => {
    const r = await mintGatewayRunToken(CRED, { name: 'n', fetcher: async () => { throw new Error('offline'); } });
    expect(r).toMatchObject({ ok: false, status: 502 });
    expect(JSON.stringify(r)).not.toContain(CRED.apiToken);
  });

  it('asks for the two run permissions only', () => {
    expect([...GATEWAY_TOKEN_PERMISSIONS]).toEqual(['AI Gateway Run', 'Workers AI Read']);
  });
});

describe('revokeGatewayRunToken', () => {
  it('deletes the token; a 404 counts as revoked', async () => {
    const seen: string[] = [];
    expect(await revokeGatewayRunToken(CRED, 'tok0123456789', { fetcher: async (url, init) => { seen.push(`${init?.method} ${url}`); return json({ success: true }); } })).toEqual({ ok: true });
    expect(seen).toEqual([`DELETE https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/tokens/tok0123456789`]);
    expect(await revokeGatewayRunToken(CRED, 'tok0123456789', { fetcher: async () => json({}, 404) })).toEqual({ ok: true });
    expect((await revokeGatewayRunToken(CRED, 'tok0123456789', { fetcher: async () => json({}, 500) })).ok).toBe(false);
    expect((await revokeGatewayRunToken(CRED, '../x', { fetcher: async () => json({}) })).ok).toBe(false);
  });
});

describe('stored value', () => {
  it('round-trips and rejects anything malformed', () => {
    expect(parseGatewayRunToken(serializeGatewayRunToken(minted()))).toEqual(minted());
    expect(parseGatewayRunToken(JSON.stringify({ ...minted(), accountId: 'nope' }))).toBeNull();
    expect(parseGatewayRunToken('not json')).toBeNull();
  });

  it('knows when it has expired', () => {
    expect(gatewayTokenExpired(minted(), NOW)).toBe(false);
    expect(gatewayTokenExpired(minted({ expiresOn: '2026-10-09T12:00:30Z' }), NOW)).toBe(true);
    expect(gatewayTokenExpired(minted({ expiresOn: null }), NOW)).toBe(false);
  });
});

describe('pickGatewayRunToken', () => {
  const mine = { userId: 'u-1', healthStatus: 'healthy', value: minted({ tokenId: 'tokmine000001' }) };
  const theirs = { userId: 'u-2', healthStatus: 'healthy', value: minted({ tokenId: 'toktheirs0001' }) };
  const team = { userId: null, healthStatus: 'healthy', value: minted({ tokenId: 'tokteam000001' }) };

  it("the person's own, else the team's; never another person's", () => {
    expect(pickGatewayRunToken([team, mine], { userId: 'u-1', accountId: ACCOUNT, now: NOW })).toEqual({ token: mine.value, scope: 'personal' });
    expect(pickGatewayRunToken([theirs, team], { userId: 'u-1', accountId: ACCOUNT, now: NOW })).toEqual({ token: team.value, scope: 'team' });
    expect(pickGatewayRunToken([theirs], { userId: 'u-1', accountId: ACCOUNT, now: NOW })).toBeNull();
    expect(pickGatewayRunToken([mine, team], { accountId: ACCOUNT, now: NOW })).toEqual({ token: team.value, scope: 'team' });
  });

  it('skips expired, revoked, and other-account tokens', () => {
    const expired = { ...mine, value: minted({ expiresOn: '2026-01-01T00:00:00Z' }) };
    const revoked = { ...mine, healthStatus: 'revoked' };
    const other = { ...mine, value: minted({ accountId: 'f'.repeat(32) }) };
    for (const bad of [expired, revoked, other]) {
      expect(pickGatewayRunToken([bad, team], { userId: 'u-1', accountId: ACCOUNT, now: NOW })?.scope).toBe('team');
    }
  });
});
