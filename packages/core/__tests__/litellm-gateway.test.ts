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

describe('verifyGateway', () => {
  const g = { apiKey: 'sk-lite-123', baseURL: 'https://litellm.example.test/v1' };
  it('checks GET /models with the bearer key', async () => {
    let seen: { url: string; auth: string | null } | null = null;
    const r = await verifyGateway(g, { fetcher: async (url, init) => { seen = { url, auth: new Headers(init?.headers).get('authorization') }; return new Response('{}'); } });
    expect(r).toEqual({ health: 'healthy', error: null });
    expect(seen!).toEqual({ url: 'https://litellm.example.test/v1/models', auth: 'Bearer sk-lite-123' });
  });
  it('401 is revoked, a 5xx or network error is unknown, and the key never appears in an error', async () => {
    expect((await verifyGateway(g, { fetcher: async () => new Response('', { status: 401 }) })).health).toBe('revoked');
    expect((await verifyGateway(g, { fetcher: async () => new Response('', { status: 502 }) })).health).toBe('unknown');
    const net = await verifyGateway(g, { fetcher: async () => { throw new Error('connect failed for sk-lite-123'); } });
    expect(net.health).toBe('unknown');
    expect(net.error).not.toContain('sk-lite-123');
  });
});
