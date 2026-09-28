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

beforeEach(() => { stored.length = 0; });

describe('setTeamGateway', () => {
  it('checks the gateway, then stores URL and key as one team-wide encrypted blob', async () => {
    const r = await setTeamGateway({ teamId: 't', baseUrl: 'https://litellm.example.test/v1/', apiKey: ' "sk-lite-example" ' }, { fetcher: ok });
    expect(r).toMatchObject({ ok: true, gateway: { baseURL: 'https://litellm.example.test/v1', last4: 'mple', health: 'healthy' } });
    expect(JSON.parse(stored[0].value)).toEqual({ apiKey: 'sk-lite-example', baseUrl: 'https://litellm.example.test/v1' });
    expect(stored[0].meta).toEqual({ teamId: 't', purpose: 'inference_key', label: 'litellm', userId: null });
  });

  it('never stores a gateway that rejects the key, a non-https URL or a missing key', async () => {
    const rejected = await setTeamGateway({ teamId: 't', baseUrl: 'https://litellm.example.test/v1', apiKey: 'sk-bad-example' }, { fetcher: async () => new Response('', { status: 401 }) });
    expect(rejected).toMatchObject({ ok: false, status: 400 });
    expect((await setTeamGateway({ teamId: 't', baseUrl: 'http://litellm.example.test', apiKey: 'k' }, { fetcher: ok })).ok).toBe(false);
    expect((await setTeamGateway({ teamId: 't', baseUrl: 'https://litellm.example.test', apiKey: '' }, { fetcher: ok })).ok).toBe(false);
    expect(stored).toHaveLength(0);
  });
});
