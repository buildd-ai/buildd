import { beforeEach, describe, expect, it, mock } from 'bun:test';

const stored: Array<{ value: string; meta: any }> = [];
mock.module('@buildd/core/db', () => ({
  db: { update: () => ({ set: () => ({ where: async () => [] }) }), delete: () => ({ where: () => ({ returning: async () => [] }) }), query: { secrets: { findFirst: async () => null } } },
}));
mock.module('@buildd/core/secrets', () => ({
  decrypt: (s: string) => s,
  getSecretsProvider: () => ({ replaceScoped: async (value: string, meta: any) => { stored.push({ value, meta }); return 's-1'; } }),
}));

const { setTeamGateway } = await import('./litellm-gateway-settings');
const ok = async () => new Response('{}', { status: 200 });
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const privateLookup = async () => [{ address: '169.254.169.254', family: 4 }];

beforeEach(() => { stored.length = 0; });

describe('setTeamGateway', () => {
  it('checks the gateway, then stores URL and key as one team-wide encrypted blob', async () => {
    const r = await setTeamGateway({ teamId: 't', baseUrl: 'https://litellm.example.test/v1/', apiKey: ' "sk-lite-example" ' }, { lookup: publicLookup, fetcher: ok });
    expect(r).toMatchObject({ ok: true, gateway: { baseURL: 'https://litellm.example.test/v1', last4: 'mple', health: 'healthy' } });
    expect(JSON.parse(stored[0].value)).toEqual({ apiKey: 'sk-lite-example', baseUrl: 'https://litellm.example.test/v1' });
    expect(stored[0].meta).toEqual({ teamId: 't', purpose: 'inference_key', label: 'litellm', userId: null });
  });

  it('never stores a gateway that rejects the key, a non-https URL or a missing key', async () => {
    const rejected = await setTeamGateway({ teamId: 't', baseUrl: 'https://litellm.example.test/v1', apiKey: 'sk-bad-example' }, { lookup: publicLookup, fetcher: async () => new Response('', { status: 401 }) });
    expect(rejected).toMatchObject({ ok: false, status: 400 });
    expect((await setTeamGateway({ teamId: 't', baseUrl: 'http://litellm.example.test', apiKey: 'k' }, { lookup: publicLookup, fetcher: ok })).ok).toBe(false);
    expect((await setTeamGateway({ teamId: 't', baseUrl: 'https://litellm.example.test', apiKey: '' }, { lookup: publicLookup, fetcher: ok })).ok).toBe(false);
    expect(stored).toHaveLength(0);
  });

  it('never stores a gateway whose host is not public or that redirects; no reply text is kept', async () => {
    let calls = 0;
    const blocked = await setTeamGateway({ teamId: 't', baseUrl: 'https://litellm.example.test/v1', apiKey: 'sk-lite-example' }, { lookup: privateLookup, fetcher: async () => { calls++; return new Response('{}'); } });
    expect(blocked).toMatchObject({ ok: false, status: 400 });
    expect(calls).toBe(0);
    const redirected = await setTeamGateway({ teamId: 't', baseUrl: 'https://litellm.example.test/v1', apiKey: 'sk-lite-example' }, {
      lookup: publicLookup, fetcher: async () => { calls++; return new Response(null, { status: 301, headers: { location: 'http://10.0.0.1/' } }); },
    });
    expect(redirected).toMatchObject({ ok: false, status: 400 });
    expect(calls).toBe(1);
    expect(stored).toHaveLength(0);
    const down = await setTeamGateway({ teamId: 't', baseUrl: 'https://litellm.example.test/v1', apiKey: 'sk-lite-example' }, { lookup: publicLookup, fetcher: async () => new Response('internal detail', { status: 502 }) });
    expect(down).toMatchObject({ ok: true, gateway: { health: 'unknown', lastVerificationError: 'gateway returned 502' } });
    expect(JSON.stringify(down)).not.toContain('internal detail');
  });
});
