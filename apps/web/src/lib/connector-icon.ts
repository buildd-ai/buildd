import { catalogEntryForUrl } from './connector-catalog';

/**
 * Best-effort icon for a connector URL, resolved once at create time and stored
 * on `connectors.iconUrl`. Order:
 *   1. catalog entry for the URL (no network);
 *   2. `serverInfo.icons` from an unauthenticated MCP `initialize` (spec 2025-11-25)
 *      — only servers that allow anonymous initialize answer this;
 *   3. `<link rel=icon>` on the server's origin, then on its apex domain
 *      (mcp.example.com → example.com), since most MCP hosts serve no HTML;
 *   4. `/favicon.ico` on the same two origins.
 * Never throws: a connector without an icon renders a letter avatar.
 */

const TIMEOUT_MS = 3000;
const MAX_HTML_BYTES = 256 * 1024;

interface Opts { fetch?: typeof fetch }

function httpUrl(raw: string, base?: string): string | null {
  try {
    const u = new URL(raw, base);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

export function iconFromServerInfo(serverInfo: unknown, serverUrl: string): string | null {
  const icons = (serverInfo as { icons?: unknown } | null)?.icons;
  if (!Array.isArray(icons)) return null;
  for (const icon of icons) {
    const src = (icon as { src?: unknown } | null)?.src;
    if (typeof src !== 'string') continue;
    const url = httpUrl(src, serverUrl);
    if (url) return url;
  }
  return null;
}

const LINK_RE = /<link\b[^>]*>/gi;
const attr = (tag: string, name: string) =>
  tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))?.slice(1).find(v => v !== undefined) ?? null;

const decodeEntities = (s: string) =>
  s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

export function iconFromHtml(html: string, pageUrl: string): string | null {
  let best: { rank: number; href: string } | null = null;
  for (const tag of html.match(LINK_RE) ?? []) {
    const rel = attr(tag, 'rel')?.toLowerCase().split(/\s+/) ?? [];
    const href = attr(tag, 'href');
    if (!href) continue;
    const rank = rel.includes('apple-touch-icon') ? 2 : rel.includes('icon') ? 1 : 0;
    if (rank > (best?.rank ?? 0)) best = { rank, href };
  }
  return best ? httpUrl(decodeEntities(best.href), pageUrl) : null;
}

async function timedFetch(f: typeof fetch, url: string, init: RequestInit = {}): Promise<Response | null> {
  try {
    return await f(url, { ...init, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    return null;
  }
}

async function iconFromInitialize(f: typeof fetch, serverUrl: string): Promise<string | null> {
  const res = await timedFetch(f, serverUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'buildd-icon-probe', version: '1' } },
    }),
  });
  if (!res?.ok) return null;
  const text = (await res.text().catch(() => '')).slice(0, MAX_HTML_BYTES);
  // Streamable HTTP may answer as SSE: take the first `data:` line that parses.
  const payloads = text.trimStart().startsWith('{')
    ? [text]
    : text.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5));
  for (const p of payloads) {
    try {
      const icon = iconFromServerInfo(JSON.parse(p)?.result?.serverInfo, serverUrl);
      if (icon) return icon;
    } catch { /* not JSON — try next */ }
  }
  return null;
}

/** mcp.example.com → [https://mcp.example.com/, https://example.com/] */
function candidateOrigins(serverUrl: string): string[] {
  const u = new URL(serverUrl);
  const origins = [`${u.protocol}//${u.host}/`];
  const labels = u.hostname.split('.');
  if (labels.length > 2 && !/^\d+$/.test(labels[labels.length - 1])) {
    origins.push(`${u.protocol}//${labels.slice(-2).join('.')}/`);
  }
  return origins;
}

async function iconFromSite(f: typeof fetch, origin: string): Promise<string | null> {
  const page = await timedFetch(f, origin, { headers: { accept: 'text/html' } });
  if (page?.ok && (page.headers.get('content-type') ?? '').includes('text/html')) {
    const icon = iconFromHtml((await page.text().catch(() => '')).slice(0, MAX_HTML_BYTES), page.url || origin);
    if (icon) return icon;
  }
  return null;
}

async function faviconIco(f: typeof fetch, origin: string): Promise<string | null> {
  const url = new URL('/favicon.ico', origin).toString();
  const res = await timedFetch(f, url);
  return res?.ok && (res.headers.get('content-type') ?? '').startsWith('image/') ? url : null;
}

export async function resolveConnectorIcon(serverUrl: string, opts: Opts = {}): Promise<string | null> {
  const catalog = catalogEntryForUrl(serverUrl);
  if (catalog) return catalog.iconUrl;
  if (!httpUrl(serverUrl)) return null;
  const f = opts.fetch ?? fetch;
  try {
    const fromServer = await iconFromInitialize(f, serverUrl);
    if (fromServer) return fromServer;
    const origins = candidateOrigins(serverUrl);
    for (const o of origins) {
      const icon = await iconFromSite(f, o);
      if (icon) return icon;
    }
    for (const o of origins) {
      const icon = await faviconIco(f, o);
      if (icon) return icon;
    }
  } catch { /* best effort */ }
  return null;
}
