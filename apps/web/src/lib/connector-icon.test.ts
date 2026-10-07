import { describe, it, expect } from 'bun:test';
import { resolveConnectorIcon, iconFromServerInfo, iconFromHtml } from './connector-icon';

type Route = (init?: RequestInit) => Response | Promise<Response>;
function fakeFetch(routes: Record<string, Route>) {
  const calls: string[] = [];
  const fn = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    const r = routes[`${init?.method ?? 'GET'} ${url}`];
    return r ? r(init) : new Response('nope', { status: 404 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const initResult = (serverInfo: unknown) =>
  JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo } });

describe('iconFromServerInfo', () => {
  it('prefers an https icon, resolving relative src against the server url', () => {
    expect(iconFromServerInfo({ icons: [{ src: '/i.png' }] }, 'https://mcp.x.dev/mcp')).toBe('https://mcp.x.dev/i.png');
  });
  it('ignores data:/javascript: and non-http icons', () => {
    expect(iconFromServerInfo({ icons: [{ src: 'javascript:alert(1)' }, { src: 'data:image/png;base64,AA' }] }, 'https://a.dev')).toBeNull();
  });
  it('returns null when no icons', () => {
    expect(iconFromServerInfo({ name: 'x' }, 'https://a.dev')).toBeNull();
    expect(iconFromServerInfo(null, 'https://a.dev')).toBeNull();
  });
});

describe('iconFromHtml', () => {
  it('reads apple-touch-icon over plain icon, resolving relative hrefs', () => {
    const html = `<head><link rel="icon" href="/fav.ico"><link href="/apple.png" rel="apple-touch-icon"></head>`;
    expect(iconFromHtml(html, 'https://x.dev/')).toBe('https://x.dev/apple.png');
  });
  it('reads rel="shortcut icon"', () => {
    expect(iconFromHtml(`<link rel='shortcut icon' href='https://cdn.x.dev/f.png'>`, 'https://x.dev/')).toBe('https://cdn.x.dev/f.png');
  });
  it('decodes HTML entities in href', () => {
    expect(iconFromHtml('<link rel="icon" href="/f.png?w=1&amp;h=1">', 'https://x.dev/')).toBe('https://x.dev/f.png?w=1&h=1');
  });
  it('returns null without icon links', () => {
    expect(iconFromHtml('<html></html>', 'https://x.dev/')).toBeNull();
  });
});

describe('resolveConnectorIcon', () => {
  it('uses the catalog icon for a catalog url without fetching', async () => {
    const { fn, calls } = fakeFetch({});
    const icon = await resolveConnectorIcon('https://mcp.vercel.com', { fetch: fn });
    expect(icon).toMatch(/^https:\/\//);
    expect(calls).toHaveLength(0);
  });

  it('reads serverInfo.icons from an MCP initialize response (JSON)', async () => {
    const { fn } = fakeFetch({
      'POST https://mcp.custom.dev/mcp': () => new Response(initResult({ name: 'c', icons: [{ src: 'https://custom.dev/logo.png' }] }), { headers: { 'content-type': 'application/json' } }),
    });
    expect(await resolveConnectorIcon('https://mcp.custom.dev/mcp', { fetch: fn })).toBe('https://custom.dev/logo.png');
  });

  it('reads serverInfo.icons from an SSE initialize response', async () => {
    const body = `event: message\ndata: ${initResult({ name: 'c', icons: [{ src: 'https://custom.dev/sse.png' }] })}\n\n`;
    const { fn } = fakeFetch({
      'POST https://mcp.custom.dev/mcp': () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
    });
    expect(await resolveConnectorIcon('https://mcp.custom.dev/mcp', { fetch: fn })).toBe('https://custom.dev/sse.png');
  });

  it('falls back to the site favicon of the apex domain when the server needs auth', async () => {
    const { fn } = fakeFetch({
      'POST https://mcp.custom.dev/mcp': () => new Response('unauthorized', { status: 401 }),
      'GET https://mcp.custom.dev/': () => new Response('<html></html>', { headers: { 'content-type': 'text/html' } }),
      'GET https://custom.dev/': () => new Response('<link rel="icon" href="/brand.svg">', { headers: { 'content-type': 'text/html' } }),
    });
    expect(await resolveConnectorIcon('https://mcp.custom.dev/mcp', { fetch: fn })).toBe('https://custom.dev/brand.svg');
  });

  it('falls back to /favicon.ico when it exists', async () => {
    const { fn } = fakeFetch({
      'GET https://mcp.custom.dev/favicon.ico': () => new Response('x', { headers: { 'content-type': 'image/x-icon' } }),
    });
    expect(await resolveConnectorIcon('https://mcp.custom.dev/mcp', { fetch: fn })).toBe('https://mcp.custom.dev/favicon.ico');
  });

  it('returns null (never throws) when everything fails', async () => {
    const fn = (async () => { throw new Error('network down'); }) as unknown as typeof fetch;
    expect(await resolveConnectorIcon('https://mcp.custom.dev/mcp', { fetch: fn })).toBeNull();
  });

  it('returns null for non-http urls', async () => {
    const { fn, calls } = fakeFetch({});
    expect(await resolveConnectorIcon('ttps://mcp.custom.dev/mcp', { fetch: fn })).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
