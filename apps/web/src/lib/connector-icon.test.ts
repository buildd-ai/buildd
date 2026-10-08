import { describe, it, expect } from 'bun:test';
import { resolveConnectorIcon, resolveConnectorIconData, inlineIcon, iconFromServerInfo, iconFromHtml, MAX_ICON_BYTES } from './connector-icon';

const pub = async () => ['93.184.216.34'];

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
  it('ignores javascript:, non-image data: and non-http icons', () => {
    expect(iconFromServerInfo({ icons: [{ src: 'javascript:alert(1)' }, { src: 'data:text/html;base64,AA' }, { src: 'ftp://a.dev/i.png' }] }, 'https://a.dev')).toBeNull();
  });
  it('accepts a data: image (spec allows base64 data URIs)', () => {
    expect(iconFromServerInfo({ icons: [{ src: 'data:image/png;base64,AA' }] }, 'https://a.dev')).toBe('data:image/png;base64,AA');
  });
  it('prefers a light/unthemed icon over a dark one', () => {
    const icons = [{ src: 'https://a.dev/dark.png', theme: 'dark' }, { src: 'https://a.dev/light.png', theme: 'light' }];
    expect(iconFromServerInfo({ icons }, 'https://a.dev')).toBe('https://a.dev/light.png');
  });
  it('prefers png/svg over ico, and a larger square size over a tiny one', () => {
    expect(iconFromServerInfo({ icons: [{ src: 'https://a.dev/f.ico', mimeType: 'image/x-icon' }, { src: 'https://a.dev/l.svg', mimeType: 'image/svg+xml' }] }, 'https://a.dev')).toBe('https://a.dev/l.svg');
    expect(iconFromServerInfo({ icons: [{ src: 'https://a.dev/16.png', sizes: ['16x16'] }, { src: 'https://a.dev/96.png', sizes: ['96x96'] }] }, 'https://a.dev')).toBe('https://a.dev/96.png');
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
    const icon = await resolveConnectorIcon('https://mcp.vercel.com', { fetch: fn, resolveHost: pub });
    expect(icon).toMatch(/^https:\/\//);
    expect(calls).toHaveLength(0);
  });

  it('reads serverInfo.icons from an MCP initialize response (JSON)', async () => {
    const { fn } = fakeFetch({
      'POST https://mcp.custom.dev/mcp': () => new Response(initResult({ name: 'c', icons: [{ src: 'https://custom.dev/logo.png' }] }), { headers: { 'content-type': 'application/json' } }),
    });
    expect(await resolveConnectorIcon('https://mcp.custom.dev/mcp', { fetch: fn, resolveHost: pub })).toBe('https://custom.dev/logo.png');
  });

  it('reads serverInfo.icons from an SSE initialize response', async () => {
    const body = `event: message\ndata: ${initResult({ name: 'c', icons: [{ src: 'https://custom.dev/sse.png' }] })}\n\n`;
    const { fn } = fakeFetch({
      'POST https://mcp.custom.dev/mcp': () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
    });
    expect(await resolveConnectorIcon('https://mcp.custom.dev/mcp', { fetch: fn, resolveHost: pub })).toBe('https://custom.dev/sse.png');
  });

  it('falls back to the site favicon of the apex domain when the server needs auth', async () => {
    const { fn } = fakeFetch({
      'POST https://mcp.custom.dev/mcp': () => new Response('unauthorized', { status: 401 }),
      'GET https://mcp.custom.dev/': () => new Response('<html></html>', { headers: { 'content-type': 'text/html' } }),
      'GET https://custom.dev/': () => new Response('<link rel="icon" href="/brand.svg">', { headers: { 'content-type': 'text/html' } }),
    });
    expect(await resolveConnectorIcon('https://mcp.custom.dev/mcp', { fetch: fn, resolveHost: pub })).toBe('https://custom.dev/brand.svg');
  });

  it('falls back to /favicon.ico when it exists', async () => {
    const { fn } = fakeFetch({
      'GET https://mcp.custom.dev/favicon.ico': () => new Response('x', { headers: { 'content-type': 'image/x-icon' } }),
    });
    expect(await resolveConnectorIcon('https://mcp.custom.dev/mcp', { fetch: fn, resolveHost: pub })).toBe('https://mcp.custom.dev/favicon.ico');
  });

  it('returns null (never throws) when everything fails', async () => {
    const fn = (async () => { throw new Error('network down'); }) as unknown as typeof fetch;
    expect(await resolveConnectorIcon('https://mcp.custom.dev/mcp', { fetch: fn, resolveHost: pub })).toBeNull();
  });

  it('returns null for non-http urls', async () => {
    const { fn, calls } = fakeFetch({});
    expect(await resolveConnectorIcon('ttps://mcp.custom.dev/mcp', { fetch: fn, resolveHost: pub })).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe('resolveConnectorIcon — websiteUrl and auth', () => {
  it('falls back to serverInfo.websiteUrl when the server lists no icons', async () => {
    const { fn } = fakeFetch({
      'POST https://mcp.custom.dev/mcp': () => new Response(initResult({ name: 'c', websiteUrl: 'https://brand.example' }), { headers: { 'content-type': 'application/json' } }),
      'GET https://brand.example/': () => new Response('<link rel="apple-touch-icon" href="/a.png">', { headers: { 'content-type': 'text/html' } }),
    });
    expect(await resolveConnectorIcon('https://mcp.custom.dev/mcp', { fetch: fn, resolveHost: pub })).toBe('https://brand.example/a.png');
  });

  it('sends the caller-supplied auth headers on initialize', async () => {
    let seen: string | null = null;
    const { fn } = fakeFetch({
      'POST https://mcp.custom.dev/mcp': (init) => {
        seen = new Headers(init?.headers).get('authorization');
        return new Response(initResult({ name: 'c', icons: [{ src: 'https://custom.dev/i.png' }] }), { headers: { 'content-type': 'application/json' } });
      },
    });
    await resolveConnectorIcon('https://mcp.custom.dev/mcp', { fetch: fn, resolveHost: pub, headers: { authorization: 'Bearer t' } });
    expect(seen).toBe('Bearer t');
  });

  it('never probes a host that resolves to a private address', async () => {
    const { fn, calls } = fakeFetch({});
    expect(await resolveConnectorIcon('https://mcp.custom.dev/mcp', { fetch: fn, resolveHost: async () => ['10.0.0.5'] })).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

describe('inlineIcon', () => {
  it('fetches an https image and returns a base64 data URL', async () => {
    const { fn } = fakeFetch({ 'GET https://a.dev/i.png': () => new Response(png, { headers: { 'content-type': 'image/png' } }) });
    expect(await inlineIcon('https://a.dev/i.png', { fetch: fn, resolveHost: pub })).toBe(`data:image/png;base64,${Buffer.from(png).toString('base64')}`);
  });

  it('refuses http, private hosts, non-image types and oversize bodies', async () => {
    const { fn } = fakeFetch({
      'GET https://a.dev/page': () => new Response('<html>', { headers: { 'content-type': 'text/html' } }),
      'GET https://a.dev/big.png': () => new Response(new Uint8Array(MAX_ICON_BYTES + 1), { headers: { 'content-type': 'image/png' } }),
    });
    expect(await inlineIcon('http://a.dev/i.png', { fetch: fn, resolveHost: pub })).toBeNull();
    expect(await inlineIcon('https://a.dev/i.png', { fetch: fn, resolveHost: async () => ['169.254.169.254'] })).toBeNull();
    expect(await inlineIcon('https://a.dev/page', { fetch: fn, resolveHost: pub })).toBeNull();
    expect(await inlineIcon('https://a.dev/big.png', { fetch: fn, resolveHost: pub })).toBeNull();
  });

  it('re-checks every redirect hop', async () => {
    const { fn, calls } = fakeFetch({
      'GET https://a.dev/i.png': () => new Response(null, { status: 302, headers: { location: 'https://internal.a.dev/i.png' } }),
      'GET https://internal.a.dev/i.png': () => new Response(png, { headers: { 'content-type': 'image/png' } }),
    });
    const resolveHost = async (h: string) => (h === 'internal.a.dev' ? ['127.0.0.1'] : ['93.184.216.34']);
    expect(await inlineIcon('https://a.dev/i.png', { fetch: fn, resolveHost })).toBeNull();
    expect(calls).toEqual(['GET https://a.dev/i.png']);
  });

  it('sniffs a generic content type and passes an image data: URI through', async () => {
    const { fn } = fakeFetch({ 'GET https://a.dev/favicon.ico': () => new Response(png, { headers: { 'content-type': 'application/octet-stream' } }) });
    expect(await inlineIcon('https://a.dev/favicon.ico', { fetch: fn, resolveHost: pub })).toMatch(/^data:image\/png;base64,/);
    expect(await inlineIcon('data:image/png;base64,iVBORw0KGgo=', { fetch: fn, resolveHost: pub })).toBe('data:image/png;base64,iVBORw0KGgo=');
    expect(await inlineIcon('data:text/html;base64,PGI+', { fetch: fn, resolveHost: pub })).toBeNull();
  });
});

describe('resolveConnectorIconData', () => {
  it('tries the preferred icon first, then the next candidate when one will not inline', async () => {
    const { fn } = fakeFetch({
      'GET https://old.dev/gone.png': () => new Response('x', { status: 404 }),
      'POST https://mcp.custom.dev/mcp': () => new Response(initResult({ name: 'c', icons: [{ src: 'https://custom.dev/huge.png' }] }), { headers: { 'content-type': 'application/json' } }),
      'GET https://custom.dev/huge.png': () => new Response(new Uint8Array(MAX_ICON_BYTES + 1), { headers: { 'content-type': 'image/png' } }),
      'GET https://mcp.custom.dev/favicon.ico': () => new Response(png, { headers: { 'content-type': 'image/x-icon' } }),
    });
    const icon = await resolveConnectorIconData('https://mcp.custom.dev/mcp', { fetch: fn, resolveHost: pub, preferred: 'https://old.dev/gone.png' });
    expect(icon).toMatch(/^data:image\/x-icon;base64,/);
  });

  it('returns null when nothing inlines', async () => {
    const { fn } = fakeFetch({});
    expect(await resolveConnectorIconData('https://mcp.custom.dev/mcp', { fetch: fn, resolveHost: pub })).toBeNull();
  });
});
