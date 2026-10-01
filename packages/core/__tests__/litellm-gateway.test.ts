import { describe, expect, it } from 'bun:test';
import { gatewayUrlProblem, parseGateway, serializeGateway, verifyGateway } from '../litellm-gateway';

describe('litellm gateway secret', () => {
  it('round-trips the stored JSON, trimming the base URL', () => {
    const stored = serializeGateway({ apiKey: 'sk-lite-123', baseURL: ' https://litellm.example.test/v1/ ' });
    expect(JSON.parse(stored)).toEqual({ apiKey: 'sk-lite-123', baseUrl: 'https://litellm.example.test/v1' });
    expect(parseGateway(stored)).toEqual({ apiKey: 'sk-lite-123', baseURL: 'https://litellm.example.test/v1' });
  });

  it('reads anything malformed as no gateway', () => {
    expect(parseGateway(null)).toBeNull();
    expect(parseGateway('sk-plain-key')).toBeNull();
    expect(parseGateway(JSON.stringify({ apiKey: '', baseUrl: 'https://x.example.test' }))).toBeNull();
    expect(parseGateway(JSON.stringify({ apiKey: 'k', baseUrl: 'http://x.example.test' }))).toBeNull();
  });

  it('wants https (http only on localhost) and no credentials in the URL', () => {
    expect(gatewayUrlProblem('https://litellm.example.test/v1')).toBeNull();
    expect(gatewayUrlProblem('http://localhost:4000')).toBeNull();
    expect(gatewayUrlProblem('http://litellm.example.test')).toMatch(/https/);
    expect(gatewayUrlProblem('https://u:p@litellm.example.test')).toMatch(/key field/);
    expect(gatewayUrlProblem('not a url')).toMatch(/not a URL/);
  });
});

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

describe('gatewayUrlProblem: what a gateway or endpoint URL may be', () => {
  it('refuses userinfo, a query or a fragment', () => {
    for (const u of ['https://u@litellm.example.test', 'https://:p@litellm.example.test', 'https://@litellm.example.test/v1']) {
      expect(gatewayUrlProblem(u)).toMatch(/key field/);
    }
    for (const u of ['https://litellm.example.test/v1?x=1', 'https://litellm.example.test/v1?', 'https://litellm.example.test/v1#f', 'https://litellm.example.test/#']) {
      expect(gatewayUrlProblem(u)).toMatch(/query or fragment/);
    }
  });

  it('refuses a non-public IP literal and *.localhost', () => {
    for (const u of ['https://10.0.0.1', 'https://169.254.169.254/latest', 'https://[fd00::1]', 'https://[::ffff:127.0.0.1]',
      'https://0xa.0.0.1', 'https://167772161', 'https://0xa9.254.169.254', 'https://foo.localhost', 'http://10.0.0.1']) {
      expect(gatewayUrlProblem(u)).not.toBeNull();
    }
    expect(gatewayUrlProblem('https://93.184.216.34/v1')).toBeNull();
  });

  it('the loopback hosts (http or https) only outside production', () => {
    for (const u of ['http://localhost:4000', 'http://127.0.0.1:4000/v1', 'http://[::1]:4000', 'https://localhost']) {
      expect(gatewayUrlProblem(u, { allowLocal: true })).toBeNull();
      expect(gatewayUrlProblem(u, { allowLocal: false })).toMatch(/public https/);
    }
    const env = process.env.NODE_ENV;
    try {
      (process.env as Record<string, string>).NODE_ENV = 'production';
      expect(gatewayUrlProblem('http://localhost:4000')).toMatch(/public https/);
      expect(gatewayUrlProblem('https://litellm.example.test/v1')).toBeNull();
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = env;
    }
  });

  it('a stored gateway with a query no longer parses', () => {
    expect(parseGateway(JSON.stringify({ apiKey: 'k', baseUrl: 'https://x.example.test/v1?a=b' }))).toBeNull();
  });
});

describe('verifyGateway', () => {
  const g = { apiKey: 'sk-lite-123', baseURL: 'https://litellm.example.test/v1' };
  it('checks GET /models with the bearer key', async () => {
    let seen: { url: string; auth: string | null } | null = null;
    const r = await verifyGateway(g, { lookup: publicLookup, fetcher: async (url, init) => { seen = { url, auth: new Headers(init?.headers).get('authorization') }; return new Response('{}'); } });
    expect(r).toEqual({ health: 'healthy', error: null });
    expect(seen!).toEqual({ url: 'https://litellm.example.test/v1/models', auth: 'Bearer sk-lite-123' });
  });
  it('401 is revoked, a 5xx or network error is unknown, and the key never appears in an error', async () => {
    expect(await verifyGateway(g, { lookup: publicLookup, fetcher: async () => new Response('nope', { status: 401 }) }))
      .toEqual({ health: 'revoked', error: 'gateway rejected the key (401)' });
    expect(await verifyGateway(g, { lookup: publicLookup, fetcher: async () => new Response('<html>internal</html>', { status: 502 }) }))
      .toEqual({ health: 'unknown', error: 'gateway returned 502' });
    const net = await verifyGateway(g, { lookup: publicLookup, fetcher: async () => { throw new Error('connect failed for sk-lite-123'); } });
    expect(net).toEqual({ health: 'unknown', error: 'could not reach the gateway' });
  });

  it('never reaches a non-public address and never follows a redirect', async () => {
    let calls = 0;
    const fetcher = async (_u: string, init?: RequestInit) => {
      calls++;
      expect(init?.redirect).toBe('manual');
      return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } });
    };
    expect(await verifyGateway(g, { lookup: async () => [{ address: '169.254.169.254', family: 4 }], fetcher }))
      .toEqual({ health: 'unknown', error: 'the gateway host is not a public address', blocked: true });
    expect(calls).toBe(0);
    expect(await verifyGateway(g, { lookup: publicLookup, fetcher }))
      .toEqual({ health: 'unknown', error: 'gateway answered with a redirect (302), which is not followed', blocked: true });
    expect(calls).toBe(1);
  });
});
