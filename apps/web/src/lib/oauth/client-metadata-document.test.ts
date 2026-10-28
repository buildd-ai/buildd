/**
 * OAuth Client ID Metadata Documents (MCP authorization 2025-11-25, draft-ietf-
 * oauth-client-id-metadata-document): a client whose `client_id` is an HTTPS
 * URL is described by the JSON document at that URL. Claude's hosted apps and
 * Claude Code both identify themselves this way when the authorization server
 * advertises support, so no registration call is needed.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/web/src/lib/oauth/client-metadata-document.test.ts
 */
import { describe, it, expect } from 'bun:test';
import {
  fetchClientMetadataDocument,
  isClientIdMetadataUrl,
  isPublicAddress,
} from './client-metadata-document';

const CLAUDE = 'https://claude.ai/oauth/mcp-oauth-client-metadata';
const CLAUDE_CODE = 'https://claude.ai/oauth/claude-code-client-metadata';

const claudeDoc = {
  client_id: CLAUDE,
  client_name: 'Claude',
  client_uri: 'https://claude.ai',
  redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
};

const publicLookup = async () => [{ address: '203.0.113.10', family: 4 }];

function jsonFetch(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = async (url: string, reqInit?: RequestInit) => {
    calls.push({ url, init: reqInit });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
  };
  return Object.assign(fn, { calls });
}

describe('isClientIdMetadataUrl', () => {
  it('recognises the HTTPS client ids Claude and Claude Code send', () => {
    expect(isClientIdMetadataUrl(CLAUDE)).toBe(true);
    expect(isClientIdMetadataUrl(CLAUDE_CODE)).toBe(true);
  });

  it('leaves dynamically registered ids alone', () => {
    expect(isClientIdMetadataUrl('c_abc123')).toBe(false);
  });

  it('refuses URLs the draft forbids or that would reach a private host', () => {
    for (const id of [
      'http://claude.ai/oauth/x', // not https
      'https://claude.ai', // no path
      'https://claude.ai/', // no path
      'https://claude.ai/x#frag',
      'https://user:pw@claude.ai/x',
      'https://127.0.0.1/x',
      'https://10.0.0.5/x',
      'https://[::1]/x',
      'https://169.254.169.254/latest/meta-data',
      'https://localhost/x',
      'https://claude.ai:8443/x',
    ]) {
      expect(isClientIdMetadataUrl(id), id).toBe(false);
    }
  });
});

describe('isPublicAddress', () => {
  it('accepts globally routable addresses', () => {
    expect(isPublicAddress('203.0.113.10')).toBe(true);
    expect(isPublicAddress('2606:4700::1111')).toBe(true);
  });
  it('rejects loopback, private, link-local, CGNAT and mapped private addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:10.0.0.1']) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
  });
});

describe('fetchClientMetadataDocument', () => {
  it("reads Claude's document and returns its name and redirect URIs", async () => {
    const fetch = jsonFetch(claudeDoc);
    const result = await fetchClientMetadataDocument(CLAUDE, { fetch, lookup: publicLookup, now: () => 0, cache: new Map() });
    expect(result).toEqual({
      ok: true,
      client: { clientId: CLAUDE, clientName: 'Claude', redirectUris: ['https://claude.ai/api/mcp/auth_callback'] },
    });
    // Never follow a redirect to somewhere else.
    expect(fetch.calls[0].init?.redirect).toBe('manual');
  });

  it("accepts Claude Code's loopback redirect URIs", async () => {
    const doc = { ...claudeDoc, client_id: CLAUDE_CODE, client_name: 'Claude Code', redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'] };
    const result = await fetchClientMetadataDocument(CLAUDE_CODE, { fetch: jsonFetch(doc), lookup: publicLookup, now: () => 0, cache: new Map() });
    expect(result.ok).toBe(true);
  });

  it('refuses a document whose client_id is not its own URL', async () => {
    const result = await fetchClientMetadataDocument(CLAUDE, { fetch: jsonFetch({ ...claudeDoc, client_id: 'https://evil.example/x' }), lookup: publicLookup, now: () => 0, cache: new Map() });
    expect(result.ok).toBe(false);
  });

  it('refuses a host that resolves to a private address', async () => {
    const fetch = jsonFetch(claudeDoc);
    const result = await fetchClientMetadataDocument(CLAUDE, { fetch, lookup: async () => [{ address: '10.0.0.7', family: 4 }], now: () => 0, cache: new Map() });
    expect(result.ok).toBe(false);
    expect(fetch.calls).toHaveLength(0);
  });

  it('refuses unsafe redirect URIs, a confidential client, a redirect and a non-200', async () => {
    const cases: Array<ReturnType<typeof jsonFetch>> = [
      jsonFetch({ ...claudeDoc, redirect_uris: ['javascript:alert(1)'] }),
      jsonFetch({ ...claudeDoc, redirect_uris: [] }),
      jsonFetch({ ...claudeDoc, token_endpoint_auth_method: 'client_secret_basic' }),
      jsonFetch('', { status: 302, headers: { location: 'https://evil.example/doc' } }),
      jsonFetch(claudeDoc, { status: 404 }),
      jsonFetch('not json'),
    ];
    for (const fetch of cases) {
      const result = await fetchClientMetadataDocument(CLAUDE, { fetch, lookup: publicLookup, now: () => 0, cache: new Map() });
      expect(result.ok).toBe(false);
    }
  });

  it('refuses a reserved name on hosts that are not its own', async () => {
    const result = await fetchClientMetadataDocument('https://evil.example/client.json', {
      fetch: jsonFetch({ ...claudeDoc, client_id: 'https://evil.example/client.json', redirect_uris: ['https://evil.example/cb'] }),
      lookup: publicLookup,
      now: () => 0, cache: new Map(),
    });
    expect(result.ok).toBe(false);
  });

  it('refuses an oversized document', async () => {
    const big = { ...claudeDoc, padding: 'x'.repeat(20_000) };
    const result = await fetchClientMetadataDocument(CLAUDE, { fetch: jsonFetch(big), lookup: publicLookup, now: () => 0, cache: new Map() });
    expect(result.ok).toBe(false);
  });

  it('caches a good document for a few minutes, so the consent GET and POST fetch once', async () => {
    const fetch = jsonFetch(claudeDoc);
    const url = 'https://claude.ai/oauth/cache-probe';
    const doc = { ...claudeDoc, client_id: url };
    const f = jsonFetch(doc);
    const cache = new Map();
    let t = 1_000_000;
    await fetchClientMetadataDocument(url, { fetch: f, lookup: publicLookup, now: () => t, cache });
    t += 60_000;
    await fetchClientMetadataDocument(url, { fetch: f, lookup: publicLookup, now: () => t, cache });
    expect(f.calls).toHaveLength(1);
    t += 10 * 60_000;
    await fetchClientMetadataDocument(url, { fetch: f, lookup: publicLookup, now: () => t, cache });
    expect(f.calls).toHaveLength(2);
    expect(fetch.calls).toHaveLength(0);
  });
});
